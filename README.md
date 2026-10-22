# 拆拆对话工作台 · ChaiChai Workspace

**自己配置模型 API，在本地用对话调用拆拆工具。**

本仓库在 [hubooooooo/chaichai](https://github.com/hubooooooo/chaichai) 的 MIT 开源工具箱上，新增独立的 **API 配置与对话界面**。拆拆核心、工具实现和证据体系来自上游；本版本的扩展位于 [`interface/`](./interface/)。保留上游提交历史、版权及第三方许可。

![拆拆对话工作台：极客风格的本地配置与对话页面](./interface/assets/terminal.png)

## 本版本提供什么

- **配置自己的 API**：填写服务地址、模型名与 Key，测试连接、保存或清除配置。
- **对话调用工具**：流式显示回复，查看工具参数、结果与证据；需要确认的操作由用户批准或拒绝。
- **管理本地会话**：新建、切换、删除会话，停止当前任务，复制回复或导出 Markdown。
- **极客风格界面**：深色终端视觉、命令式任务入口，适配桌面与手机宽度。

本版本以 **开源源码＋本地启动** 形式提供。网页服务与拆拆 MCP 子进程运行在使用者电脑上，默认只监听 `127.0.0.1`。

## 从源码启动

已验证环境为 **Apple 芯片 Mac、Node.js 24.18.0、npm 11.16.0**。项目开启 Node 版本校验；可用 nvm 按根目录 `.nvmrc` 切换 Node，确认 npm 版本后执行：

```sh
git clone https://github.com/bankskurtzyulma843-hash/chaichai-workspace.git
cd chaichai-workspace
npm ci
npm run build:cached
npm --prefix interface start
```

打开终端打印的地址，默认是 **http://127.0.0.1:4317**。依赖安装与构建完成后，也可在 Mac 上双击 [`interface/启动拆拆.command`](./interface/启动拆拆.command)。本仓库的命令会使用本仓构建的 MCP，无需替换已安装的拆拆或修改其他 AI 客户端配置。

分析特定目标可能需要额外引擎，例如 JADX、Ghidra 或 Chrome。源码启动不自动安装这些工具；请按 [上游安装文档](./docs/installation.md) 准备具体任务需要的组件。

## 配置模型并开始对话

1. 打开页面右上角「API 配置」。
2. 填写 **OpenAI 兼容 Chat Completions** 服务地址、支持 `tools` / function calling 的模型名及自己的 API Key。仅支持原生 Messages、Gemini 或 Responses 协议的接口暂不适用。
3. 点击「测试连接」，成功后保存配置。连接测试与后续对话会实际调用所填服务，并按服务商规则计费。
4. 输入分析问题；需要访问本地文件时提供该电脑上的真实绝对路径。工具调用记录可以展开，需要确认的调用会等待操作。

API Key 仅保存在当前本地服务内存中，不写入磁盘或浏览器历史，服务重启后需重新填写。对话与工具记录保存在当前浏览器本地存储中；模型请求会将本轮对话和相关工具内容发送到你配置的 API 服务。详细行为与限制见 [`interface/README.md`](./interface/README.md)。

## 验证与当前范围

```sh
npm --prefix interface test
```

界面层的 27 项自动测试已通过，覆盖配置隔离、流式工具调用、批准与拒绝、错误、取消与资源清理；模型部分使用本机确定性测试服务。真实本仓 MCP 已完成工具目录与会话连接检查。真实付费模型、带分析目标的完整任务及可选引擎仍需按服务与场景验证。

## 来源与许可

- 上游：[hubooooooo/chaichai](https://github.com/hubooooooo/chaichai)，本版本基于提交 `74ec6d0`。
- 本次新增：独立的本地 API 配置、模型对话与 MCP 调用界面；上游核心保持原样。
- 许可：[MIT](./LICENSE)。保留原版权声明；第三方组件见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

<details>
<summary>展开查看上游拆拆工具箱原始说明（其中安装命令指向上游，不包含本对话界面）</summary>

<div align="center">

# 拆拆 ChaiChai

**让 AI 帮你拆开任何软件，看懂它是怎么运作的**

<p>
  <a href="https://github.com/hubooooooo/chaichai/releases"><img src="https://img.shields.io/github/v/release/hubooooooo/chaichai?label=%E7%89%88%E6%9C%AC&color=6366f1" alt="版本"></a>
  <img src="https://img.shields.io/badge/%E9%80%82%E7%94%A8-Apple%20%E8%8A%AF%E7%89%87%20Mac-111827?logo=apple&logoColor=white" alt="适用：Apple 芯片 Mac">
  <a href="https://github.com/hubooooooo/chaichai/actions/workflows/ci.yml"><img src="https://github.com/hubooooooo/chaichai/actions/workflows/ci.yml/badge.svg" alt="自动检查"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-0f766e" alt="许可证：MIT"></a>
</p>

**一行命令装好 · 不用懂编程 · 用中文跟 AI 说话，就能看懂一个软件**

[快速安装](#快速安装) · [怎么用](#怎么用) · [能拆什么](#能拆什么) · [常见问题](#常见问题)

</div>

---

## 拆拆是什么

你平时用的 App、网页、小游戏，都像一台**封好的机器**：看得见外壳，看不见里面。

拆拆是一套交给 AI 用的**拆解工具箱**。把它接入 Codex、Claude Code、Cursor 这类 AI 助手以后，AI 就能自己打开这台机器，一层层查看里面的代码和行为，再用大白话告诉你它是怎么运作的。

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🗣️ 说中文就行</h3>
      不用学命令，不用懂编程。像跟同学聊天一样，告诉 AI 你想弄明白什么。
    </td>
    <td width="33%" valign="top">
      <h3>🔍 有理有据</h3>
      每个结论都标明证据：在哪个文件、哪个位置看到的。还会分清哪些是确定的事实，哪些只是推测，哪些还不知道。
    </td>
    <td width="33%" valign="top">
      <h3>🛡️ 只看不改</h3>
      大部分工具只读取、不修改。少数需要运行程序或操作手机的工具，AI 会先问你。
    </td>
  </tr>
</table>

**你可以用它弄明白这些问题：**

- 这个 Mac 应用里装了哪些组件，是用什么技术做出来的？
- 这个桌面软件的界面和后台之间，是怎么传递消息的？
- 这个网页小游戏的计分规则是什么？我能照着做一个吗？
- 这个安卓 App 申请了哪些权限，里面都有哪些页面？

---

## 快速安装

> **适用电脑：** Apple 芯片（M1、M2、M3、M4 等）的 Mac，系统 macOS 11 或更新。不支持 Intel 芯片的 Mac。
>
> 不知道是哪种芯片？点屏幕左上角的苹果图标 → 「关于本机」，看「芯片」那一栏：写着 **Apple M** 开头就可以。

**① 打开「终端」**：按 `Command + 空格`，输入"终端"，按回车。

**② 复制下面这一行，粘贴进终端，按回车：**

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/hubooooooo/chaichai@main/install.sh | bash
```

**③ 等它跑完**：大约 1～3 分钟。中间问"是否继续？"时直接按回车。看到 **🎉 安装完成！** 就成功了。

**④ 重启一下**：关掉终端重新打开；再把你的 AI 工具（比如 Codex）**完全退出**后重新打开。

<details>
<summary><b>上面那行命令报错了？</b></summary>

<br>

换这一行再试：

```bash
curl -fsSL https://raw.githubusercontent.com/hubooooooo/chaichai/main/install.sh | bash
```

两行都不行的话，请老师把 `install.sh` 文件直接发给你，保存到「下载」文件夹，然后运行：

```bash
bash ~/Downloads/install.sh
```

</details>

<details>
<summary><b>安装程序会对我的电脑做什么？</b></summary>

<br>

- 所有东西都装在你的用户文件夹下的 `.chaichai` 文件夹里。
- 拆拆自带一份专用的运行环境（Node.js）。电脑上以前装过什么、装错过什么，都不会影响它，它也不会去改动那些东西。
- 不需要管理员密码，也不会安装其他软件。
- 在终端的设置文件里加几行，让你能直接输入 `chaichai` 命令。
- 找到你电脑上的 AI 工具，经你同意后把拆拆接入进去。修改之前会先备份它们的配置文件。
- 优先从国内镜像下载，下载的文件都会核对"指纹"，防止下载不完整或被篡改。

</details>

---

## 怎么用

装好以后，**打开你的 AI 工具，用平常说话的方式提要求**，句子里带上"用拆拆"三个字就行：

| 想做的事             | 可以这样跟 AI 说                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| 看看一个软件里有什么 | 「用拆拆看看 `/System/Applications/Calculator.app` 里面都有哪些部分，它是用什么做的？」           |
| 弄懂桌面软件的原理   | 「用拆拆分析 `/Applications/Visual Studio Code.app`，它的界面和后台是怎么互相传消息的？」         |
| 找出网页游戏的规则   | 「`~/Desktop/小游戏` 这个文件夹是一个网页小游戏的代码。用拆拆找出它的计分规则，帮我做一个一样的」 |
| 检查安卓 App         | 「用拆拆检查 `~/Downloads/xxx.apk`，列出它申请的所有权限」（需要先装 JADX，见下方表格）           |

**AI 会怎么做？** 它会自己一步步调用拆拆的工具：

```text
找到你说的软件  →  拆开看整体结构  →  顺着线索找到相关的代码  →  用大白话回答你，并附上证据位置
```

整个过程你只需要看它的回答。觉得哪里没讲清楚，接着追问就行。

---

## 能拆什么

| 想拆的东西                                                | 需要额外安装                       |
| --------------------------------------------------------- | ---------------------------------- |
| ✅ 网页代码、网页小游戏                                   | 不需要                             |
| ✅ Electron 桌面软件（很多聊天、笔记、编程软件都是这种）  | 不需要                             |
| ✅ Mac 应用的安装包、里面的图片和配置文件                 | 不需要                             |
| ✅ .NET 程序、Go 语言程序、Flutter 做的手机 App           | 不需要                             |
| 🧩 正在浏览器里打开的网站                                 | Chrome 浏览器                      |
| 🧩 安卓 App 的代码（.apk 文件）                           | JADX 和 Java                       |
| 🧩 电脑软件的底层代码（比如游戏、工具软件的 .app / .exe） | Ghidra（免费）、Hopper 或 IDA 之一 |

需要额外软件时，具体装法见 [安装与设置](docs/installation.md#supported-agents)。拆拆一共有 189 个工具，完整清单见 [工具目录](docs/mcp-contracts.md#generated-catalog)。

**支持的 AI 工具：** Codex、Claude Code、Cursor、Trae、VS Code、Qwen Code、Gemini CLI、Windsurf、OpenCode 等 20 多种。安装时会自动找到并接入你电脑上已有的那些。

---

## 常用命令

在终端里输入：

| 命令              | 作用                                                  |
| ----------------- | ----------------------------------------------------- |
| `chaichai doctor` | 检查拆拆是否正常                                      |
| `chaichai setup`  | 重新把拆拆接入 AI 工具（新装了 AI 工具后用）          |
| `chaichai update` | 更新到最新版。如果提示"重新运行安装命令"，照做即可    |
| `chaichai --help` | 查看全部命令（拆拆也可以不通过 AI，直接在终端里使用） |

---

## 常见问题

<details>
<summary><b>装不上怎么办？</b></summary>

<br>

1. **先把安装命令重新运行一次。** 安装程序可以重复运行，大部分问题会自动修好。
2. 如果提示网络问题：开着 VPN 的话关掉再试；没开的话换个网络（比如手机热点）再试。
3. 还是不行，把 `~/.chaichai/install.log` 这个文件发给老师。找这个文件的方法：在「访达」里按 `Command + Shift + G`，粘贴 `~/.chaichai`，回车。

</details>

<details>
<summary><b>AI 工具里找不到拆拆？</b></summary>

<br>

1. 确认已经把 AI 工具**完全退出**（`Command + Q`），再重新打开。
2. 在终端运行 `chaichai setup`，看看它有没有找到你的 AI 工具。
3. 如果你是装完拆拆以后才装的 AI 工具，也要运行一次 `chaichai setup`。

</details>

<details>
<summary><b>会不会把我的电脑弄乱？</b></summary>

<br>

不会。拆拆的所有文件都在 `~/.chaichai` 这一个文件夹里，不碰电脑上的其他软件。修改 AI 工具的配置之前会先备份。卸载时也只删除拆拆自己的东西。

</details>

<details>
<summary><b>Intel 芯片的 Mac 能用吗？Windows 呢？</b></summary>

<br>

目前都不支持。安装程序会检查芯片，不符合时会直接提示。

</details>

<details>
<summary><b>要花钱吗？</b></summary>

<br>

拆拆本身完全免费、开源。你用的 AI 工具（比如 Codex）按它自己的规则收费。

</details>

<details>
<summary><b>怎么卸载？</b></summary>

<br>

在终端运行：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/hubooooooo/chaichai@main/uninstall.sh | bash
```

卸载会把拆拆从 AI 工具里移除，并删除 `~/.chaichai` 文件夹。你的其他软件，以及 AI 工具的其他设置都不受影响。

</details>

---

## 请合法使用

只分析你自己的软件，或者你有权分析的软件。**不要**用它破解收费软件、绕过版权保护，或者获取别人的隐私数据。详见 [免责声明](DISCLAIMER.md)。

AI 工具弹出"是否允许运行某个工具"的提示时，**先看清楚再点允许**。拆拆有少数工具会真的动手，比如运行程序、给连着的手机安装或卸载 App，这类工具 AI 一般会单独询问你。

---

<details>
<summary><b>给开发者</b></summary>

<br>

拆拆是一个本地运行的命令行工具和 MCP 服务器，用 TypeScript 编写，需要 Node.js 22.19+ / 24.11+ / 26+。

```bash
npm ci                     # 安装依赖
npm run build:cached       # 构建
npm run check:fast         # 类型检查 + 代码规范
npm run test:fast          # 快速测试
npm test                   # 完整测试（约 15 分钟）
node scripts/rea.mjs --help
```

- 架构说明：[docs/architecture.mermaid](docs/architecture.mermaid)
- 开发约定：[CONTRIBUTING.md](CONTRIBUTING.md)、[AGENTS.md](AGENTS.md)
- 测试说明：[docs/testing.md](docs/testing.md)
- 发布新版本（给老师和维护者）：[docs/teacher-guide.md](docs/teacher-guide.md)
- 文档总目录：[docs/index.md](docs/index.md)

</details>

## 许可证

本项目以 MIT 许可证开源，详见 [LICENSE](LICENSE)。用到的第三方组件及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [licenses/](licenses/)。

</details>
