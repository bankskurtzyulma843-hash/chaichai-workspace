import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Client, SdkErrorCode } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const connectionTimeoutMs = 30_000;

const interfaceError = (message, code) =>
  Object.assign(new Error(message), { code });

const cancelledError = () =>
  Object.assign(new Error("拆拆操作已取消。"), {
    name: "AbortError",
    code: "MCP_ABORTED",
  });

const assertNotAborted = (signal) => {
  if (signal?.aborted) throw cancelledError();
};

/** Read configuration as data; never evaluate it or change the parent environment. */
const childEnvironment = async (signal) => {
  assertNotAborted(signal);
  let analysisEnvironment = {};
  try {
    const text = await readFile(
      join(homedir(), ".chaichai", "analysis-tools.env"),
      { encoding: "utf8", signal },
    );
    analysisEnvironment = parseEnv(text);
  } catch (error) {
    assertNotAborted(signal);
    if (error?.code !== "ENOENT") {
      throw interfaceError(
        "无法读取拆拆分析工具配置，请检查 analysis-tools.env。",
        "MCP_ENV_UNAVAILABLE",
      );
    }
  }
  assertNotAborted(signal);
  return Object.fromEntries(
    Object.entries({ ...process.env, ...analysisEnvironment }).filter(
      ([, value]) => typeof value === "string",
    ),
  );
};

