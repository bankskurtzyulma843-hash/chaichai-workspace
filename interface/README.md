# 拆拆对话工作台

[→ 打开网页对话](https://bankskurtzyulma843-hash.github.io/chaichai-workspace/)

网页入口无需安装，支持自配 API、真实模型对话、停止、会话管理和导出；模型 API 必须允许浏览器跨域访问。Key 仅保存在当前页面内存，刷新清除；对话记录保存在当前浏览器。网页不连接本机 MCP，完整拆拆工具使用下方本地入口。

`npm --prefix interface run build:web` 生成内联脚本与样式的 `docs/index.html`，可独立保存为 HTML 打开。网页与本地模式使用同一协议客户端，分别调用模型 API 与本地服务。网页与本地历史分开保存。

独立的本地配置与对话页面。用户填写自己的大模型 API，模型通过原有 MCP 调用拆拆，页面展示回复、工具参数、结果与需要确认的操作。此目录独立于原项目核心；不替换安装版，也不改 Codex 等客户端的配置。

## 启动

已准备好本项目依赖和构建产物的电脑，可以双击 `启动拆拆.command`，然后打开终端显示的地址。也可在项目根目录执行：

```sh
PATH="$HOME/.chaichai/node/bin:$PATH" npm --prefix interface start
```

默认地址为 <http://127.0.0.1:4317>。端口冲突时可指定：

```sh
CHAICHAI_UI_PORT=4318 PATH="$HOME/.chaichai/node/bin:$PATH" npm --prefix interface start
```

首次从干净源码启动，先按项目要求使用 Node 24.18.0 / npm 11.16.0，在项目根目录运行 `npm ci` 和 `npm run build:cached`。本界面不额外安装依赖；MCP SDK 复用项目锁定版本。界面只监听本机回环地址。

## 使用

1. 打开「API 配置」，填写 API 地址、模型名和自己的 Key。地址可为 `https://你的服务/v1`，也可以是完整的 `/chat/completions` 地址。无认证的本地模型服务可以留空 Key。
2. 点击「测试连接」会实际向你填写的接口发送一次简短模型请求，按服务商规则计费；测试只确认文本接口可用。点击「保存配置」仅保存到本地服务内存。
3. 在对话中说明目标和想了解的问题。需要访问本地文件时提供真实绝对路径；聊天输入不会自动上传文件。根据任务不同，部分工具内容会随模型请求发送至所配置的 API。
4. 模型先检索拆拆实时工具及完整参数，再执行需要的工具。工具记录可以展开查看。涉及执行程序、写入文件、联网、设备或 UI 操作的调用，会展示参数并等待确认；拒绝后不执行该调用。
5. 点击「停止」中止本轮模型请求和工具会话。下一轮会重建已取消的工具会话。每个聊天拥有独立的 MCP 会话，切换聊天不会混用分析目标。

### API 和数据

- 当前使用 OpenAI 兼容的 **Chat Completions + function calling**。模型需要支持 `tools`；只支持原生 Anthropic Messages、Gemini 或 Responses 的接口暂不适用。不同兼容服务仍需用实际 Key 和模型验证。
- 没有预置模型、平台额度或公用 Key。API Key 不写入磁盘、不返回前端，也不注入拆拆子进程；仅保存在当前本地服务的内存中。服务重启或清除配置后需重填。
- 页面刷新可恢复同一本地服务内的配置状态，但不会读回 Key。修改 API 地址时空 Key 会清除旧服务的 Key；同地址留空可保留已保存 Key。
- 对话历史、工具记录保存在当前浏览器的本地存储中，供刷新和切换会话使用。删除会话可移除该会话本地记录并关闭对应工具连接。不同浏览器/端口的存储独立。
- 分析工具路径只作为数据从 `~/.chaichai/analysis-tools.env` 读取并传给该界面创建的子进程；不执行其中的 shell 代码，也不改父进程环境。

## 实现边界

```text
浏览器配置 / 对话页面
    → 本机 HTTP 服务（会话、模型请求、工具循环、事件流）
    → 本仓 scripts/rea.mjs mcp（独立 stdio 子进程）
    → 原有拆拆工具与 Evidence
```

`public/` 为原生 HTML/CSS/JavaScript；`server.mjs` 为本地 HTTP 与会话边界；`lib/model.mjs` 实现兼容 API 和工具循环；`lib/mcp.mjs` 适配现有 MCP。无需修改 `src/`、`scripts/`、根目录配置或已安装程序。

权限优先使用 `binary_session` 实际返回的工具 `effects`。空 effects 或仅 `mutatesSession` / `idempotent` 可自动调用；其他 effect 需要确认。元数据缺失时只有明确 `readOnlyHint: true` 才可自动执行。该规则属于界面调用层，不改变底层工具行为。

为了限制单机服务的资源占用，请求体上限为 1 MiB，单个模型响应最多接收 8 MiB；每轮对话最多 12 次模型请求，单次模型请求等待最多 3 分钟。达到限制会明确报错。服务内最多保留 100 个浏览器会话、每个会话 30 个工具连接；超过 30 个时关闭最早的空闲连接，浏览器历史仍保留，后续可重新连接。空闲会话在 12 小时后释放。

实现参考 [OpenAI 官方 function calling 文档](https://developers.openai.com/api/docs/guides/function-calling) 的 Chat Completions 工具调用流程。兼容适配不代表所有模型服务均已验收。

## 验证

在根目录执行：

```sh
PATH="$HOME/.chaichai/node/bin:$PATH" npm --prefix interface test
```

集成测试通过本机 HTTP 模型 fixture 和 MCP 边界替身，验证配置隔离、Key 不回显、完整流式工具调用链、资源读取、批准/拒绝、错误与取消。这些模型输出是确定性测试数据，不代表真实模型推理质量、计费或服务商兼容性。

MCP 适配器另有真实本仓无目标连接验证：读取实时工具目录与会话状态，不启动 Ghidra/JADX 等目标引擎。真实模型、带目标工具以及可选引擎应按具体使用场景验收。
