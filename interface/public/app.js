import { createBrowserClient } from "./browser-client.js";

const browserMode = document.documentElement.dataset.mode === "browser";
const browserClient = browserMode ? createBrowserClient() : null;
const $ = (selector) => document.querySelector(selector);
const storageKey = browserMode
  ? "chaichai.web.conversations.v1"
  : "chaichai.interface.conversations.v1";
const svgNamespace = "http://www.w3.org/2000/svg";
const ui = {
  sidebar: $("#sidebar"),
  backdrop: $("#sidebar-backdrop"),
  list: $("#conversation-list"),
  title: $("#conversation-title"),
  welcome: $("#welcome"),
  messages: $("#messages"),
  scroll: $("#scroll-area"),
  input: $("#message-input"),
  send: $("#send-button"),
  stop: $("#stop-button"),
  generation: $("#generation-status"),
  dialog: $("#settings-dialog"),
  form: $("#settings-form"),
  baseUrl: $("#base-url"),
  apiKey: $("#api-key"),
  model: $("#model-name"),
  feedback: $("#settings-feedback"),
  test: $("#test-connection"),
  save: $("#save-settings"),
  forget: $("#forget-config"),
};
const state = {
  conversations: [],
  activeId: null,
  config: null,
  mcp: { status: "idle", toolCount: 0 },
  connected: false,
  run: null,
  renderFrame: null,
  toastTimer: null,
  saveTimer: null,
  settingsBusy: false,
  storageUnreadable: false,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name, className = "icon") {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svgNamespace, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function actionButton(label, iconName, handler) {
  const button = element("button", "icon-button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName));
  button.addEventListener("click", handler);
  return button;
}

function toast(message) {
  const node = $("#toast");
  clearTimeout(state.toastTimer);
  node.textContent = message;
  node.hidden = false;
  state.toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

function newId() {
  return crypto.randomUUID();
}

function activeConversation() {
  return state.conversations.find(
    (conversation) => conversation.id === state.activeId,
  );
}

function readHistory() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    if (parsed.version !== 1 || !Array.isArray(parsed.conversations))
      throw new Error("记录格式无法识别");
    for (const conversation of parsed.conversations) {
      if (
        !conversation ||
        typeof conversation.id !== "string" ||
        !Array.isArray(conversation.messages)
      )
        throw new Error("记录格式不完整");
      if (
        conversation.messages.some(
          (message) =>
            !message ||
            !["user", "assistant"].includes(message.role) ||
            typeof message.content !== "string",
        )
      )
        throw new Error("消息格式不完整");
    }
    state.conversations = parsed.conversations.map((conversation) => ({
      id: conversation.id,
      title:
        typeof conversation.title === "string"
          ? conversation.title
          : "历史对话",
      createdAt:
        typeof conversation.createdAt === "number"
          ? conversation.createdAt
          : Date.now(),
      draft: typeof conversation.draft === "string" ? conversation.draft : "",
      messages: conversation.messages.map((message) => ({
        id: typeof message.id === "string" ? message.id : newId(),
        role: message.role,
        content: message.content,
        tools: Array.isArray(message.tools)
          ? message.tools
              .filter(
                (tool) =>
                  tool &&
                  typeof tool.id === "string" &&
                  typeof tool.name === "string",
              )
              .map((tool) => ({
                ...tool,
                status: ["running", "awaiting"].includes(tool.status)
                  ? "interrupted"
                  : tool.status,
                approval: ["pending", "submitting"].includes(tool.approval)
                  ? "expired"
                  : tool.approval,
              }))
          : [],
        status: message.status === "streaming" ? "interrupted" : message.status,
        error: typeof message.error === "string" ? message.error : undefined,
        usage: message.usage,
      })),
    }));
    state.activeId = state.conversations.some(
      (conversation) => conversation.id === parsed.activeId,
    )
      ? parsed.activeId
      : state.conversations[0]?.id;
  } catch {
    state.storageUnreadable = true;
    toast("本地记录暂时无法读取，原始记录已保留。本次对话不会覆盖它。");
  }
}

function saveHistory() {
  clearTimeout(state.saveTimer);
  if (state.storageUnreadable) return;
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        activeId: state.activeId,
        conversations: state.conversations,
      }),
    );
  } catch {
    toast("浏览器无法保存更多记录，请导出重要对话。当前对话仍可继续。");
  }
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveHistory, 600);
}

