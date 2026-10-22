import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { createAppServer } from "../server.mjs";

const API_KEY = "fixture-key-never-return-to-browser";
const MODEL = "fixture-model";
const toolDefinitions = [
  {
    name: "readonly_echo",
    description: "Read the selected fixture inventory.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_note",
    description: "Save a note in the selected fixture.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const toolCall = (id, name, arguments_) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(arguments_) },
});

function writeModelStream(response, reply) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, extra = {}) => {
    response.write(
      `data: ${JSON.stringify({
        id: "fixture-completion",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: null }],
        ...extra,
      })}\n\n`,
    );
  };
  if (reply.toolCalls) {
    // Deliberately split function arguments across SSE records. This tests the
    // actual OpenAI streaming boundary rather than handing the agent a parsed call.
    for (const [index, call] of reply.toolCalls.entries()) {
      const middle = Math.max(
        1,
        Math.floor(call.function.arguments.length / 2),
      );
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: call.type,
            function: {
              name: call.function.name,
              arguments: call.function.arguments.slice(0, middle),
            },
          },
        ],
      });
      chunk({
        tool_calls: [
          {
            index,
            function: { arguments: call.function.arguments.slice(middle) },
          },
        ],
      });
    }
  }
  if (reply.text) chunk({ content: reply.text });
  if (reply.hold) return;
  if (reply.interrupted) {
    response.end();
    return;
  }
  response.write(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: reply.toolCalls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

async function harness(t, replyForRequest) {
  const modelRequests = [];
  const modelFailures = [];
  const closedResponses = [];
  const serveModelRequest = (request, response) => {
    void (async () => {
      const body = await jsonBody(request);
      const recorded = {
        host: request.headers.host,
        path: request.url,
        authorization: request.headers.authorization,
        body,
      };
      modelRequests.push(recorded);
      response.on("close", () => closedResponses.push(recorded));
      const reply = await replyForRequest(recorded, modelRequests.length - 1);
      if (reply.status) {
        response.writeHead(reply.status, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: { message: reply.error } }));
      } else if (body.stream) {
        writeModelStream(response, reply);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "fixture-test-completion",
            model: MODEL,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: reply.text ?? "连接成功",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
      }
    })().catch((error) => {
      modelFailures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end("fixture failed");
    });
  };
  const modelServer = createServer(serveModelRequest);
  const modelOrigin = await listen(modelServer);
  t.after(() => closeServer(modelServer));
  const mcp = {
    calls: [],
    reads: [],
    closed: false,
    async listTools() {
      return toolDefinitions;
    },
    async callTool(name, arguments_, { signal } = {}) {
      assert.ok(
        !signal?.aborted,
        "MCP was called with an already aborted signal",
      );
      this.calls.push({ name, arguments_ });
      return {
        content: [{ type: "text", text: `${name}:mcp-evidence-sentinel` }],
        isError: false,
      };
    },
    async readResource(uri) {
      this.reads.push(uri);
      return {
        contents: [{ uri, mimeType: "text/plain", text: "resource-sentinel" }],
      };
    },
    async close() {
      this.closed = true;
    },
  };
  const app = createAppServer({
    mcpFactory: async () => mcp,
    fetchImpl: fetch,
  });
  const appOrigin = await listen(app.server);
  t.after(async () => {
    await app.close();
    assert.deepEqual(
      modelFailures,
      [],
      "the local model fixture must remain valid",
    );
  });
  let cookie;
  async function request(path, options = {}) {
    const { body, ...rest } = options;
    const headers = {
      origin: appOrigin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...rest.headers,
    };
    const response = await fetch(`${appOrigin}${path}`, {
      ...rest,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: rest.signal ?? AbortSignal.timeout(8_000),
    });
    for (const setCookie of response.headers.getSetCookie()) {
      cookie = setCookie.split(";", 1)[0];
    }
    return response;
  }
  async function requestJson(path, options) {
    const response = await request(path, options);
    const text = await response.text();
    assert.ok(
      !text.includes(API_KEY),
      "HTTP responses must not expose the API key",
    );
    return { response, data: JSON.parse(text) };
  }
  async function configure() {
    const result = await requestJson("/api/config", {
      method: "POST",
      body: { baseUrl: `${modelOrigin}/v1`, model: MODEL, apiKey: API_KEY },
    });
    assert.equal(result.response.status, 200);
    return result;
  }
  return {
    appOrigin,
    modelOrigin,
    modelRequests,
    closedResponses,
    mcp,
    request,
    requestJson,
    configure,
    async startSecondModel() {
      const secondServer = createServer(serveModelRequest);
      t.after(() => closeServer(secondServer));
      return listen(secondServer);
    },
  };
}

