import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createBrowserClient } from "../public/browser-client.js";

async function fixture(t, responder) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    requests.push(request);
    responder(request, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function answer(_request, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: { content: "收到：真实 HTTP fixture 回复" },
          finish_reason: "stop",
        },
      ],
    }),
  );
}

test("browser mode configures a real HTTP API and streams text without advertising local tools", async (t) => {
  const model = await fixture(t, (request, res) => {
    if (!request.body.stream) return answer(request, res);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"网页回复"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  const client = createBrowserClient();
  const config = {
    baseUrl: model.baseUrl,
    model: "fixture-only",
    apiKey: "test-memory-key",
  };
  const saved = await client.api("/api/config", {
    method: "POST",
    body: config,
  });
  assert.equal(saved.config.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes(config.apiKey), false);
  assert.equal((await client.api("/api/state")).mcp.status, "browser");
  assert.equal(
    (
      await client.api("/api/test", {
        method: "POST",
        body: { ...config, apiKey: undefined },
      })
    ).ok,
    true,
  );
  const events = [];
  await client.chat(
    { conversationId: "a", message: "你好", history: [] },
    { onEvent: (event) => events.push(event) },
  );
  assert.equal(
    events.find((event) => event.type === "done").data.message,
    "网页回复",
  );
  assert.equal(
    events.some((event) => event.type.startsWith("tool_")),
    false,
  );
  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[1].body.tools, undefined);
  assert.equal(model.requests[1].authorization, "Bearer test-memory-key");
  await client.api("/api/config", { method: "DELETE" });
  assert.equal((await client.api("/api/state")).config.hasApiKey, false);
  await assert.rejects(
    client.chat(
      { conversationId: "a", message: "hi", history: [] },
      { onEvent() {} },
    ),
    /先配置/,
  );
});

test("browser credentials are isolated by page and API address, and provider errors are redacted", async (t) => {
  const original = await fixture(t, answer);
  const replacement = await fixture(t, (_request, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "rejected test-second-key" } }));
  });
  const client = createBrowserClient();
  await client.api("/api/config", {
    method: "POST",
    body: {
      baseUrl: original.baseUrl,
      model: "fixture",
      apiKey: "test-original-key",
    },
  });
  await client.api("/api/config", {
    method: "POST",
    body: { baseUrl: replacement.baseUrl, model: "fixture" },
  });
  assert.equal((await client.api("/api/state")).config.hasApiKey, false);
  assert.equal(
    (await createBrowserClient().api("/api/state")).config.baseUrl,
    "",
  );
  await assert.rejects(
    client.api("/api/test", {
      method: "POST",
      body: {
        baseUrl: replacement.baseUrl,
        model: "fixture",
        apiKey: "test-second-key",
      },
    }),
    (error) =>
      !error.message.includes("test-second-key") &&
      error.message.includes("[已隐藏]"),
  );
  assert.equal(replacement.requests[0].authorization, "Bearer test-second-key");
  assert.equal(original.requests.length, 0);
});

test("browser cancellation aborts the owned stream and releases configuration lock", async (t) => {
  let streaming;
  const started = new Promise((resolve) => {
    streaming = resolve;
  });
  const model = await fixture(t, (_request, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      'data: {"choices":[{"delta":{"content":"部分回复"},"finish_reason":null}]}\n\n',
    );
    streaming();
  });
  const client = createBrowserClient();
  await client.api("/api/config", {
    method: "POST",
    body: { baseUrl: model.baseUrl, model: "fixture" },
  });
  const run = client.chat(
    { conversationId: "cancel", message: "你好", history: [] },
    { onEvent() {} },
  );
  const rejected = assert.rejects(run, { name: "AbortError" });
  await started;
  await assert.rejects(client.api("/api/config", { method: "DELETE" }), /停止/);
  await client.api("/api/cancel", {
    method: "POST",
    body: { conversationId: "cancel" },
  });
  await rejected;
  await client.api("/api/config", { method: "DELETE" });
});
