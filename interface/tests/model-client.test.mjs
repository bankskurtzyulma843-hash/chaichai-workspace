import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as browserClient from "../public/model-client.js";
import * as localClient from "../lib/model.mjs";

const { completion, normalizeConfig, MAX_RESPONSE_BYTES } = browserClient;
const config = normalizeConfig({
  baseUrl: "https://fixture.invalid/v1",
  model: "fixture",
});
const encoder = new TextEncoder();

function responseFor(
  textOrBytes,
  { type = "application/json", open = false } = {},
) {
  const bytes =
    typeof textOrBytes === "string" ? encoder.encode(textOrBytes) : textOrBytes;
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        if (!open) controller.close();
      },
      cancel() {
        cancelled += 1;
      },
    }),
    { headers: { "content-type": type } },
  );
  return { response, cancelled: () => cancelled };
}

const jsonReply = (text = "你好") =>
  JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
  });

const ssePart = (delta, finishReason = null) =>
  `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason }],
  })}\r\n\r\n`;

test("local exports reuse the browser protocol and preserve key masking and limits", () => {
  for (const [local, browser] of [
    [localClient.AppError, browserClient.AppError],
    [localClient.publicError, browserClient.publicError],
    [localClient.normalizeConfig, browserClient.normalizeConfig],
    [localClient.configView, browserClient.configView],
    [localClient.completion, browserClient.completion],
    [localClient.testConnection, browserClient.testConnection],
  ]) {
    assert.equal(local, browser);
  }
  assert.equal(MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
  assert.equal(browserClient.REQUEST_TIMEOUT_MS, 180_000);
  const error = new localClient.AppError(
    "拒绝 fixture-secret",
    "MODEL_API_ERROR",
    502,
  );
  assert.deepEqual(browserClient.publicError(error, "fixture-secret"), {
    message: "拒绝 [已隐藏]",
    code: "MODEL_API_ERROR",
  });
});

test("plain browser completion omits tools, preserves explicit tools, and decodes split UTF-8 JSON", async () => {
  const tools = [
    {
      type: "function",
      function: { name: "fixture", parameters: { type: "object" } },
    },
  ];
  const bodies = [];
  const bytes = encoder.encode(jsonReply());
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const result = await completion(config, [{ role: "user", content: "你好" }], {
    fetchImpl,
  });
  assert.equal(result.content, "你好");
  assert.deepEqual(result.tool_calls, []);
  assert.equal(Object.hasOwn(bodies[0], "tools"), false);
  await completion(config, [], { tools, fetchImpl });
  assert.deepEqual(bodies[1].tools, tools);
});

test("fragmented browser SSE preserves tokens and tool arguments then cancels at DONE", async () => {
  const source =
    ssePart({ content: "中文片段" }) +
    ssePart({
      tool_calls: [
        {
          index: 0,
          id: "call-1",
          function: { name: "fixture", arguments: '{"path":' },
        },
      ],
    }) +
    ssePart(
      { tool_calls: [{ index: 0, function: { arguments: '"资料"}' } }] },
      "tool_calls",
    ) +
    "data: [DONE]\r\n\r\ndata: malformed trailing data\r\n\r\n";
  const bytes = encoder.encode(source);
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7));
      },
      cancel() {
        cancelled += 1;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const tokens = [];
  const result = await completion(config, [], {
    fetchImpl: async () => response,
    emit: (kind, data) => {
      if (kind === "token") tokens.push(data.text);
    },
  });
  assert.equal(result.content, "中文片段");
  assert.deepEqual(tokens, ["中文片段"]);
  assert.equal(result.tool_calls[0].function.arguments, '{"path":"资料"}');
  assert.equal(cancelled, 1);
  assert.equal(response.body.locked, false);
});

test("DONE cannot replace an actual finish_reason", async () => {
  const fixture = responseFor(
    ssePart({ content: "尚未完成" }) + "data: [DONE]\n\n",
    {
      type: "text/event-stream",
      open: true,
    },
  );
  await assert.rejects(
    completion(config, [], { fetchImpl: async () => fixture.response }),
    (error) => error.code === "MODEL_STREAM_INTERRUPTED",
  );
  assert.equal(fixture.cancelled(), 1);
  assert.equal(fixture.response.body.locked, false);
});

test("malformed JSON completion data remains a protocol error instead of a CORS error", async () => {
  for (const payload of [
    null,
    {
      choices: [
        {
          message: { content: "无效工具数据", tool_calls: {} },
          finish_reason: "stop",
        },
      ],
    },
  ]) {
    const fixture = responseFor(JSON.stringify(payload));
    await assert.rejects(
      completion(config, [], {
        browserMode: true,
        fetchImpl: async () => fixture.response,
      }),
      (error) =>
        error.code === "MODEL_PROTOCOL_ERROR" &&
        !error.message.includes("CORS"),
    );
    assert.equal(fixture.response.body.locked, false);
  }
});

test("JSON and SSE enforce the byte limit and cancel unread response bodies", async () => {
  const oversized = new Uint8Array(MAX_RESPONSE_BYTES + 1);
  for (const type of ["application/json", "text/event-stream"]) {
    const fixture = responseFor(oversized, { type, open: true });
    await assert.rejects(
      completion(config, [], { fetchImpl: async () => fixture.response }),
      (error) => error.code === "RESPONSE_TOO_LARGE",
    );
    assert.equal(fixture.cancelled(), 1);
    assert.equal(fixture.response.body.locked, false);
  }
});

test("response-body timeout cancels a pending read and releases its lock", async () => {
  const timeout = new AbortController();
  const timeoutMock = mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 180_000);
    return timeout.signal;
  });
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled += 1;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  try {
    const pending = completion(config, [], { fetchImpl: async () => response });
    setImmediate(() =>
      timeout.abort(new DOMException("Timed out", "TimeoutError")),
    );
    await assert.rejects(pending, (error) => error.code === "MODEL_TIMEOUT");
    assert.equal(cancelled, 1);
    assert.equal(response.body.locked, false);
  } finally {
    timeoutMock.mock.restore();
  }
});

test("network hints distinguish browser CORS from local proxy failures", async () => {
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    completion(config, [], { browserMode: true, fetchImpl }),
    (error) =>
      error.code === "MODEL_CONNECTION_FAILED" &&
      error.message.includes("CORS"),
  );
  await assert.rejects(
    completion(config, [], { fetchImpl }),
    (error) =>
      error.code === "MODEL_CONNECTION_FAILED" &&
      error.message.includes("本地服务的代理") &&
      !error.message.includes("CORS"),
  );
});