async function readEvents(response, onEvent = async () => {}) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  const decoder = new TextDecoder();
  let pending = "";
  async function consume() {
    let separator;
    while ((separator = pending.indexOf("\n\n")) !== -1) {
      const record = pending.slice(0, separator);
      pending = pending.slice(separator + 2);
      const lines = record.split("\n");
      const name = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!name || !data) continue;
      const event = { name, data: JSON.parse(data) };
      events.push(event);
      assert.ok(!data.includes(API_KEY), "SSE must not expose the API key");
      await onEvent(event);
    }
  }
  for await (const bytes of response.body) {
    pending += decoder.decode(bytes, { stream: true }).replaceAll("\r\n", "\n");
    await consume();
  }
  pending += decoder.decode();
  await consume();
  return events;
}

const chatBody = (conversationId, message = "检查 fixture 并给出证据") => ({
  conversationId,
  message,
  history: [
    { role: "user", content: "先看选中的文件。" },
    { role: "assistant", content: "会保留证据位置。" },
  ],
});

const tokenText = (events) =>
  events
    .filter(({ name }) => name === "token")
    .map(({ data }) => data.text)
    .join("");

test(
  "HTTP configuration is session scoped, hides the key, and rejects foreign origins",
  { timeout: 15_000 },
  async (t) => {
    const h = await harness(t, () => ({ text: "连接正常" }));
    const initial = await h.requestJson("/api/state");
    assert.equal(initial.data.config.hasApiKey, false);
    const setCookie = initial.response.headers.getSetCookie().join(";");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=(?:Lax|Strict)/i);

    await h.configure();
    const state = await h.requestJson("/api/state");
    assert.equal(state.data.config.baseUrl, `${h.modelOrigin}/v1`);
    assert.equal(state.data.config.model, MODEL);
    assert.equal(state.data.config.hasApiKey, true);
    assert.equal(state.data.mcp.toolCount, toolDefinitions.length);

    const outsider = await fetch(`${h.appOrigin}/api/state`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal((await outsider.json()).config.hasApiKey, false);

    const forbidden = await h.request("/api/config", {
      method: "POST",
      headers: { origin: "https://foreign.example" },
      body: { baseUrl: `${h.modelOrigin}/v1`, model: "hijacked-model" },
    });
    assert.equal(forbidden.status, 403);
    await forbidden.arrayBuffer();
    assert.equal((await h.requestJson("/api/state")).data.config.model, MODEL);

    const removed = await h.requestJson("/api/config", { method: "DELETE" });
    assert.equal(removed.response.status, 200);
    assert.equal(
      (await h.requestJson("/api/state")).data.config.hasApiKey,
      false,
    );
    assert.equal(h.modelRequests.length, 0);
  },
);

