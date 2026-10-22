import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createChaiChaiClient } from "./lib/mcp.mjs";
import {
  AppError,
  configView,
  normalizeConfig,
  publicError,
  runAgent,
  testConnection,
} from "./lib/model.mjs";

const BODY_LIMIT = 1024 * 1024;
const IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_LIMIT = 100;
const CONVERSATION_LIMIT = 30;
const COOKIE_NAME = "chaichai_chat_session";
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function bodyOf(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT)
      throw new AppError(
        "本次请求超过 1 MiB，请减少对话内容后重试。",
        "BODY_TOO_LARGE",
        413,
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("请求需要使用有效的 JSON。", "INVALID_JSON");
  }
}

function conversationIdOf(input) {
  if (
    typeof input?.conversationId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/u.test(input.conversationId)
  )
    throw new AppError("对话标识无效，请新建对话。", "INVALID_CONVERSATION");
  return input.conversationId;
}

function chatInput(input) {
  const id = conversationIdOf(input);
  if (typeof input.message !== "string" || !input.message.trim())
    throw new AppError("请输入你的问题或拆解目标。", "EMPTY_MESSAGE");
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > 128)
    throw new AppError("对话历史过长，请新建对话。", "HISTORY_TOO_LARGE");
  for (const message of history) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    )
      throw new AppError("对话历史格式无效。", "INVALID_HISTORY");
  }
  return {
    id,
    message: input.message,
    history: history.map(({ role, content }) => ({ role, content })),
  };
}

function abortError() {
  return new DOMException("任务已停止。", "AbortError");
}

