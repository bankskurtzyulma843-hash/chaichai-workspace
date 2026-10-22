export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 180_000;

export class AppError extends Error {
  constructor(message, code = "REQUEST_FAILED", status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export function publicError(error, apiKey = "") {
  let message = error instanceof Error ? error.message : "请求失败，请重试。";
  if (apiKey) message = message.replaceAll(apiKey, "[已隐藏]");
  return {
    message: message.slice(0, 1000),
    code: error instanceof AppError ? error.code : "REQUEST_FAILED",
  };
}

function apiAddress(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length > 2048)
    throw new AppError("请填写有效的 API 地址。", "INVALID_CONFIG");
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new AppError(
      "API 地址需要包含 http:// 或 https://。",
      "INVALID_CONFIG",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError(
      "API 地址需使用 HTTP(S)，且不包含账号、密码、查询参数或片段。",
      "INVALID_CONFIG",
    );
  url.pathname = url.pathname.replace(/\/+$/u, "");
  const normalizedUrl = url.toString().replace(/\/+$/u, "");
  if (url.pathname.endsWith("/responses"))
    throw new AppError(
      "这里使用 Chat Completions 接口，请填写服务商的兼容接口地址。",
      "INVALID_CONFIG",
    );
  return { url, normalizedUrl };
}

export function normalizeConfig(input, previous = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new AppError("请填写 API 配置。", "INVALID_CONFIG");
  const { baseUrl, model, apiKey } = input;
  const { url, normalizedUrl } = apiAddress(baseUrl);
  if (typeof model !== "string" || !model.trim() || model.length > 512)
    throw new AppError("请填写服务商提供的模型名称。", "INVALID_CONFIG");
  if (
    apiKey !== undefined &&
    (typeof apiKey !== "string" || apiKey.length > 16_384)
  )
    throw new AppError("API Key 格式无效。", "INVALID_CONFIG");
  const key =
    apiKey?.trim() ||
    (previous.baseUrl === normalizedUrl ? (previous.apiKey ?? "") : "");
  return {
    baseUrl: normalizedUrl,
    endpoint: url.pathname.endsWith("/chat/completions")
      ? normalizedUrl
      : `${normalizedUrl}/chat/completions`,
    model: model.trim(),
    apiKey: key,
  };
}

export const configView = (config) => ({
  baseUrl: config?.baseUrl ?? "",
  model: config?.model ?? "",
  hasApiKey: Boolean(config?.apiKey),
});

function requestFailure(error, callerSignal, requestSignal, browserMode) {
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (requestSignal.aborted)
    throw new AppError(
      "模型请求等待超过 3 分钟，请检查接口或重试。",
      "MODEL_TIMEOUT",
      504,
    );
  if (error instanceof AppError) throw error;
  throw new AppError(
    browserMode
      ? "浏览器无法连接模型接口，请检查地址、网络，以及服务商是否允许当前网页的跨域请求（CORS）。"
      : "无法连接模型接口，请检查地址、网络和本地服务的代理设置。",
    "MODEL_CONNECTION_FAILED",
    502,
  );
}

/** One reader owns each body; all exits cancel unread data and release its lock. */
async function* responseChunks(response, signal) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      yield value;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } catch {
      /* Preserve the original read error. */
    }
    reader.releaseLock();
  }
}

function responseTooLarge() {
  return new AppError(
    "模型响应超过 8 MiB 接收上限，请缩小本次任务。",
    "RESPONSE_TOO_LARGE",
    502,
  );
}

async function boundedText(response, signal) {
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for await (const chunk of responseChunks(response, signal)) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw responseTooLarge();
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function request(config, body, { signal, fetchImpl, browserMode }) {
  const combined = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, ...body }),
      signal: combined,
    });
    if (!response.ok) {
      const text = await boundedText(response, combined);
      let detail = "";
      try {
        detail = JSON.parse(text)?.error?.message ?? "";
      } catch {
        /* Non-JSON errors are never presented as HTML. */
      }
      const label =
        response.status === 401 || response.status === 403
          ? "API 认证失败，请检查 Key 和模型权限。"
          : response.status === 429
            ? "接口请求受限或额度不足，请稍后重试。"
            : response.status === 404
              ? "接口或模型不存在，请检查 API 地址和模型名。"
              : `模型接口返回 HTTP ${response.status}。`;
      throw new AppError(
        `${label}${typeof detail === "string" && detail ? ` ${detail.slice(0, 600)}` : ""}`,
        "MODEL_API_ERROR",
        502,
      );
    }
    return { response, signal: combined };
  } catch (error) {
    requestFailure(error, signal, combined, browserMode);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(
      "接口返回了无效 JSON，请确认使用 Chat Completions 兼容服务。",
      "MODEL_PROTOCOL_ERROR",
      502,
    );
  }
}

function usageOf(usage) {
  if (
    !usage ||
    !Number.isFinite(usage.prompt_tokens) ||
    !Number.isFinite(usage.completion_tokens)
  )
    return null;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens:
      usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
  };
}

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function invalidCompletion() {
  return new AppError(
    "接口返回的对话数据格式无效，请检查 Chat Completions 兼容性。",
    "MODEL_PROTOCOL_ERROR",
    502,
  );
}