test(
  "changing the API base URL never forwards the old service key to the new endpoint",
  { timeout: 15_000 },
  async (t) => {
    const h = await harness(t, () => ({ text: "连接正常" }));
    await h.configure();
    const unchanged = await h.requestJson("/api/config", {
      method: "POST",
      body: { baseUrl: `${h.modelOrigin}/v1`, model: MODEL, apiKey: "" },
    });
    assert.equal(unchanged.response.status, 200);
    assert.equal(
      (await h.requestJson("/api/state")).data.config.hasApiKey,
      true,
    );
    const originalTest = await h.requestJson("/api/test", {
      method: "POST",
      body: { baseUrl: `${h.modelOrigin}/v1`, model: MODEL, apiKey: "" },
    });
    assert.equal(originalTest.response.status, 200);
    assert.equal(h.modelRequests[0].authorization, `Bearer ${API_KEY}`);

    const secondOrigin = await h.startSecondModel();
    assert.notEqual(secondOrigin, h.modelOrigin);
    const changed = await h.requestJson("/api/config", {
      method: "POST",
      body: { baseUrl: `${secondOrigin}/v1`, model: MODEL, apiKey: "" },
    });
    assert.equal(changed.response.status, 200);
    assert.equal(
      (await h.requestJson("/api/state")).data.config.hasApiKey,
      false,
    );
    const changedTest = await h.requestJson("/api/test", {
      method: "POST",
      body: { baseUrl: `${secondOrigin}/v1`, model: MODEL, apiKey: "" },
    });
    assert.equal(changedTest.response.status, 200);
    const events = await readEvents(
      await h.request("/api/chat", {
        method: "POST",
        body: chatBody("changed-endpoint"),
      }),
    );
    assert.ok(events.some(({ name }) => name === "done"));
    assert.equal(h.modelRequests.length, 3);
    for (const request of h.modelRequests.slice(1)) {
      assert.equal(request.host, new URL(secondOrigin).host);
      assert.equal(request.path, "/v1/chat/completions");
      assert.equal(
        request.authorization,
        undefined,
        "the old API key must stay bound to the original service",
      );
    }
  },
);

test(
  "connection test and streamed tool loop use the local OpenAI endpoint and MCP evidence",
  { timeout: 15_000 },
  async (t) => {
    let turn = 0;
    const h = await harness(t, ({ body }) => {
      if (!body.stream) return { text: "连接正常" };
      switch (turn++) {
        case 0:
          return {
            toolCalls: [
              toolCall("find-1", "find_tools", {
                query: "inventory",
                limit: 2,
              }),
            ],
          };
        case 1:
          return {
            toolCalls: [
              toolCall("read-1", "call_tool", {
                name: "readonly_echo",
                arguments: JSON.stringify({ query: "units" }),
              }),
            ],
          };
        case 2:
          return {
            toolCalls: [
              toolCall("resource-1", "read_resource", {
                uri: "fixture://evidence",
              }),
            ],
          };
        default:
          return { text: "已从 MCP 读取证据，分析完成。" };
      }
    });
    await h.configure();
    const tested = await h.requestJson("/api/test", {
      method: "POST",
      body: { baseUrl: `${h.modelOrigin}/v1`, model: MODEL },
    });
    assert.equal(tested.response.status, 200);
    const response = await h.request("/api/chat", {
      method: "POST",
      body: chatBody("tool-chain"),
    });
    const events = await readEvents(response);
    assert.equal(tokenText(events), "已从 MCP 读取证据，分析完成。");
    assert.ok(events.some(({ name }) => name === "done"));
    assert.ok(events.some(({ name }) => name === "usage"));
    assert.ok(
      !events.some(
        ({ name }) => name === "approval_required" || name === "error",
      ),
    );
    assert.deepEqual(h.mcp.calls, [
      { name: "readonly_echo", arguments_: { query: "units" } },
    ]);
    assert.deepEqual(h.mcp.reads, ["fixture://evidence"]);
    assert.equal(h.modelRequests.length, 5);
    for (const request of h.modelRequests) {
      assert.equal(request.path, "/v1/chat/completions");
      assert.equal(request.authorization, `Bearer ${API_KEY}`);
      assert.equal(request.body.model, MODEL);
    }
    const firstChat = h.modelRequests[1].body;
    assert.ok(
      firstChat.messages.some(({ content }) => content === "先看选中的文件。"),
    );
    assert.ok(
      firstChat.messages.some(
        ({ content }) => content === "检查 fixture 并给出证据",
      ),
    );
    assert.deepEqual(
      firstChat.tools.map(({ function: definition }) => definition.name).sort(),
      ["call_tool", "find_tools", "read_resource"],
    );
    const finalMessages = h.modelRequests.at(-1).body.messages;
    assert.ok(
      finalMessages.some(
        ({ role, content }) =>
          role === "tool" && content.includes("mcp-evidence-sentinel"),
      ),
    );
    assert.ok(
      finalMessages.some(
        ({ role, content }) =>
          role === "tool" && content.includes("resource-sentinel"),
      ),
    );
  },
);

