import assert from "node:assert/strict";
import { once } from "node:events";
import { request as rawHttpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { createAppServer } from "../server.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const jsonCompletion = (content, finishReason = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content },
          ...(finishReason === null ? {} : { finish_reason: finishReason }),
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );

const basicClient = () => ({
  async listTools() {
    return [];
  },
  async close() {},
});

async function startApp(t, { cleanup = async () => {}, ...options } = {}) {
  const app = createAppServer({
    mcpFactory: basicClient,
    fetchImpl: async () => jsonCompletion("分析完成。"),
    ...options,
  });
  const controllers = [];
  let closing;
  const close = () => (closing ??= app.close());
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await cleanup();
    await close();
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie;
  async function request(path, body) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    return response;
  }
  const configured = await request("/api/config", {
    baseUrl: "http://fixture.invalid/v1",
    model: "lifecycle-fixture",
  });
  assert.equal(configured.status, 200);
  await configured.text();
  return {
    origin,
    request,
    close,
    async chat(conversationId) {
      return request("/api/chat", {
        conversationId,
        message: "检查本地 fixture。",
        history: [],
      });
    },
  };
}

test(
  "JSON fallback without finish_reason is incomplete and must not emit done",
  { timeout: 10_000 },
  async (t) => {
    const app = await startApp(t, {
      fetchImpl: async () => jsonCompletion("这是未完成的文本。", null),
    });
    const response = await app.chat("json-interrupted");
    assert.equal(response.status, 200);
    const events = await response.text();
    assert.match(events, /MODEL_STREAM_INTERRUPTED/);
    assert.match(events, /event: error/);
    assert.doesNotMatch(events, /event: done/);
  },
);