function appendToolCalls(calls, tools, delta) {
  for (const [position, tool] of tools.entries()) {
    if (
      !isRecord(tool) ||
      (tool.function !== undefined && !isRecord(tool.function))
    )
      throw invalidCompletion();
    const index = delta ? tool.index : position;
    if (!Number.isInteger(index) || index < 0 || index >= 128)
      throw new AppError("模型工具调用索引无效。", "MODEL_PROTOCOL_ERROR", 502);
    const current = calls.get(index) ?? {
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    };
    if (tool.id) current.id += tool.id;
    if (tool.function?.name) current.function.name += tool.function.name;
    if (tool.function?.arguments)
      current.function.arguments += tool.function.arguments;
    calls.set(index, current);
  }
}

function completionAccumulator(emit) {
  let content = "";
  const calls = new Map();
  let finishReason;
  let usage = null;
  const consume = (part, delta) => {
    if (
      !isRecord(part) ||
      (part.choices !== undefined && !Array.isArray(part.choices))
    )
      throw invalidCompletion();
    if (part.error)
      throw new AppError(
        String(part.error.message ?? "模型返回流式错误。"),
        "MODEL_API_ERROR",
        502,
      );
    if (part.usage) usage = usageOf(part.usage);
    const choice = part.choices?.[0];
    if (choice === undefined) return;
    if (!isRecord(choice)) throw invalidCompletion();
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const value = delta ? choice.delta : choice.message;
    if (value === undefined) return;
    if (
      !isRecord(value) ||
      (value.tool_calls !== undefined && !Array.isArray(value.tool_calls))
    )
      throw invalidCompletion();
    if (typeof value.refusal === "string" && value.refusal)
      throw new AppError(value.refusal, "MODEL_REFUSAL", 422);
    if (typeof value.content === "string") {
      content += value.content;
      emit("token", { text: value.content });
    }
    appendToolCalls(calls, value.tool_calls ?? [], delta);
  };
  const finish = () => {
    if (!finishReason)
      throw new AppError(
        "模型响应中断，尚未完整结束，请重试。",
        "MODEL_STREAM_INTERRUPTED",
        502,
      );
    if (finishReason === "length")
      throw new AppError(
        "模型输出达到服务商长度限制，当前回复可能不完整。",
        "MODEL_OUTPUT_LIMIT",
        502,
      );
    if (finishReason === "content_filter")
      throw new AppError("模型服务未提供本次回复。", "MODEL_REFUSAL", 422);
    for (const call of calls.values()) {
      if (!call.id || !call.function.name)
        throw new AppError(
          "模型返回了不完整的工具调用，请重试。",
          "MODEL_PROTOCOL_ERROR",
          502,
        );
    }
    return { content, tool_calls: [...calls.values()], usage };
  };
  return { consume, finish };
}

async function consumeEvents(response, signal, consume) {
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let ended = false;
  const drain = (final = false) => {
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(buffer);
      if (!match) break;
      const event = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = event
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data.trim() === "[DONE]") {
        ended = true;
        buffer = "";
        return;
      }
      consume(parseJson(data), true);
    }
    if (final && buffer.trim()) {
      buffer += "\n\n";
      drain();
    }
  };
  for await (const chunk of responseChunks(response, signal)) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) throw responseTooLarge();
    buffer += decoder.decode(chunk, { stream: true });
    drain();
    if (ended) break;
  }
  if (!ended) {
    buffer += decoder.decode();
    drain(true);
  }
}

/** Shared Chat Completions protocol for local agents and direct browser chat. */
export async function completion(
  config,
  messages,
  {
    tools,
    signal,
    emit = () => {},
    fetchImpl = fetch,
    browserMode = false,
  } = {},
) {
  const context = await request(
    config,
    {
      messages,
      ...(tools === undefined ? {} : { tools }),
      stream: true,
    },
    { signal, fetchImpl, browserMode },
  );
  const { response } = context;
  const accumulator = completionAccumulator(emit);
  try {
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      await consumeEvents(response, context.signal, accumulator.consume);
    } else {
      const payload = parseJson(await boundedText(response, context.signal));
      accumulator.consume(payload, false);
      if (!payload.choices?.[0]?.message)
        throw new AppError(
          "接口未返回对话结果，请检查 API 类型。",
          "MODEL_PROTOCOL_ERROR",
          502,
        );
    }
    return accumulator.finish();
  } catch (error) {
    requestFailure(error, signal, context.signal, browserMode);
  }
}

export async function testConnection(
  config,
  { signal, fetchImpl = fetch, browserMode = false } = {},
) {
  const start = performance.now();
  const context = await request(
    config,
    {
      messages: [{ role: "user", content: "这是 API 连接测试。请只回复 OK。" }],
      stream: false,
    },
    { signal, fetchImpl, browserMode },
  );
  try {
    const data = parseJson(await boundedText(context.response, context.signal));
    if (typeof data.choices?.[0]?.message?.content !== "string")
      throw new AppError(
        "接口可连接，但未返回文本消息，请检查模型与接口类型。",
        "MODEL_PROTOCOL_ERROR",
        502,
      );
    return {
      ok: true,
      message: "模型连接成功",
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (error) {
    requestFailure(error, signal, context.signal, browserMode);
  }
}