for (const approved of [false, true]) {
  test(
    `write tool ${approved ? "executes once after approval" : "is never executed when approval is denied"}`,
    { timeout: 15_000 },
    async (t) => {
      let turn = 0;
      const h = await harness(t, () => {
        if (turn++ === 0) {
          return {
            toolCalls: [
              toolCall("write-1", "call_tool", {
                name: "write_note",
                arguments: JSON.stringify({ text: "save evidence" }),
              }),
            ],
          };
        }
        return { text: approved ? "写入完成。" : "已拒绝写入。" };
      });
      await h.configure();
      const conversationId = `write-${approved}`;
      const response = await h.request("/api/chat", {
        method: "POST",
        body: chatBody(conversationId),
      });
      let approvals = 0;
      const events = await readEvents(response, async (event) => {
        if (event.name !== "approval_required") return;
        approvals += 1;
        assert.equal(
          h.mcp.calls.length,
          0,
          "a write must not run before approval",
        );
        assert.equal(event.data.name, "write_note");
        const approval = await h.requestJson("/api/approval", {
          method: "POST",
          body: { conversationId, id: event.data.id, approved },
        });
        assert.equal(approval.response.status, 200);
      });
      assert.equal(approvals, 1);
      assert.equal(h.mcp.calls.length, approved ? 1 : 0);
      if (approved)
        assert.deepEqual(h.mcp.calls[0], {
          name: "write_note",
          arguments_: { text: "save evidence" },
        });
      assert.ok(events.some(({ name }) => name === "done"));
      assert.equal(tokenText(events), approved ? "写入完成。" : "已拒绝写入。");
      assert.equal(
        h.modelRequests.length,
        2,
        "the tool result must be returned to the model",
      );
      const toolMessage = h.modelRequests[1].body.messages.find(
        ({ role }) => role === "tool",
      );
      assert.ok(toolMessage, "the model must receive the approval outcome");
      if (!approved)
        assert.match(toolMessage.content, /denied|拒绝|not approved|approval/i);
    },
  );
}

test(
  "unknown MCP tools cannot escape the discovered inventory",
  { timeout: 15_000 },
  async (t) => {
    let turn = 0;
    const h = await harness(t, () => {
      if (turn++ === 0) {
        return {
          toolCalls: [
            toolCall("unknown-1", "call_tool", {
              name: "not_in_inventory",
              arguments: "{}",
            }),
          ],
        };
      }
      return { text: "未知工具未执行。" };
    });
    await h.configure();
    const events = await readEvents(
      await h.request("/api/chat", {
        method: "POST",
        body: chatBody("unknown"),
      }),
    );
    assert.equal(h.mcp.calls.length, 0);
    assert.ok(!events.some(({ name }) => name === "approval_required"));
    assert.ok(
      events.some(
        ({ name, data }) =>
          name === "error" || (name === "tool_result" && data.isError),
      ),
    );
  },
);