function setSidebar(open) {
  ui.sidebar.classList.toggle("open", open);
  ui.backdrop.hidden = !open;
  $("#toggle-sidebar").setAttribute("aria-expanded", String(open));
}

function createConversation() {
  const current = activeConversation();
  if (current && current.messages.length === 0 && !current.draft) {
    setSidebar(false);
    ui.input.focus();
    return current;
  }
  const conversation = {
    id: newId(),
    title: "新对话",
    createdAt: Date.now(),
    messages: [],
    draft: "",
  };
  state.conversations.unshift(conversation);
  selectConversation(conversation.id);
  return conversation;
}

function selectConversation(id) {
  state.activeId = id;
  ui.input.value = activeConversation()?.draft || "";
  resizeInput();
  renderConversationList();
  renderConversation();
  updateRunControls();
  saveHistory();
  setSidebar(false);
  ui.input.focus();
}

function renderConversationList() {
  ui.list.replaceChildren();
  const visible = state.conversations.filter(
    (conversation) => conversation.messages.length > 0,
  );
  if (!visible.length) {
    ui.list.append(
      element("p", "history-empty", "从一个问题开始\n对话会保存在这里"),
    );
    return;
  }
  for (const conversation of visible) {
    const row = element(
      "div",
      `conversation-row${conversation.id === state.activeId ? " active" : ""}`,
    );
    const select = element("button", "conversation-select");
    select.type = "button";
    select.title = conversation.title;
    if (conversation.id === state.activeId)
      select.setAttribute("aria-current", "page");
    select.append(icon("chat"), element("span", "", conversation.title));
    select.addEventListener("click", () => selectConversation(conversation.id));
    const remove = actionButton(
      `删除对话：${conversation.title}`,
      "trash",
      async () => {
        if (state.run?.conversationId === conversation.id) {
          toast("请先停止这段对话的分析，再删除记录。");
          return;
        }
        if (!window.confirm("删除这段对话及其本地记录？此操作无法撤销。"))
          return;
        remove.disabled = true;
        try {
          await api("/api/conversation/delete", {
            method: "POST",
            body: { conversationId: conversation.id },
          });
        } catch (error) {
          toast(`暂时无法删除：${error.message}`);
          remove.disabled = false;
          return;
        }
        state.conversations = state.conversations.filter(
          (item) => item.id !== conversation.id,
        );
        if (state.activeId === conversation.id) {
          if (state.conversations.length)
            selectConversation(state.conversations[0].id);
          else {
            state.activeId = null;
            createConversation();
          }
        }
        renderConversationList();
        saveHistory();
      },
    );
    remove.className = "conversation-delete";
    row.append(select, remove);
    ui.list.append(row);
  }
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// Model output is always assembled as DOM text. No model HTML is interpreted.
function appendInline(parent, text, depth = 0) {
  if (depth > 4) {
    parent.append(document.createTextNode(text));
    return;
  }
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`"))
      parent.append(element("code", "", token.slice(1, -1)));
    else if (token.startsWith("**")) {
      const strong = element("strong");
      appendInline(strong, token.slice(2, -2), depth + 1);
      parent.append(strong);
    } else if (token.startsWith("*")) {
      const em = element("em");
      appendInline(em, token.slice(1, -1), depth + 1);
      parent.append(em);
    } else {
      const split = token.indexOf("](");
      const href = safeLink(token.slice(split + 2, -1));
      if (href) {
        const anchor = element("a", "", token.slice(1, split));
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        parent.append(anchor);
      } else parent.append(document.createTextNode(token));
    }
    last = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(last)));
}

function markdown(content) {
  const fragment = document.createDocumentFragment();
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3).trim();
      const codeLines = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index]))
        codeLines.push(lines[index++]);
      if (index < lines.length) index++;
      const pre = element("pre");
      if (language) pre.setAttribute("aria-label", `${language} 代码`);
      pre.append(element("code", "", codeLines.join("\n")));
      fragment.append(pre);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const node = element(`h${heading[1].length}`);
      appendInline(node, heading[2]);
      fragment.append(node);
      index++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      fragment.append(element("hr"));
      index++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = element("blockquote");
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        if (quote.childNodes.length) quote.append(element("br"));
        appendInline(quote, lines[index++].replace(/^\s*>\s?/, ""));
      }
      fragment.append(quote);
      continue;
    }
    const listMatch = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = Boolean(listMatch[2]);
      const list = element(ordered ? "ol" : "ul");
      if (ordered && listMatch[2] !== "1") list.start = Number(listMatch[2]);
      while (index < lines.length) {
        const item = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index]);
        if (!item || Boolean(item[2]) !== ordered) break;
        const li = element("li");
        appendInline(li, item[3]);
        list.append(li);
        index++;
      }
      fragment.append(list);
      continue;
    }
    const paragraph = element("p");
    appendInline(paragraph, line);
    index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(?:```|#{1,4}\s|>\s?|[-+*]\s|\d+\.\s|([-*_])\1{2,}\s*$)/.test(
        lines[index],
      )
    ) {
      paragraph.append(element("br"));
      appendInline(paragraph, lines[index++]);
    }
    fragment.append(paragraph);
  }
  return fragment;
}