/** Bound the entire connection, including transport startup before the handshake. */
const waitForConnection = (connection, signal) =>
  new Promise((resolveConnection, rejectConnection) => {
    const abort = () => rejectConnection(cancelledError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    connection.then(resolveConnection, rejectConnection).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });

const connectOwnedClient = async (
  client,
  transport,
  { lifetime, signal, close },
) => {
  const timeout = AbortSignal.timeout(connectionTimeoutMs);
  const connectionSignal = AbortSignal.any([
    lifetime.signal,
    timeout,
    ...(signal === undefined ? [] : [signal]),
  ]);
  try {
    assertNotAborted(connectionSignal);
    await waitForConnection(
      client.connect(transport, {
        signal: connectionSignal,
        timeout: connectionTimeoutMs,
      }),
      connectionSignal,
    );
    assertNotAborted(connectionSignal);
  } catch (error) {
    await close().catch(() => {});
    if (signal?.aborted) throw cancelledError();
    if (timeout.aborted || error?.code === SdkErrorCode.RequestTimeout) {
      throw interfaceError("连接拆拆超时，请稍后重试。", "MCP_CONNECT_TIMEOUT");
    }
    throw interfaceError(
      "无法连接拆拆，请确认项目运行时已构建。",
      "MCP_CONNECT_FAILED",
    );
  }
};

const readToolEffects = async (client, signal) => {
  try {
    // This reads this client's own session metadata, without opening any target.
    const status = await client.callTool(
      { name: "binary_session", arguments: {} },
      { signal },
    );
    const groups = status.structuredContent?.result?.tool_availability?.groups;
    const effects = new Map();
    if (!Array.isArray(groups)) return effects;
    for (const group of groups) {
      if (
        !Array.isArray(group.names) ||
        !Array.isArray(group.effects) ||
        !group.names.every((name) => typeof name === "string") ||
        !group.effects.every((effect) => typeof effect === "string")
      )
        continue;
      for (const name of group.names) effects.set(name, group.effects);
    }
    return effects;
  } catch {
    assertNotAborted(signal);
    // Missing effect metadata keeps the conservative MCP annotation fallback.
    return new Map();
  }
};

const readToolCatalog = async (client, signal) => {
  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      { signal, cacheMode: "refresh" },
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) {
        throw interfaceError(
          "拆拆工具目录返回了重复的分页游标。",
          "MCP_INVALID_PAGINATION",
        );
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  const effects = await readToolEffects(client, signal);
  return tools.map((tool) =>
    effects.has(tool.name)
      ? { ...tool, effects: [...effects.get(tool.name)] }
      : tool,
  );
};

/** Own one repository-local MCP subprocess; the installed/global server is untouched. */
export const createChaiChaiClient = async ({ signal } = {}) => {
  const environment = await childEnvironment(signal);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "rea.mjs"), "mcp"],
    cwd: projectRoot,
    env: environment,
    stderr: "pipe",
  });
  // Drain diagnostics without retaining or exposing the child environment or logs.
  transport.stderr?.resume();
  const client = new Client({
    name: "chaichai-local-interface",
    version: "1.0.0",
  });
  const lifetime = new AbortController();
  let closed = false;
  let closing;
  let catalog;

  const close = () => {
    if (closing !== undefined) return closing;
    closed = true;
    lifetime.abort();
    signal?.removeEventListener("abort", cancelLifetime);
    closing = (async () => {
      let failed = false;
      try {
        await client.close();
      } catch {
        failed = true;
      }
      // A failed handshake may leave an owned transport outside Client.close().
      if (failed || transport.pid !== null) {
        try {
          await transport.close();
          failed = false;
        } catch {
          failed = true;
        }
      }
      if (failed) {
        throw interfaceError("关闭拆拆连接失败。", "MCP_CLOSE_FAILED");
      }
    })();
    return closing;
  };
  const cancelLifetime = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", cancelLifetime, { once: true });

  await connectOwnedClient(client, transport, { lifetime, signal, close });

  const request = async (operation, operationSignal, failureMessage) => {
    if (closed) {
      throw interfaceError("拆拆连接已关闭。", "MCP_CLOSED");
    }
    const requestSignal = AbortSignal.any([
      lifetime.signal,
      ...(operationSignal === undefined ? [] : [operationSignal]),
    ]);
    assertNotAborted(requestSignal);
    try {
      return await operation(requestSignal);
    } catch {
      assertNotAborted(requestSignal);
      throw interfaceError(failureMessage, "MCP_REQUEST_FAILED");
    }
  };

  return {
    listTools: () =>
      request(
        (requestSignal) => {
          catalog ??= readToolCatalog(client, requestSignal).catch((error) => {
            catalog = undefined;
            throw error;
          });
          return catalog;
        },
        undefined,
        "读取拆拆工具列表失败。",
      ),
    callTool: (name, args = {}, { signal: operationSignal } = {}) =>
      request(
        (requestSignal) =>
          client.callTool({ name, arguments: args }, { signal: requestSignal }),
        operationSignal,
        "调用拆拆工具失败。",
      ),
    readResource: (uri, { signal: operationSignal } = {}) =>
      request(
        (requestSignal) =>
          client.readResource({ uri }, { signal: requestSignal }),
        operationSignal,
        "读取拆拆资源失败。",
      ),
    close,
  };
};

/** Session-only evidence bookkeeping is automatic; every other effect needs a decision. */
export const requiresApproval = (tool) => {
  if (Array.isArray(tool?.effects)) {
    return tool.effects.some(
      (effect) => effect !== "mutatesSession" && effect !== "idempotent",
    );
  }
  if (tool?.effects !== undefined) return true;
  return tool?.annotations?.readOnlyHint !== true;
};

/** Rank actual catalog entries without inventing names or trimming their schemas. */
export const findTools = (tools, query, limit = 6) => {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("工具搜索数量必须是非负整数。");
  }
  const normalized = String(query ?? "")
    .trim()
    .toLowerCase();
  const tokens = [...new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (tokens.length === 0 || limit === 0) return [];
  return tools
    .map((tool, index) => {
      const name = tool.name.toLowerCase();
      const description = (tool.description ?? "").toLowerCase();
      const score = tokens.reduce(
        (total, token) =>
          total +
          (name.includes(token) ? 4 : 0) +
          (description.includes(token) ? 1 : 0),
        name === normalized ? 20 : 0,
      );
      return { tool, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ tool }) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      ...(tool.annotations === undefined
        ? {}
        : { annotations: tool.annotations }),
      ...(tool.effects === undefined ? {} : { effects: tool.effects }),
    }));
};
