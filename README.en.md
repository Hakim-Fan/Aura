# Aura

[中文](./README.md) | **English**

Aura is a desktop-first, local-first, workspace-aware general-purpose agent app.

It is not a chat box wrapped in a desktop shell. Aura brings model providers, MCP, skills, plugins, file and shell tools, web retrieval, desktop automation, permission approvals, local persistence, and runtime observability into one daily-usable desktop workspace.

If you want an agent that can use your own APIs, understand local repositories, connect external tools, and keep its working state on your machine, Aura is built for that direction.

## Why Aura Is Interesting

- **A real desktop product, not a terminal wrapper**: `Tauri + React` for the app, `Rust + Node.js` for local system capabilities and the agent runtime.
- **Workspace aware**: sessions can bind to real directories, read file trees, preview files, import attachments, write artifacts, and run commands.
- **Provider neutral**: supports `OpenAI`, `Google Gemini`, and OpenAI-compatible `Custom` providers with multiple provider profiles.
- **Extensions are first-class**: MCP servers, Aura Skills, and Aura Plugins are mounted into one tool pool with global and per-workspace controls.
- **Web and desktop capabilities together**: built-in `web_search`, `web_fetch`, and `web_research`, optional Lightpanda page reading, explicit system-browser opening, and macOS Computer Use tools.
- **Local persistence**: settings, sessions, message versions, tool event details, work memories, and capability overrides are stored in local SQLite and `~/.aura`.
- **Designed for execution**: approvals, task trees, tool events, retries, context compression, evidence checks, and runtime logs are part of the core loop.

## What You Can Use It For

Aura is useful for:

- Analyzing, editing, and validating local code repositories
- Debugging complex engineering tasks with traceable execution history
- Connecting OpenAI, Gemini, or self-hosted OpenAI-compatible APIs
- Using MCP tools for databases, internal systems, knowledge bases, or automation services
- Extending the agent with local Skills and Plugins
- Web research, page extraction, and source-backed summaries
- macOS desktop assistance such as screenshots, typing, shortcuts, and app switching
- Keeping conversations, artifacts, logs, and configuration on your own machine

## Core Capabilities

### Agent Runtime

- Multi-turn conversations and background task execution
- Abort, cancel, approval, and append-input flows
- Provider failure recovery, retries, and final answer cleanup
- Context compression and long-conversation summaries
- Tool evidence, completion-state checks, and runtime logs
- Experimental multi-agent delegation (in development)

### Local Workspace

- Session-bound working directories
- File tree reading, code search, and ranged file reads
- `apply_patch`, exact text edits, multi-file edits, and file writes
- Shell commands, long-running processes, and stdin interaction
- Attachment imports, image previews, and session artifact folders
- File-write approvals, change previews, and write verification

### Providers

- OpenAI
- Google Gemini
- OpenAI-compatible custom providers
- Multiple provider profiles
- Model fetching, connection testing, and default model selection
- Separate model routing for tasks such as analysis compression and title generation

### MCP / Skills / Plugins

- `stdio` MCP server integration
- MCP tool discovery, preview, and invocation
- Built-in skills for browser operation policy, repair planning, repo review, desktop operation, and web research
- Aura Skill installation/import from local files, URLs, GitHub sources, npm packages, and npx-style sources
- Plugin tools mounted into the shared routing layer
- Global capability toggles plus workspace-level overrides

### Web And Browser

- `web_search`: fast lookup with providers such as Tavily, Brave, and DuckDuckGo
- `web_fetch`: HTTP fetching, Readability extraction, metadata, and page text
- `web_research`: multi-source research that combines search and fetch
- Jina Reader fallback
- Optional Lightpanda-backed page reading
- `system_browser_open` for explicit interactive browser tasks

### Desktop Automation

On macOS, Aura can mount Computer Use tools for:

- Listing visible apps
- Reading the frontmost app
- Opening or focusing apps
- Capturing screenshots into the workspace
- Typing text into the frontmost app
- Sending keyboard shortcuts

Windows and Linux skip macOS-only desktop automation tools, while the core agent, providers, MCP, web retrieval, local file tools, and shell tools remain available.

## Architecture

Aura currently has five layers:

1. **React UI**: main window, settings window, MCP editor, chat view, tool events, and task tree.
2. **Frontend orchestration**: session lifecycle, window communication, settings sync, workspace binding, and task polling.
3. **Tauri / Rust native layer**: desktop windows, local files, SQLite, Aura Home, system commands, and the Node sidecar bridge.
4. **Node Agent Runtime**: model calls, tool orchestration, capability selection, MCP / Skills / Plugins, multi-agent flow, and error recovery.
5. **Local data and extension layer**: `~/.aura`, SQLite, artifacts, logs, Skills, Plugins, and MCP configuration.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for more details.

## Repository Layout

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

## Getting Started

### Prerequisites

- Node.js 18+, Node.js 22 recommended
- pnpm 9.x
- Rust stable
- System dependencies required by Tauri v2

Linux requires WebKitGTK and related Tauri dependencies. Windows and macOS should follow the Tauri v2 platform setup guide.

### Install Dependencies

```bash
pnpm install
```

### Run The Desktop App

```bash
pnpm dev
```

### Run Web-Only Frontend Development

```bash
pnpm dev:web
```

### Typecheck

```bash
pnpm typecheck
```

### Build The Desktop App

```bash
pnpm tauri:build
```

During build, `src-tauri/build.rs` stages a Node runtime that matches the current target as the Tauri sidecar. For cross-architecture builds, set `AURA_NODE_BINARY` to a Node executable for the target architecture.

## Local Data

Aura creates `~/.aura` in the user home directory for:

- SQLite settings and session data
- Skills / Plugins / MCP configuration
- Workspaces and session artifacts
- Browser-related resources
- Log files

This means Aura's core working state stays local by default instead of depending on a hosted product backend.

## Open Source Status

Aura is still moving quickly. The repository already includes the desktop app, agent runtime, MCP integration, skills, web retrieval, local execution tools, persistence, and multi-platform release infrastructure.

Contributions are welcome in areas such as:

- Bug fixes and stability improvements
- New providers or provider compatibility fixes
- MCP integrations and examples
- Aura Skills / Plugins
- Web search and fetch backends
- Permission, approval, and safety policies
- UI / UX and desktop experience
- Windows / Linux support

## License

This repository currently does not include a root License file. Please add an explicit open-source license before downstream reuse, redistribution, or derivative development.