function jsonText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "无";
  } catch {
    return "结果无法显示";
  }
}

function renderTool(tool) {
  const details = element("details", "tool-call");
  details.dataset.toolId = tool.id;
  const summary = element("summary");
  const labels = {
    running: "调用中",
    success: "已完成",
    error: "调用失败",
    interrupted: "已中断",
    awaiting: "待确认",
  };
  summary.append(
    icon("tool"),
    element("span", "tool-name", tool.name),
    element("span", "tool-status", labels[tool.status] || "已记录"),
    icon("chevron", "icon tool-chevron"),
  );
  const body = element("div", "tool-content");
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    body.append(
      element("p", "tool-content-label", "调用参数"),
      element("pre", "tool-json", jsonText(tool.arguments)),
    );
    if (tool.result !== undefined)
      body.append(
        element("p", "tool-content-label", "工具结果"),
        element("pre", "tool-json", jsonText(tool.result)),
      );
  };
  details.addEventListener("toggle", () => {
    if (details.open) fill();
  });
  details.append(summary, body);
  return details;
}

function renderApproval(tool, conversationId) {
  const approval = element("div", "approval");
  approval.append(
    element("p", "", "此工具需要你的确认"),
    element("strong", "", tool.name),
  );
  if (tool.description) approval.append(element("p", "", tool.description));
  approval.append(element("pre", "tool-json", jsonText(tool.arguments)));
  const controls = element("div", "approval-actions");
  for (const [approved, label] of [
    [false, "拒绝"],
    [true, "允许本次调用"],
  ]) {
    const button = element(
      "button",
      `button ${approved ? "button-primary" : "button-secondary"}`,
      label,
    );
    button.type = "button";
    button.addEventListener("click", async () => {
      if (tool.approval !== "pending") return;
      tool.approval = "submitting";
      for (const child of controls.children) child.disabled = true;
      try {
        await api("/api/approval", {
          method: "POST",
          body: { conversationId, id: tool.id, approved },
        });
        tool.approval = approved ? "approved" : "denied";
        approval.replaceChildren(
          element(
            "span",
            "approval-result",
            approved ? "已允许本次调用" : "已拒绝本次调用",
          ),
        );
        saveHistory();
      } catch (error) {
        tool.approval = "pending";
        toast(error.message);
        for (const child of controls.children) child.disabled = false;
      }
    });
    controls.append(button);
  }
  approval.append(controls);
  return approval;
}