test(
  "OpenAI errors are reported for both connection test and streamed chat",
  { timeout: 15_000 },
  async (t) => {
    const h = await harness(t, ({ body }) => ({
      status: body.stream ? 429 : 401,
      error: body.stream ? "fixture-rate-limit" : "fixture-auth-rejected",
    }));
    await h.configure();
    const tested = await h.requestJson("/api/test", {
      method: "POST",
      body: { baseUrl: `${h.modelOrigin}/v1`, model: MODEL },
    });
    assert.equal(tested.response.ok, false);
    assert.match(JSON.stringify(tested.data), /fixture-auth-rejected|401/);
    const events = await readEvents(
      await h.request("/api/chat", {
        method: "POST",
        body: chatBody("upstream-error"),
      }),
    );
    const error = events.find(({ name }) => name === "error");
    assert.ok(error);
    assert.match(JSON.stringify(error.data), /fixture-rate-limit|429/);
    assert.equal(h.mcp.calls.length, 0);
  },
);

test(
  "an upstream stream ending without finish_reason reports an interrupted reply and never done",
  { timeout: 15_000 },
  async (t) => {
    const h = await harness(t, () => ({
      text: "这是尚未完整的回答",
      interrupted: true,
    }));
    await h.configure();
    const events = await readEvents(
      await h.request("/api/chat", {
        method: "POST",
        body: chatBody("interrupted-stream"),
      }),
    );
    assert.equal(tokenText(events), "这是尚未完整的回答");
    const error = events.find(({ name }) => name === "error");
    assert.ok(
      error,
      "the browser must receive an explicit incomplete-stream failure",
    );
    assert.equal(error.data.code, "MODEL_STREAM_INTERRUPTED");
    assert.ok(!events.some(({ name }) => name === "done"));
    assert.equal(h.mcp.calls.length, 0);
  },
);

test(
  "cancel closes the model stream and prevents further MCP execution",
  { timeout: 15_000 },
  async (t) => {
    const h = await harness(t, () => ({ text: "正在分析", hold: true }));
    await h.configure();
    const conversationId = "cancel-stream";
    let cancelled = false;
    const events = await readEvents(
      await h.request("/api/chat", {
        method: "POST",
        body: chatBody(conversationId),
      }),
      async ({ name }) => {
        if (name !== "token" || cancelled) return;
        cancelled = true;
        const result = await h.requestJson("/api/cancel", {
          method: "POST",
          body: { conversationId },
        });
        assert.equal(result.response.status, 200);
      },
    );
    assert.ok(
      cancelled,
      "the model token must reach the browser before cancellation",
    );
    assert.ok(events.some(({ name }) => name === "cancelled"));
    assert.equal(h.mcp.calls.length, 0);
    const deadline = Date.now() + 2_000;
    while (h.closedResponses.length === 0 && Date.now() < deadline)
      await delay(10);
    assert.equal(
      h.closedResponses.length,
      1,
      "cancellation must abort the upstream model response",
    );
  },
);

test(
  "cancel while awaiting approval settles the chat without executing the write",
  { timeout: 15_000 },
  async (t) => {
    const h = await harness(t, () => ({
      toolCalls: [
        toolCall("pending-write", "call_tool", {
          name: "write_note",
          arguments: JSON.stringify({ text: "must remain unexecuted" }),
        }),
      ],
    }));
    await h.configure();
    const conversationId = "cancel-approval";
    let pendingApproval;
    const events = await readEvents(
      await h.request("/api/chat", {
        method: "POST",
        body: chatBody(conversationId),
      }),
      async ({ name, data }) => {
        if (name !== "approval_required") return;
        pendingApproval = data.id;
        const result = await h.requestJson("/api/cancel", {
          method: "POST",
          body: { conversationId },
        });
        assert.equal(result.response.status, 200);
      },
    );
    assert.ok(pendingApproval);
    assert.equal(h.mcp.calls.length, 0);
    assert.ok(events.some(({ name }) => name === "cancelled"));
    assert.equal(h.modelRequests.length, 1);
    const lateApproval = await h.requestJson("/api/approval", {
      method: "POST",
      body: { conversationId, id: pendingApproval, approved: true },
    });
    assert.equal(lateApproval.response.ok, false);
    assert.equal(
      h.mcp.calls.length,
      0,
      "a stale approval must not revive cancelled work",
    );
  },
);
