import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Client, SdkErrorCode } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createChaiChaiClient,
  findTools,
  requiresApproval,
} from "../lib/mcp.mjs";

test("approval comes only from an explicit true readOnlyHint", () => {
  assert.equal(
    requiresApproval({ name: "delete", annotations: { readOnlyHint: true } }),
    false,
  );
  for (const tool of [
    undefined,
    { name: "inspect" },
    { annotations: {} },
    { annotations: { readOnlyHint: false } },
    { annotations: { readOnlyHint: "true" } },
  ]) {
    assert.equal(requiresApproval(tool), true);
  }
});

test("canonical effect flags allow session bookkeeping and guard external or unknown effects", () => {
  for (const effects of [
    [],
    ["mutatesSession"],
    ["mutatesSession", "idempotent"],
  ]) {
    assert.equal(
      requiresApproval({ effects, annotations: { readOnlyHint: false } }),
      false,
    );
  }
  for (const effects of [
    ["launchesProcess"],
    ["writesFilesystem"],
    ["mutatesTarget"],
    ["mutatesSession", "futureUnknownEffect"],
    ["executesForeignCode"],
    null,
    "unknown",
  ]) {
    assert.equal(
      requiresApproval({ effects, annotations: { readOnlyHint: true } }),
      true,
    );
  }
});

test("search preserves the matching catalog schemas and excludes unknown names", () => {
  const schema = {
    type: "object",
    properties: { nested: { enum: ["a", "b"] } },
  };
  const tools = [
    {
      name: "binary_session",
      description: "Current target status",
      inputSchema: schema,
      annotations: { readOnlyHint: true },
      effects: ["idempotent"],
    },
    {
      name: "inspect_browser",
      description: "Inspect browser target",
      inputSchema: schema,
    },
  ];
  const found = findTools(tools, "binary_session", 1);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "binary_session");
  assert.equal(found[0].inputSchema, schema);
  assert.equal(found[0].annotations, tools[0].annotations);
  assert.equal(found[0].effects, tools[0].effects);
  assert.deepEqual(findTools(tools, "nonexistent-signal"), []);
  assert.deepEqual(findTools(tools, ""), []);
});