function renderMessage(message, conversationId) {
  const article = element("article", `message message-${message.role}`);
  article.dataset.messageId = message.id;
  article.dataset.viewKey = messageViewKey(message);
  const heading = element("div", "message-heading");
  heading.append(
    message.role === "assistant"
      ? icon("mark", "assistant-mark")
      : element("span", "user-avatar", "我"),
    element("span", "", message.role === "assistant" ? "拆拆" : "你"),
  );
  article.append(heading);
  if (message.tools?.length) {
    const tools = element("div", "tool-list");
    for (const tool of message.tools) {
      tools.append(renderTool(tool));
      if (
        tool.approval === "pending" &&
        state.run?.conversationId === conversationId
      )
        tools.append(renderApproval(tool, conversationId));
      else if (tool.approval === "submitting")
        tools.append(element("p", "message-interrupted", "正在提交你的确认…"));
      else if (tool.approval === "pending")
        tools.append(
          element("p", "message-interrupted", "此前的确认请求已失效。"),
        );
    }
    article.append(tools);
  }
  const content = element("div", "message-content");
  if (message.role === "user") content.textContent = message.content;
  else if (message.content) content.append(markdown(message.content));
  else if (message.status === "streaming") {
    const placeholder = element("span", "assistant-placeholder");
    placeholder.setAttribute("aria-label", "正在思考");
    placeholder.append(element("i"), element("i"), element("i"));
    content.append(placeholder);
  }
  article.append(content);
  if (message.error)
    article.append(element("p", "message-error", message.error));
  if (["cancelled", "interrupted"].includes(message.status))
    article.append(
      element(
        "p",
        "message-interrupted",
        message.status === "cancelled"
          ? "已停止生成"
          : "上次分析已中断，可继续提问。",
      ),
    );
  if (
    message.role === "assistant" &&
    message.status !== "streaming" &&
    message.content
  ) {
    const actions = element("div", "message-actions");
    actions.append(
      actionButton("复制回复", "copy", async () => {
        try {
          await navigator.clipboard.writeText(message.content);
          toast("回复已复制");
        } catch {
          toast("复制失败，请选择回复内容后复制。");
        }
      }),
    );
    const total = message.usage?.totalTokens;
    if (typeof total === "number" && Number.isFinite(total))
      actions.append(
        element("span", "message-meta", `${total.toLocaleString()} tokens`),
      );
    article.append(actions);
  }
  return article;
}

function messageViewKey(message) {
  return `${message.status}|${message.error || ""}|${message.usage?.totalTokens ?? ""}|${(message.tools || []).map((tool) => `${tool.id}:${tool.status}:${tool.approval || ""}`).join("|")}`;
}

function renderConversation() {
  const conversation = activeConversation();
  const hasMessages = Boolean(conversation?.messages.length);
  ui.welcome.hidden = hasMessages;
  ui.messages.hidden = !hasMessages;
  ui.title.textContent = conversation?.title || "新对话";
  $("#export-chat").hidden = !hasMessages;
  ui.messages.replaceChildren();
  if (conversation)
    for (const message of conversation.messages)
      ui.messages.append(renderMessage(message, conversation.id));
  ui.scroll.scrollTop = ui.scroll.scrollHeight;
}

function updateMessage(message, conversationId, { force = false } = {}) {
  if (state.activeId !== conversationId) return;
  if (state.renderFrame && !force) return;
  if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
  const render = () => {
    state.renderFrame = null;
    if (state.activeId !== conversationId) return;
    const nearBottom =
      ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight <
      120;
    const old = Array.from(ui.messages.children).find(
      (node) => node.dataset.messageId === message.id,
    );
    if (old?.dataset.viewKey === messageViewKey(message)) {
      const content = old.querySelector(".message-content");
      if (message.content) content.replaceChildren(markdown(message.content));
      if (nearBottom) ui.scroll.scrollTop = ui.scroll.scrollHeight;
      return;
    }
    const openTools = old
      ? Array.from(old.querySelectorAll("details[open]")).map(
          (node) => node.dataset.toolId,
        )
      : [];
    const next = renderMessage(message, conversationId);
    for (const details of next.querySelectorAll("details"))
      if (openTools.includes(details.dataset.toolId)) details.open = true;
    if (old) old.replaceWith(next);
    else ui.messages.append(next);
    if (nearBottom) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  };
  if (force) render();
  else state.renderFrame = requestAnimationFrame(render);
}

function updateRunControls() {
  const running = Boolean(state.run);
  ui.send.hidden = running;
  ui.stop.hidden = !running;
  ui.stop.disabled = Boolean(state.run?.stopping);
  ui.send.disabled = !ui.input.value.trim() || state.settingsBusy;
  ui.input.setAttribute("aria-busy", String(running));
  if (!running) ui.generation.textContent = "";
  else if (state.run.conversationId !== state.activeId)
    ui.generation.textContent =
      "另一段对话正在分析，你可以在此准备下一个问题。";
  else ui.generation.textContent = state.run.status || "正在思考…";
}