test(
  "cancelling a reused conversation interrupts its second catalog request",
  { timeout: 10_000 },
  async (t) => {
    const entered = deferred();
    let rejectListing;
    let listingCount = 0;
    let modelCount = 0;
    let closeCount = 0;
    const client = {
      async listTools({ signal } = {}) {
        if (++listingCount === 1) return [];
        entered.resolve();
        return new Promise((_, reject) => {
          rejectListing = reject;
          if (signal?.aborted) reject(signal.reason);
          else
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      },
      async close() {
        closeCount++;
        rejectListing?.(new DOMException("Catalog closed", "AbortError"));
      },
    };
    const app = await startApp(t, {
      mcpFactory: async () => client,
      fetchImpl: async () => {
        modelCount++;
        return jsonCompletion("首轮分析完成。");
      },
      cleanup: () => client.close(),
    });
    assert.match(await (await app.chat("reused")).text(), /event: done/);
    const second = await app.chat("reused");
    const finished = second.text();
    await within(entered.promise, "The second catalog request never started");
    const cancel = await app.request("/api/cancel", {
      conversationId: "reused",
    });
    assert.equal(cancel.status, 200);
    await cancel.text();
    const events = await within(
      finished,
      "Cancellation left a reused MCP catalog request pending",
    );
    assert.match(events, /event: cancelled/);
    assert.doesNotMatch(events, /event: done/);
    assert.ok(closeCount > 0, "the cancelled MCP client must be closed");
    assert.equal(
      modelCount,
      1,
      "the cancelled second turn must not call the model",
    );
  },
);

test(
  "shutdown aborts active connection tests and waits for their settlement",
  { timeout: 10_000 },
  async (t) => {
    const started = deferred();
    let upstreamAborted = false;
    const app = await startApp(t, {
      fetchImpl: async (_url, { signal }) => {
        started.resolve();
        return new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              upstreamAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });
    const request = app
      .request("/api/test", {
        baseUrl: "http://fixture.invalid/v1",
        model: "lifecycle-fixture",
      })
      .then((response) => response.text())
      .catch(() => {});
    await within(
      started.promise,
      "The connection test never reached the model boundary",
    );
    await within(
      app.close(),
      "Shutdown left an active connection test pending",
    );
    assert.equal(upstreamAborted, true);
    await within(
      request,
      "The browser connection-test request did not settle during shutdown",
    );
  },
);

test(
  "shutdown rejects a connection test whose request body arrives after closing starts",
  { timeout: 10_000 },
  async (t) => {
    let browser;
    let modelCount = 0;
    const app = await startApp(t, {
      fetchImpl: async (_url, { signal }) => {
        modelCount++;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      cleanup: () => browser?.destroy(),
    });
    const body = JSON.stringify({
      baseUrl: "http://fixture.invalid/v1",
      model: "lifecycle-fixture",
    });
    const browserResult = deferred();
    browser = rawHttpRequest(
      `${app.origin}/api/test`,
      {
        method: "POST",
        headers: {
          origin: app.origin,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          expect: "100-continue",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => browserResult.resolve(response.statusCode));
      },
    );
    browser.on("error", (error) => browserResult.resolve(error));
    // Node sends 100 Continue and enters the real HTTP handler before the
    // client supplies the body. This places shutdown precisely across bodyOf().
    const bodyAccepted = once(browser, "continue");
    browser.flushHeaders();
    await within(
      bodyAccepted,
      "The server never accepted the pending request headers",
    );
    const closing = app.close();
    browser.end(body);
    await within(
      closing,
      "A request admitted before shutdown started a new model test during shutdown",
    );
    assert.equal(modelCount, 0);
    assert.equal(
      await within(
        browserResult.promise,
        "The closing server did not settle the pending HTTP request",
      ),
      503,
    );
  },
);

for (const sameConversationId of [false, true]) {
  test(
    `conversation eviction allows at most one concurrent chat (${sameConversationId ? "same ID" : "different IDs"})`,
    { timeout: 10_000 },
    async (t) => {
      const closingOldest = deferred();
      const releaseOldest = deferred();
      const modelStarted = deferred();
      let evicting = false;
      let activeModels = 0;
      let closingClients = 0;
      const app = await startApp(t, {
        mcpFactory: async () => ({
          async listTools() {
            return [];
          },
          async close() {
            if (!evicting) return;
            closingClients++;
            closingOldest.resolve();
            await releaseOldest.promise;
          },
        }),
        fetchImpl: async (_url, { signal }) => {
          if (!evicting) return jsonCompletion("分析完成。");
          activeModels++;
          modelStarted.resolve();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        cleanup: () => releaseOldest.resolve(),
      });
      for (let index = 0; index < 30; index++) {
        const response = await app.chat(`completed-${index}`);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /event: done/);
      }
      evicting = true;
      const firstId = "raced-first";
      const secondId = sameConversationId ? firstId : "raced-second";
      const first = app.chat(firstId);
      const second = app.chat(secondId);
      await within(
        closingOldest.promise,
        "The oldest conversation was not selected for eviction",
      );
      // Keep the close pending long enough for the other HTTP request to reach
      // the same admission boundary, instead of relying on microtask ordering.
      await delay(20);
      releaseOldest.resolve();
      const responses = await within(
        Promise.all([first, second]),
        "Concurrent chat admission did not settle",
      );
      assert.deepEqual(
        responses.map(({ status }) => status).sort(),
        [200, 409],
      );
      await within(
        modelStarted.promise,
        "The admitted chat never reached the model",
      );
      assert.equal(activeModels, 1);
      assert.equal(
        closingClients,
        1,
        "only one request may own eviction of the oldest client",
      );
      for (const id of new Set([firstId, secondId])) {
        const response = await app.request("/api/cancel", {
          conversationId: id,
        });
        assert.equal(response.status, 200);
        await response.text();
      }
      const bodies = await within(
        Promise.all(responses.map((response) => response.text())),
        "The admitted chat did not settle after cancellation",
      );
      assert.ok(bodies.some((body) => body.includes("event: cancelled")));
    },
  );
}
