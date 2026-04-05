# Aura

Aura 是一个桌面优先的本地 Agent 工作区，使用 `Tauri + React` 做 UI，用 `Node` 运行本地 Agent runtime。

## 当前结构

- `src`
  React 桌面界面，包括首页、提供商配置、聊天工作台、项目上下文和审批面板。
- `src-tauri`
  Tauri 原生层，负责桌面窗口、任务桥接、文件树读取和本地命令暴露。
- `bridge`
  Node 侧 Agent runtime，负责模型调用、工具编排、MCP、Skills、Plugins、多 Agent 和高级桌面能力。
- `skills`
  本地技能提示。
- `plugins`
  本地插件工具。

## 已接入能力

- 多 Provider 配置
  支持 Anthropic 和 OpenAI-compatible Base URL / API Key / Model
- 本地工具
  文件搜索、读写、Shell 执行
- Multi-Agent
  主 Agent 可以通过 `spawn_subagent` 委派子任务
- Computer Use
  在 macOS 上支持列举应用、激活应用、截图、输入文本、发送快捷键
- Chrome Automation
  在 macOS 上支持打开 URL、读取活动标签页、执行前台页 JavaScript
- Skills / Plugins / MCP
  桌面运行时原生支持

## 开发

```bash
pnpm install
pnpm dev
```

桌面端常用命令：

```bash
pnpm typecheck
pnpm tauri:build
```

## 说明

- 这个仓库已经按“桌面 Agent 工具”方向做了裁剪，根目录就是当前唯一的桌面 Agent 工程。
- 不再保留旧 CLI/TUI 作为运行入口，也不再依赖 Bun/workspace 结构。
- 如果要继续迁移 Claude 的其他能力，优先在 `bridge` 和 `src-tauri` 里做桌面化实现。
