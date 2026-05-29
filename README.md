# Aura

**中文** | [English](./README.en.md)

Aura 是一个桌面优先、本地优先、面向真实工作区的通用 Agent 应用。

它不是把聊天框套进桌面壳里，而是把模型 Provider、MCP、Skills、Plugins、文件与 Shell 工具、Web 检索、桌面自动化、权限审批、会话持久化和运行时观测放进同一个可日用的桌面工作台。

如果你想要一个可以连接自己 API、理解本地仓库、调用外部能力、并把数据留在本机的 Agent，Aura 就是为这个方向做的。

## 为什么值得关注

- **桌面产品，而不是终端包装**：基于 `Tauri + React` 构建 UI，以 `Rust + Node.js` 承载本地系统能力和 Agent Runtime。
- **工作区感知**：每个会话可以绑定真实目录，读取文件树、预览文件、导入附件、写入产物、运行命令。
- **模型不锁厂商**：支持 `OpenAI`、`Google Gemini` 和 OpenAI-compatible `Custom` Provider，可维护多个 Provider Profile。
- **扩展能力是一等公民**：MCP Server、Aura Skills、Aura Plugins 会进入统一工具池，并支持全局启停与项目级覆盖。
- **Web 与桌面能力并存**：内置 `web_search`、`web_fetch`、`web_research`，可选 Lightpanda 页面读取；显式交互任务可打开系统浏览器，macOS 下可使用 Computer Use。
- **本地持久化**：设置、会话、消息版本、工具事件详情、工作记忆和能力覆盖规则落在本地 SQLite 与 `~/.aura`。
- **为执行而设计**：权限审批、任务树、工具事件、失败重试、上下文压缩、证据校验和运行日志都围绕真实任务闭环。

## 能做什么

Aura 当前适合这些场景：

- 分析、修改和验证本地代码仓库
- 排查复杂工程问题，保留可追踪的执行轨迹
- 连接 OpenAI、Gemini 或自建 OpenAI-compatible API
- 接入 MCP 工具，例如数据库、内部系统、知识库或自动化服务
- 通过 Skills / Plugins 扩展本地 Agent 能力
- 做带引用证据的 Web 调研、网页抓取和资料整理
- 在 macOS 上执行截图、输入、快捷键、应用切换等桌面辅助操作
- 将会话、产物、日志和配置长期保存在本机

## 核心能力

### Agent Runtime

- 多轮对话与后台任务执行
- 任务中断、取消、审批和追加输入
- Provider 故障恢复、重试和最终答案整理
- 上下文压缩与长对话摘要
- 工具执行证据、完成状态校验和运行日志
- 实验性多 Agent 委派能力（开发中）

### 本地工作区

- 会话绑定工作目录
- 文件树读取、代码搜索、文件分段读取
- `apply_patch`、精确文本编辑、多文件编辑和写文件
- Shell / 长运行命令 / stdin 交互
- 附件导入、图片预览、会话产物目录
- 文件写入审批、变更预览和写入校验

### Provider

- OpenAI
- Google Gemini
- OpenAI-compatible Custom Provider
- 多 Provider Profile
- 模型列表抓取、连通性检测、默认模型选择
- 可为分析压缩、标题生成等任务选择独立模型路由

### MCP / Skills / Plugins

- `stdio` MCP Server 接入
- MCP 工具发现、预览与调用
- 内置 Skills：浏览器操作策略、修复规划、仓库审查、桌面操作、Web Research
- 支持从本地、URL、GitHub、npm/npx 来源安装或导入 Aura Skill
- 插件工具接入统一工具路由
- 全局能力开关与工作区级覆盖

### Web 与浏览器

- `web_search`：快速检索，支持 Tavily、Brave、DuckDuckGo 等后端
- `web_fetch`：HTTP 抓取、Readability 提取、元数据/正文读取
- `web_research`：搜索与抓取组合的多来源研究工具
- Jina Reader fallback
- 可选 Lightpanda 页面读取
- 显式交互任务可通过 `system_browser_open` 打开系统浏览器

### 桌面自动化

macOS 下可挂载 Computer Use 工具：

- 列出可见应用
- 获取前台应用
- 打开或聚焦应用
- 截图并保存到工作区
- 向前台应用输入文本
- 发送快捷键

Windows / Linux 会跳过 macOS-only 的桌面自动化工具，但基础 Agent、Provider、MCP、Web、本地文件和 Shell 能力仍可使用。

## 技术架构

Aura 当前分为五层：

1. **React UI**：主窗口、设置窗口、MCP 编辑窗口、会话视图、工具事件与任务树。
2. **前端应用编排层**：会话生命周期、窗口通信、设置同步、工作区绑定与任务轮询。
3. **Tauri / Rust 原生层**：桌面窗口、本地文件、SQLite、Aura Home、系统命令和 Node sidecar 桥接。
4. **Node Agent Runtime**：模型调用、工具编排、能力选择、MCP / Skills / Plugins、多 Agent、错误恢复。
5. **本地数据与扩展层**：`~/.aura`、SQLite、工作区产物、日志、Skills、Plugins、MCP 配置。

更多细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 项目结构

```text
.
├── src/                 # React desktop UI and frontend orchestration
├── src-tauri/           # Tauri/Rust host, commands, SQLite, sidecar wiring
├── bridge/              # Node Agent Runtime, providers, tools, MCP, web retrieval
├── skills/              # Built-in Aura skills
├── docs/                # Architecture and design notes
├── scripts/             # Build helpers
└── .github/workflows/   # Multi-platform release builds
```

## 快速开始

### 前置依赖

- Node.js 18+，推荐 Node.js 22
- pnpm 9.x
- Rust stable
- Tauri v2 所需系统依赖

Linux 需要安装 WebKitGTK 等 Tauri 依赖；Windows / macOS 按 Tauri v2 官方要求准备系统工具链。

### 安装依赖

```bash
pnpm install
```

### 启动桌面应用

```bash
pnpm dev
```

### 只启动前端 Web 调试

```bash
pnpm dev:web
```

### 类型检查

```bash
pnpm typecheck
```

### 构建桌面应用

```bash
pnpm tauri:build
```

构建时会通过 `src-tauri/build.rs` 自动把当前目标平台匹配的 Node runtime staged 为 Tauri sidecar。跨架构构建时，可通过 `AURA_NODE_BINARY` 指向目标架构的 Node 可执行文件。

## 本地数据

Aura 会在用户目录创建 `~/.aura`，用于保存：

- SQLite 配置与会话数据
- Skills / Plugins / MCP 配置
- 工作区与会话产物
- 浏览器相关资源
- 日志文件

这意味着 Aura 的核心工作状态默认保存在本机，而不是依赖云端托管的产品状态。

## 开源状态

Aura 仍在快速迭代中。当前仓库已经包含桌面应用、Agent Runtime、MCP、Skills、Web Retrieval、本地执行工具、持久化和多平台打包基础设施。

欢迎通过 Issue / PR 参与：

- Bug 修复和稳定性改进
- 新 Provider 或 Provider 兼容性修复
- MCP 集成与示例
- Aura Skills / Plugins
- Web 检索与抓取后端
- 权限、审批和安全策略
- UI / UX 与桌面体验
- Windows / Linux 适配

## 许可证

Aura 使用 [MIT License](./LICENSE) 开源。

如果仓库中有从第三方开源项目复制或改写的代码，请保留对应项目的版权声明与许可证文本；相关记录可补充到 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