export function createAppServer({
  mcpFactory = createChaiChaiClient,
  fetchImpl = fetch,
} = {}) {
  const sessions = new Map();
  let probePromise;
  let probeStatus = { status: "idle", toolCount: 0 };
  let probeTime = 0;
  let closing = false;
  let closePromise;
  const connectionTests = new Map();

  const closeConversation = async (conversation) => {
    conversation.run?.controller.abort(abortError());
    await conversation.run?.finished;
    if (conversation.client) {
      await conversation.client.close();
      conversation.client = undefined;
    }
  };
  const closeSession = async (session) => {
    await Promise.allSettled(
      [...session.conversations.values()].map(closeConversation),
    );
    session.config = null;
    session.conversations.clear();
  };
  const prune = async () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.touchedAt > IDLE_MS && !session.busy) {
        sessions.delete(id);
        await closeSession(session);
      }
    }
  };
  const timer = setInterval(() => {
    void prune();
  }, 60_000);
  timer.unref();

  const getSession = (req, res) => {
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${COOKIE_NAME}=`));
    const id = cookie?.slice(COOKIE_NAME.length + 1);
    let session = id ? sessions.get(id) : undefined;
    if (!session) {
      if (sessions.size >= SESSION_LIMIT)
        throw new AppError(
          "本地会话数量已满，请关闭旧会话或重启服务。",
          "SESSION_LIMIT",
          503,
        );
      const newId = randomBytes(32).toString("hex");
      session = {
        config: null,
        conversations: new Map(),
        touchedAt: Date.now(),
        busy: false,
      };
      sessions.set(newId, session);
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${newId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${IDLE_MS / 1000}`,
      );
    }
    session.touchedAt = Date.now();
    return session;
  };

  const probe = () => {
    if (
      probePromise &&
      (probeStatus.status !== "error" || Date.now() - probeTime < 5000)
    )
      return probePromise;
    probePromise = (async () => {
      let client;
      try {
        client = await mcpFactory();
        const tools = await client.listTools();
        probeStatus = { status: "ready", toolCount: tools.length };
      } catch {
        probeStatus = {
          status: "error",
          toolCount: 0,
          message:
            "拆拆尚未就绪，请先在项目根目录安装依赖并运行 npm run build:cached。",
        };
      } finally {
        try {
          await client?.close();
        } catch {
          probeStatus = {
            status: "error",
            toolCount: 0,
            message: "拆拆探测进程清理失败，请重试或重启本地服务。",
          };
        }
        probeTime = Date.now();
      }
      return probeStatus;
    })();
    return probePromise;
  };

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    let session;
    let reservedSession;
    try {
      const port = server.address()?.port;
      const host = req.headers.host;
      if (
        !host ||
        ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
          host,
        )
      )
        throw new AppError("请通过本机地址访问拆拆。", "INVALID_HOST", 403);
      const url = new URL(req.url, `http://${host}`);
      if (
        req.headers.origin &&
        ![
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
        ].includes(req.headers.origin)
      )
        throw new AppError("不接受来自其他网站的请求。", "INVALID_ORIGIN", 403);
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new AppError("不接受跨站请求。", "INVALID_ORIGIN", 403);
      if (closing)
        throw new AppError("本地服务正在关闭。", "SERVER_CLOSING", 503);
      const staticFile = STATIC_FILES.get(url.pathname);
      if ((req.method === "GET" || req.method === "HEAD") && staticFile) {
        const [name, contentType] = staticFile;
        const content = await readFile(
          new URL(`./public/${name}`, import.meta.url),
        );
        res.writeHead(200, { "Content-Type": contentType });
        res.end(req.method === "HEAD" ? undefined : content);
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        json(res, 404, {
          error: { message: "页面不存在。", code: "NOT_FOUND" },
        });
        return;
      }
      if (
        req.method === "POST" &&
        !req.headers["content-type"]?.startsWith("application/json")
      )
        throw new AppError(
          "请使用 application/json 提交请求。",
          "INVALID_CONTENT_TYPE",
          415,
        );
      session = getSession(req, res);
      if (req.method === "GET" && url.pathname === "/api/state") {
        json(res, 200, {
          config: configView(session.config),
          mcp: await probe(),
        });
        return;
      }
      if (req.method === "DELETE" && url.pathname === "/api/config") {
        if (session.busy)
          throw new AppError(
            "请先停止当前任务，再清除 API 配置。",
            "TASK_RUNNING",
            409,
          );
        session.config = null;
        json(res, 200, { config: configView(null) });
        return;
      }
      if (req.method !== "POST")
        throw new AppError("接口不存在。", "NOT_FOUND", 404);
      const input = await bodyOf(req);
      if (closing)
        throw new AppError("本地服务正在关闭。", "SERVER_CLOSING", 503);
      if (url.pathname === "/api/config") {
        if (session.busy)
          throw new AppError(
            "请等待当前任务完成或停止后再更改模型配置。",
            "TASK_RUNNING",
            409,
          );
        session.config = normalizeConfig(input, session.config ?? {});
        json(res, 200, { config: configView(session.config) });
        return;
      }
      if (url.pathname === "/api/test") {
        const config = normalizeConfig(input, session.config ?? {});
        const controller = new AbortController();
        let finishTest;
        const testFinished = new Promise((resolve) => {
          finishTest = resolve;
        });
        connectionTests.set(controller, testFinished);
        const disconnected = () => {
          if (!res.writableEnded) controller.abort(abortError());
        };
        res.once("close", disconnected);
        try {
          json(
            res,
            200,
            await testConnection(config, {
              signal: controller.signal,
              fetchImpl,
            }),
          );
        } catch (error) {
          json(res, error instanceof AppError ? error.status : 502, {
            error: publicError(error, config.apiKey),
          });
        } finally {
          res.off("close", disconnected);
          connectionTests.delete(controller);
          finishTest();
        }
        return;
      }
      if (url.pathname === "/api/approval") {
        const id = conversationIdOf(input);
        const run = session.conversations.get(id)?.run;
        if (
          !run ||
          typeof input.id !== "string" ||
          typeof input.approved !== "boolean" ||
          !run.approvals.has(input.id)
        )
          throw new AppError(
            "该操作已结束或不再等待确认。",
            "APPROVAL_NOT_FOUND",
            404,
          );
        run.approvals.get(input.id)(input.approved);
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/cancel") {
        const id = conversationIdOf(input);
        session.conversations.get(id)?.run?.controller.abort(abortError());
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/conversation/delete") {
        const id = conversationIdOf(input);
        if (session.busy)
          throw new AppError(
            "请先停止当前任务，再删除对话。",
            "TASK_RUNNING",
            409,
          );
        session.busy = true;
        reservedSession = session;
        const conversation = session.conversations.get(id);
        if (conversation) {
          await closeConversation(conversation);
          session.conversations.delete(id);
        }
        session.busy = false;
        reservedSession = undefined;
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname !== "/api/chat")
        throw new AppError("接口不存在。", "NOT_FOUND", 404);
      if (!session.config)
        throw new AppError(
          "请先配置 API 地址和模型名称。",
          "CONFIG_REQUIRED",
          400,
        );
      const chat = chatInput(input);
      if (session.busy)
        throw new AppError(
          "已有任务正在执行，请先等待或停止。",
          "TASK_RUNNING",
          409,
        );
      // Reserve before awaiting eviction/connection work. Two browser requests
      // must never enter the same session's tool lifecycle concurrently.
      session.busy = true;
      reservedSession = session;
      let conversation = session.conversations.get(chat.id);
      if (!conversation) {
        if (session.conversations.size >= CONVERSATION_LIMIT) {
          const [oldId, oldest] = session.conversations.entries().next().value;
          await closeConversation(oldest);
          session.conversations.delete(oldId);
        }
        conversation = {};
        session.conversations.set(chat.id, conversation);
      }
      if (closing)
        throw new AppError("本地服务正在关闭。", "SERVER_CLOSING", 503);
      const controller = new AbortController();
      let settle;
      const finished = new Promise((resolve) => {
        settle = resolve;
      });
      const run = { controller, approvals: new Map(), finished };
      conversation.run = run;
      const cancelClient = () => {
        const client = conversation.client;
        if (!client || run.clientClosing) return;
        conversation.client = undefined;
        run.clientClosing = Promise.resolve()
          .then(() => client.close())
          .catch(() => {});
      };
      controller.signal.addEventListener("abort", cancelClient, { once: true });
      const config = { ...session.config };
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const emit = (event, data) => {
        if (!res.destroyed && !res.writableEnded)
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const disconnected = () => {
        if (!res.writableEnded) controller.abort(abortError());
      };
      res.once("close", disconnected);
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
      }, 15_000);
      heartbeat.unref();
      const approve = (tool) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            run.approvals.delete(tool.id);
            reject(controller.signal.reason);
          };
          controller.signal.throwIfAborted();
          const onDecision = (approved) => {
            controller.signal.removeEventListener("abort", onAbort);
            run.approvals.delete(tool.id);
            resolve(approved);
          };
          run.approvals.set(tool.id, onDecision);
          controller.signal.addEventListener("abort", onAbort, { once: true });
          emit("approval_required", tool);
        });
      try {
        emit("status", { message: "正在连接拆拆工具…" });
        conversation.client ??= await mcpFactory({ signal: controller.signal });
        const result = await runAgent({
          config,
          message: chat.message,
          history: chat.history,
          mcp: conversation.client,
          emit,
          signal: controller.signal,
          approve,
          fetchImpl,
        });
        emit("done", result);
      } catch (error) {
        if (controller.signal.aborted)
          emit("cancelled", { message: "任务已停止。" });
        else emit("error", publicError(error, config.apiKey));
      } finally {
        clearInterval(heartbeat);
        res.off("close", disconnected);
        controller.signal.removeEventListener("abort", cancelClient);
        run.approvals.clear();
        if (controller.signal.aborted && conversation.client) {
          try {
            await conversation.client.close();
          } catch {
            /* A later request reconnects rather than reusing a cancelled session. */
          }
          conversation.client = undefined;
        }
        await run.clientClosing;
        conversation.run = undefined;
        session.busy = false;
        reservedSession = undefined;
        session.touchedAt = Date.now();
        settle();
        res.end();
      }
    } catch (error) {
      if (reservedSession) reservedSession.busy = false;
      if (closing && !res.headersSent) res.setHeader("Connection", "close");
      if (!res.headersSent)
        json(res, error instanceof AppError ? error.status : 500, {
          error: publicError(error, session?.config?.apiKey),
        });
      else res.end();
    }
  });

  return {
    server,
    close: () =>
      (closePromise ??= (async () => {
        closing = true;
        clearInterval(timer);
        for (const controller of connectionTests.keys())
          controller.abort(abortError());
        await Promise.allSettled(connectionTests.values());
        await Promise.allSettled([...sessions.values()].map(closeSession));
        sessions.clear();
        await probePromise;
        if (server.listening) {
          const closed = new Promise((resolve) => server.close(resolve));
          server.closeIdleConnections();
          await closed;
        }
      })()),
  };
}

const entry = process.argv[1];
if (entry && pathToFileURL(await realpath(entry)).href === import.meta.url) {
  const port = Number(process.env.CHAICHAI_UI_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CHAICHAI_UI_PORT 需为 1–65535 的端口。");
  const app = createAppServer();
  app.server.once("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `端口 ${port} 已被占用，请设置 CHAICHAI_UI_PORT 后重试。`
        : "拆拆本地服务启动失败。",
    );
    process.exitCode = 1;
  });
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`拆拆对话工作台：http://127.0.0.1:${port}`);
    console.log("API 配置保存在当前本地服务的内存中。按 Ctrl+C 退出。");
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.close();
      process.exitCode = 0;
    });
}