function resizeInput() {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(180, Math.max(53, ui.input.scrollHeight))}px`;
  updateRunControls();
}

async function api(path, { method = "GET", body, signal } = {}) {
  if (browserClient) return browserClient.api(path, { method, body, signal });
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      signal,
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : { "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error.name === "TimeoutError")
      throw new Error("本地服务响应超时，请重试。");
    if (error.name === "AbortError") throw error;
    throw new Error("无法连接本地服务，请确认服务仍在运行后重试。");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? "本地服务返回了无法识别的内容，请重试。"
        : `本地服务请求失败（${response.status}），请重试。`,
    );
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("本地服务返回了无法识别的内容，请重试。");
  if (!response.ok || result.error)
    throw new Error(result.error?.message || `请求失败（${response.status}）`);
  return result;
}

function renderConnection() {
  const configured = Boolean(state.config?.baseUrl && state.config?.model);
  $("#model-label").textContent = configured ? state.config.model : "配置模型";
  $("#model-button").title = configured
    ? `当前模型：${state.config.model}，点击修改配置`
    : "配置你的 API 和模型";
  $("#sidebar-config-dot").className =
    `status-dot${configured ? " ready" : ""}`;
  const ready = state.mcp.status === "ready";
  const label = browserMode
    ? "网页对话"
    : ready
      ? `${state.mcp.toolCount} 个工具就绪`
      : state.mcp.status === "error"
        ? "工具连接异常"
        : "工具待连接";
  $("#tools-status").replaceChildren(
    element(
      "span",
      `status-dot${ready ? " ready" : state.mcp.status === "error" ? " error" : ""}`,
    ),
    element("span", "", label),
  );
  $("#tools-status").title = state.mcp.message || label;
  $("#settings-tools-status").textContent =
    state.mcp.message ||
    (ready ? `已连接 · ${state.mcp.toolCount} 个工具可用` : label);
  ui.forget.hidden = !configured;
}

async function refreshState() {
  $("#retry-connection").disabled = true;
  try {
    const result = await api("/api/state");
    if (
      !result.config ||
      !result.mcp ||
      typeof result.config.baseUrl !== "string" ||
      typeof result.config.model !== "string"
    )
      throw new Error("本地服务状态格式不完整。");
    state.config = result.config;
    state.mcp = result.mcp;
    state.connected = true;
    $("#connection-banner").hidden = true;
    renderConnection();
  } catch (error) {
    state.connected = false;
    $("#connection-message").textContent = browserMode
      ? `网页状态初始化失败。${error.message}`
      : `暂时无法连接本地服务。${error.message}`;
    $("#connection-banner").hidden = false;
    $("#tools-status").replaceChildren(
      element("span", "status-dot error"),
      element("span", "", browserMode ? "网页初始化失败" : "服务未连接"),
    );
    $("#settings-tools-status").textContent = browserMode
      ? "网页状态初始化失败"
      : "本地服务未连接";
  } finally {
    $("#retry-connection").disabled = false;
  }
}

function setFeedback(message, success = false) {
  ui.feedback.textContent = message;
  ui.feedback.classList.toggle("success", success);
  ui.feedback.hidden = !message;
}

function updateKeyHint() {
  const sameAddress =
    ui.baseUrl.value.trim().replace(/\/+$/, "") ===
    (state.config?.baseUrl || "").replace(/\/+$/, "");
  const retained = sameAddress && state.config?.hasApiKey;
  ui.apiKey.placeholder = retained
    ? "已配置 · 留空可继续使用"
    : "输入你的 API Key";
  const memory = browserMode
    ? "当前页面内存中，刷新后需重填"
    : "本次本地服务内存中";
  $("#key-hint").textContent = retained
    ? `此地址已有 Key。留空保留，填写可替换；Key 仅保留在${memory}。`
    : `Key 仅保留在${memory}。`;
}

function openSettings() {
  ui.baseUrl.value = state.config?.baseUrl || "";
  ui.model.value = state.config?.model || "";
  ui.apiKey.value = "";
  ui.apiKey.type = "password";
  $("#toggle-key").setAttribute("aria-pressed", "false");
  $("#toggle-key").setAttribute("aria-label", "显示 API Key");
  for (const input of [ui.baseUrl, ui.model])
    input.removeAttribute("aria-invalid");
  setFeedback("");
  updateKeyHint();
  setSidebar(false);
  if (!ui.dialog.open) ui.dialog.showModal();
}

function closeSettings() {
  ui.apiKey.value = "";
  ui.dialog.close();
}

function configInput() {
  const baseUrl = ui.baseUrl.value.trim();
  const model = ui.model.value.trim();
  for (const input of [ui.baseUrl, ui.model])
    input.removeAttribute("aria-invalid");
  let validUrl = false;
  try {
    validUrl = ["http:", "https:"].includes(new URL(baseUrl).protocol);
  } catch {
    /* Feedback below owns invalid values. */
  }
  if (!validUrl) {
    ui.baseUrl.setAttribute("aria-invalid", "true");
    ui.baseUrl.focus();
    throw new Error("请填写完整的 http:// 或 https:// API 地址。");
  }
  if (!model) {
    ui.model.setAttribute("aria-invalid", "true");
    ui.model.focus();
    throw new Error("请填写服务商提供的模型名称。");
  }
  const apiKey = ui.apiKey.value.trim();
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

function settingsBusy(busy) {
  state.settingsBusy = busy;
  for (const node of [
    ui.baseUrl,
    ui.model,
    ui.apiKey,
    ui.save,
    ui.test,
    ui.forget,
  ])
    node.disabled = busy;
  updateRunControls();
}

async function saveSettings(event) {
  event.preventDefault();
  if (state.settingsBusy) return;
  let body;
  try {
    body = configInput();
  } catch (error) {
    setFeedback(error.message);
    return;
  }
  settingsBusy(true);
  setFeedback("正在保存配置…");
  try {
    const result = await api("/api/config", { method: "POST", body });
    state.config = result.config;
    ui.apiKey.value = "";
    renderConnection();
    closeSettings();
    toast("API 配置已保存，可以开始对话。");
    await refreshState();
    ui.input.focus();
  } catch (error) {
    setFeedback(error.message);
  } finally {
    settingsBusy(false);
  }
}

async function testConnection() {
  if (state.settingsBusy) return;
  let body;
  try {
    body = configInput();
  } catch (error) {
    setFeedback(error.message);
    return;
  }
  settingsBusy(true);
  ui.test.textContent = "测试中…";
  setFeedback("正在测试模型连接…");
  try {
    const result = await api("/api/test", { method: "POST", body });
    const latency =
      typeof result.latencyMs === "number"
        ? ` · ${Math.round(result.latencyMs).toLocaleString()} ms`
        : "";
    if (!result.ok) throw new Error(result.message || "连接测试未通过。");
    setFeedback(
      `${result.message || "连接成功"}${latency}。配置尚未保存。`,
      true,
    );
  } catch (error) {
    setFeedback(error.message);
  } finally {
    settingsBusy(false);
    ui.test.textContent = "测试连接";
  }
}

async function forgetConfiguration() {
  if (state.settingsBusy) return;
  settingsBusy(true);
  try {
    await api("/api/config", { method: "DELETE" });
    state.config = { baseUrl: "", model: "", hasApiKey: false };
    ui.baseUrl.value = "";
    ui.model.value = "";
    ui.apiKey.value = "";
    updateKeyHint();
    renderConnection();
    setFeedback("配置与内存中的 Key 已清除。", true);
  } catch (error) {
    setFeedback(error.message);
  } finally {
    settingsBusy(false);
  }
}

function parseEvent(block) {
  let type = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:"))
      data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  try {
    return { type, data: JSON.parse(data.join("\n")) };
  } catch {
    throw new Error("本地服务返回了无法识别的流式事件，请重试。");
  }
}

async function readEventStream(response, onEvent) {
  if (!response.body) throw new Error("浏览器未收到回复内容，请重试。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingCR = false;
  function normalize(chunk) {
    const text = (pendingCR ? "\r" : "") + chunk;
    pendingCR = text.endsWith("\r");
    return (pendingCR ? text.slice(0, -1) : text).replace(/\r\n?/g, "\n");
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += normalize(decoder.decode(value, { stream: !done }));
      if (done && pendingCR) {
        buffer += "\n";
        pendingCR = false;
      }
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEvent(block);
        if (event) onEvent(event);
      }
      if (done) {
        const event = parseEvent(buffer);
        if (event) onEvent(event);
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function sendMessage(event) {
  event?.preventDefault();
  if (state.run || state.settingsBusy) return;
  const text = ui.input.value.trim();
  if (!text) return;
  if (!state.config?.baseUrl || !state.config?.model) {
    openSettings();
    return;
  }
  const conversation = activeConversation() || createConversation();
  const history = conversation.messages
    .filter(
      (message) =>
        ["user", "assistant"].includes(message.role) && message.content,
    )
    .map(({ role, content }) => ({ role, content }));
  const userMessage = { id: newId(), role: "user", content: text };
  const assistant = {
    id: newId(),
    role: "assistant",
    content: "",
    tools: [],
    status: "streaming",
  };
  if (!conversation.messages.length)
    conversation.title = text.replace(/\s+/g, " ").slice(0, 28);
  conversation.messages.push(userMessage, assistant);
  conversation.draft = "";
  ui.input.value = "";
  resizeInput();
  const controller = new AbortController();
  const run = {
    conversationId: conversation.id,
    assistantId: assistant.id,
    controller,
    status: "正在思考…",
    stopping: false,
    complete: false,
  };
  state.run = run;
  renderConversationList();
  renderConversation();
  updateRunControls();
  saveHistory();
  const onEvent = ({ type, data }) => {
    if (!data || typeof data !== "object") return;
    if (type === "status" && typeof data.message === "string")
      run.status = data.message;
    else if (type === "token" && typeof data.text === "string") {
      assistant.content += data.text;
      run.status = "正在整理回复…";
    } else if (
      ["tool_start", "tool_result", "approval_required"].includes(type) &&
      typeof data.id === "string" &&
      typeof data.name === "string"
    ) {
      let tool = assistant.tools.find((item) => item.id === data.id);
      if (!tool) {
        tool = { id: data.id, name: data.name };
        assistant.tools.push(tool);
      }
      if (type === "tool_start") {
        tool.arguments = data.arguments;
        tool.status = "running";
        run.status = `正在调用 ${data.name}…`;
      } else if (type === "tool_result") {
        tool.result = data.result;
        tool.status = data.isError ? "error" : "success";
        if (tool.approval === "pending") tool.approval = "expired";
        run.status = data.isError
          ? "工具返回了错误，正在整理结果…"
          : "工具调用完成，继续分析…";
      } else {
        tool.arguments = data.arguments;
        tool.status = "awaiting";
        tool.approval = "pending";
        tool.description = data.description;
        run.status = "等待你确认工具调用…";
      }
    } else if (type === "usage") assistant.usage = data;
    else if (type === "done") {
      if (typeof data.message === "string" && data.message)
        assistant.content = data.message;
      if (data.usage) assistant.usage = data.usage;
      assistant.status = "complete";
      run.complete = true;
    } else if (type === "error") {
      assistant.error =
        typeof data.message === "string"
          ? data.message
          : "分析遇到问题，请重试。";
      assistant.status = "error";
      run.complete = true;
    } else if (type === "cancelled") {
      assistant.status = "cancelled";
      run.complete = true;
    }
    updateMessage(assistant, conversation.id);
    updateRunControls();
  };
  try {
    const input = { conversationId: conversation.id, message: text, history };
    if (browserClient) {
      await browserClient.chat(input, { signal: controller.signal, onEvent });
    } else {
      const response = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        let message = `请求失败（${response.status}），请重试。`;
        try {
          const result = await response.json();
          message = result.error?.message || message;
        } catch {
          /* Use HTTP error text. */
        }
        throw new Error(message);
      }
      await readEventStream(response, onEvent);
    }
    if (!run.complete) {
      assistant.status = run.stopping ? "cancelled" : "error";
      if (!run.stopping)
        assistant.error =
          "连接在分析完成前中断，已保留收到的内容。你可以继续提问。";
    }
  } catch (error) {
    controller.abort();
    assistant.status =
      run.stopping || error.name === "AbortError" ? "cancelled" : "error";
    if (assistant.status === "error")
      assistant.error =
        error instanceof TypeError
          ? "无法连接本地服务，请确认服务仍在运行后重试。"
          : error.message || "连接中断，请检查本地服务后重试。";
  } finally {
    for (const tool of assistant.tools) {
      if (tool.status === "running" || tool.status === "awaiting")
        tool.status = "interrupted";
      if (tool.approval === "pending" || tool.approval === "submitting")
        tool.approval = "expired";
    }
    if (state.run === run) state.run = null;
    updateMessage(assistant, conversation.id, { force: true });
    updateRunControls();
    saveHistory();
  }
}

async function stopGeneration() {
  const run = state.run;
  if (!run || run.stopping) return;
  run.stopping = true;
  run.status = "正在停止…";
  updateRunControls();
  try {
    await api("/api/cancel", {
      method: "POST",
      body: { conversationId: run.conversationId },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    toast(`停止请求未确认：${error.message}`);
  } finally {
    run.controller.abort();
  }
}

function exportConversation() {
  const conversation = activeConversation();
  if (!conversation?.messages.length) return;
  const parts = [
    `# ${conversation.title}`,
    `导出时间：${new Date().toLocaleString("zh-CN")}`,
  ];
  for (const message of conversation.messages) {
    parts.push(
      `## ${message.role === "user" ? "你" : "拆拆"}`,
      message.content,
    );
    for (const tool of message.tools || [])
      parts.push(
        `### 工具：${tool.name}`,
        `状态：${tool.status}`,
        "调用参数：",
        `\n\`\`\`json\n${jsonText(tool.arguments)}\n\`\`\``,
        ...(tool.result === undefined
          ? []
          : ["工具结果：", `\n\`\`\`json\n${jsonText(tool.result)}\n\`\`\``]),
      );
    if (message.error) parts.push(`错误：${message.error}`);
  }
  const blob = new Blob([parts.join("\n\n")], {
    type: "text/markdown;charset=utf-8",
  });
  const href = URL.createObjectURL(blob);
  const anchor = element("a");
  anchor.href = href;
  anchor.download = `拆拆-${conversation.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 50)}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

$("#new-chat").addEventListener("click", createConversation);
$("#toggle-sidebar").addEventListener("click", () =>
  setSidebar(!ui.sidebar.classList.contains("open")),
);
ui.backdrop.addEventListener("click", () => setSidebar(false));
for (const selector of ["#open-settings", "#model-button", "#footer-settings"])
  $(selector).addEventListener("click", openSettings);
$("#close-settings").addEventListener("click", closeSettings);
ui.dialog.addEventListener("close", () => {
  ui.apiKey.value = "";
});
ui.dialog.addEventListener("click", (event) => {
  if (event.target !== ui.dialog) return;
  const rect = ui.dialog.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    closeSettings();
});
ui.form.addEventListener("submit", saveSettings);
ui.test.addEventListener("click", testConnection);
ui.forget.addEventListener("click", forgetConfiguration);
ui.baseUrl.addEventListener("input", updateKeyHint);
$("#toggle-key").addEventListener("click", () => {
  const visible = ui.apiKey.type === "password";
  ui.apiKey.type = visible ? "text" : "password";
  $("#toggle-key").setAttribute("aria-pressed", String(visible));
  $("#toggle-key").setAttribute(
    "aria-label",
    visible ? "隐藏 API Key" : "显示 API Key",
  );
});
$("#retry-connection").addEventListener("click", refreshState);
$("#composer").addEventListener("submit", sendMessage);
ui.stop.addEventListener("click", stopGeneration);
$("#export-chat").addEventListener("click", exportConversation);
ui.input.addEventListener("input", () => {
  const conversation = activeConversation();
  if (conversation) conversation.draft = ui.input.value;
  resizeInput();
  scheduleSave();
});
ui.input.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    sendMessage();
  }
});
for (const button of document.querySelectorAll(".suggestion"))
  button.addEventListener("click", () => {
    ui.input.value = button.dataset.prompt || "";
    const conversation = activeConversation();
    if (conversation) conversation.draft = ui.input.value;
    resizeInput();
    scheduleSave();
    ui.input.focus();
  });
document.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k" &&
    !ui.dialog.open
  ) {
    event.preventDefault();
    createConversation();
  }
  if (event.key === "Escape") setSidebar(false);
});
window.addEventListener("pagehide", saveHistory);

if (browserMode) {
  document.title = "拆拆 · 网页对话工作台";
  for (const node of document.querySelectorAll("[data-browser-text]"))
    node.textContent = node.dataset.browserText;
  for (const node of document.querySelectorAll("[data-browser-placeholder]"))
    node.placeholder = node.dataset.browserPlaceholder;
  for (const node of document.querySelectorAll("[data-browser-prompt]"))
    node.dataset.prompt = node.dataset.browserPrompt;
  $("#browser-mode-note").hidden = false;
}

readHistory();
if (!state.conversations.length) createConversation();
else selectConversation(state.activeId || state.conversations[0].id);
refreshState();