test("catalog effect metadata is joined by exact names, cached once, and keeps schemas intact", async () => {
  const schema = { type: "object", properties: { path: { type: "string" } } };
  mock.method(Client.prototype, "connect", async () => {});
  mock.method(Client.prototype, "close", async () => {});
  const list = mock.method(Client.prototype, "listTools", async () => ({
    tools: [
      {
        name: "static_analysis",
        inputSchema: schema,
        annotations: { readOnlyHint: false },
      },
      {
        name: "launch_analysis",
        inputSchema: schema,
        annotations: { readOnlyHint: false },
      },
      {
        name: "write_output",
        inputSchema: schema,
        annotations: { readOnlyHint: false },
      },
      {
        name: "future_tool",
        inputSchema: schema,
        annotations: { readOnlyHint: true },
      },
      {
        name: "missing_metadata",
        inputSchema: schema,
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  const status = mock.method(
    Client.prototype,
    "callTool",
    async (params, options) => {
      assert.deepEqual(params, { name: "binary_session", arguments: {} });
      assert.ok(options.signal instanceof AbortSignal);
      return {
        structuredContent: {
          result: {
            tool_availability: {
              groups: [
                {
                  names: ["static_analysis"],
                  effects: ["mutatesSession", "idempotent"],
                },
                {
                  names: ["launch_analysis"],
                  effects: ["launchesProcess", "idempotent"],
                },
                {
                  names: ["write_output"],
                  effects: ["writesFilesystem", "idempotent"],
                },
                { names: ["future_tool"], effects: ["newExternalEffect"] },
              ],
            },
          },
        },
      };
    },
  );
  try {
    const client = await createChaiChaiClient();
    const [first, second] = await Promise.all([
      client.listTools(),
      client.listTools(),
    ]);
    assert.equal(first, second);
    assert.equal(list.mock.callCount(), 1);
    assert.equal(status.mock.callCount(), 1);
    assert.equal(first[0].inputSchema, schema);
    assert.deepEqual(first.map(requiresApproval), [
      false,
      true,
      true,
      true,
      false,
    ]);
    assert.equal(Object.hasOwn(first[4], "effects"), false);
    await client.close();
    await assert.rejects(
      client.listTools(),
      (error) => error.code === "MCP_CLOSED",
    );
  } finally {
    mock.restoreAll();
  }
});

test("unavailable session effect metadata falls back to the real tool annotations", async () => {
  mock.method(Client.prototype, "connect", async () => {});
  mock.method(Client.prototype, "close", async () => {});
  mock.method(Client.prototype, "listTools", async () => ({
    tools: [
      { name: "read", inputSchema: {}, annotations: { readOnlyHint: true } },
      { name: "unknown", inputSchema: {} },
    ],
  }));
  mock.method(Client.prototype, "callTool", async () => {
    throw new Error("private metadata failure");
  });
  try {
    const client = await createChaiChaiClient();
    const tools = await client.listTools();
    assert.deepEqual(tools.map(requiresApproval), [false, true]);
    assert.ok(tools.every((tool) => !Object.hasOwn(tool, "effects")));
    await client.close();
  } finally {
    mock.restoreAll();
  }
});

test("an already aborted lifetime never connects", async () => {
  const connect = mock.method(Client.prototype, "connect", async () => {});
  try {
    await assert.rejects(
      createChaiChaiClient({ signal: AbortSignal.abort("private value") }),
      (error) =>
        error.name === "AbortError" && !error.message.includes("private value"),
    );
    assert.equal(connect.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
  }
});

test("pagination, request signals and idempotent close use the owned client", async () => {
  const pages = [];
  let closes = 0;
  mock.method(Client.prototype, "connect", async (transport, options) => {
    assert.ok(transport instanceof StdioClientTransport);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(options.timeout > 0);
  });
  mock.method(Client.prototype, "listTools", async (params, options) => {
    pages.push(params?.cursor);
    assert.ok(options.signal instanceof AbortSignal);
    return params?.cursor === undefined
      ? { tools: [{ name: "first", inputSchema: {} }], nextCursor: "page-2" }
      : { tools: [{ name: "second", inputSchema: {} }] };
  });
  const call = mock.method(
    Client.prototype,
    "callTool",
    async (params, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return { content: [{ type: "text", text: JSON.stringify(params) }] };
    },
  );
  const read = mock.method(
    Client.prototype,
    "readResource",
    async (params, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return { contents: [{ uri: params.uri, text: "retained evidence" }] };
    },
  );
  mock.method(Client.prototype, "close", async () => {
    closes += 1;
  });
  try {
    const client = await createChaiChaiClient();
    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name),
      ["first", "second"],
    );
    assert.deepEqual(pages, [undefined, "page-2"]);
    const controller = new AbortController();
    await client.callTool("binary_session", {}, { signal: controller.signal });
    assert.equal(call.mock.calls[0].arguments.length, 2);
    await client.readResource("chaichai://evidence/example", {
      signal: controller.signal,
    });
    assert.equal(read.mock.calls[0].arguments.length, 2);
    controller.abort();
    await assert.rejects(
      client.callTool("binary_session", {}, { signal: controller.signal }),
      (error) => error.name === "AbortError",
    );
    await Promise.all([client.close(), client.close()]);
    assert.equal(closes, 1);
    await assert.rejects(
      client.listTools(),
      (error) => error.code === "MCP_CLOSED",
    );
  } finally {
    mock.restoreAll();
  }
});

test("connection cancellation closes its own client and hides raw errors", async () => {
  let closes = 0;
  let entered;
  const connecting = new Promise((resolve) => {
    entered = resolve;
  });
  mock.method(Client.prototype, "connect", () => {
    entered();
    return new Promise(() => {});
  });
  mock.method(Client.prototype, "close", async () => {
    closes += 1;
  });
  try {
    const controller = new AbortController();
    const pending = createChaiChaiClient({ signal: controller.signal });
    await connecting;
    controller.abort("secret cancellation detail");
    await assert.rejects(
      pending,
      (error) =>
        error.name === "AbortError" && !error.message.includes("secret"),
    );
    assert.equal(closes, 1);
  } finally {
    mock.restoreAll();
  }
});

test("connection timeout is reported in Chinese without SDK diagnostics", async () => {
  mock.method(Client.prototype, "connect", async () => {
    throw Object.assign(new Error("private timeout detail"), {
      code: SdkErrorCode.RequestTimeout,
    });
  });
  mock.method(Client.prototype, "close", async () => {});
  try {
    await assert.rejects(
      createChaiChaiClient(),
      (error) =>
        error.code === "MCP_CONNECT_TIMEOUT" &&
        error.message.includes("超时") &&
        !error.message.includes("private"),
    );
  } finally {
    mock.restoreAll();
  }
});

test("repeated pagination cursors fail instead of looping or returning partial tools", async () => {
  mock.method(Client.prototype, "connect", async () => {});
  mock.method(Client.prototype, "close", async () => {});
  const list = mock.method(Client.prototype, "listTools", async () => ({
    tools: [{ name: "first", inputSchema: {} }],
    nextCursor: "repeat",
  }));
  try {
    const client = await createChaiChaiClient();
    await assert.rejects(client.listTools(), /读取拆拆工具列表失败/u);
    assert.equal(list.mock.callCount(), 2);
    await client.close();
  } finally {
    mock.restoreAll();
  }
});

test("connection failure disposes the owned transport and sanitizes diagnostics", async () => {
  mock.method(Client.prototype, "connect", async () => {
    throw new Error("PRIVATE_ENV=secret");
  });
  mock.method(Client.prototype, "close", async () => {
    throw new Error("close secret");
  });
  const closeTransport = mock.method(
    StdioClientTransport.prototype,
    "close",
    async () => {},
  );
  try {
    await assert.rejects(
      createChaiChaiClient(),
      (error) =>
        error.code === "MCP_CONNECT_FAILED" &&
        !error.message.includes("secret"),
    );
    assert.equal(closeTransport.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }
});
