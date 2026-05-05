# Aura 项目缺陷分析与 Codex 对标报告

> 生成日期：2026-05-05
>
> 对比对象：Aura（`/`）vs Codex（`/Users/fanhuaze/Documents/YunWork/codex-main`）
>
> 分析范围：架构、安全、运行时能力、工程化四大维度

---

## 目录

- [一、架构级缺陷](#一架构级缺陷)
- [二、安全与审批](#二安全与审批)
- [三、运行时能力](#三运行时能力)
- [四、体验与工程化](#四体验与工程化)
- [五、总结优先级排序](#五总结优先级排序)
- [六、可参考 Codex 的具体方向](#六可参考-codex-的具体方向)

---

## 一、架构级缺陷

### 1. 缺少沙箱隔离体系

- **Codex**：有完整的沙箱分层，包括 `linux-sandbox`（Landlock + Bubblewrap）、`process-hardening`、`FileSystemSandboxPolicy`、`NetworkSandboxPolicy`、`WindowsSandboxLevel`，shell 命令执行时有 `SandboxPermissions` 约束文件系统读写范围和网络访问。
- **Aura**：`runShellStreaming` 直接用 `spawn('/bin/zsh', ...)` 执行命令，**没有任何文件系统或网络沙箱**。Agent 可以自由读写整个系统。这是最大的安全隐患。

### 2. 缺少执行策略引擎（ExecPolicy）

- **Codex**：有独立的 `execpolicy` crate，支持 `.codexpolicy` 规则文件，用声明式规则匹配 shell 命令（正则匹配命令前缀、参数），可以定义 allow/deny/prompt 行为，还有 `amend` 机制让用户批准后自动追加规则。
- **Aura**：只有粗糙的 `looksLikeShellFileMutation` 正则拦截和 `apply_patch` 拦截，缺少系统化的命令策略引擎。无法做到"允许 `npm test` 但禁止 `rm -rf /`"这种精细控制。

### 3. `runtimeCapabilityContract.mjs` 是空实现

```js
export function evaluateRuntimeCapabilityContract() {
  return null
}
```

这个模块在 `agent.mjs` 中被调用，但始终返回 `null`。说明 **运行时能力合约** 设计了但没有真正实现。Codex 的 capability 合约是多层配置叠加（项目级 → 全局 → 用户级），决定每个 turn 能用哪些工具。

---

## 二、安全与审批

### 4. Guardian 自动审批机制缺失

- **Codex**：有完整的 `guardian` 子系统，用独立的 LLM session 评估高风险操作的风险等级（risk_level）、用户授权状态（user_authorization），输出结构化的 allow/deny，还有熔断器（连续拒绝 3 次自动停止，总拒绝 10 次停止）。
- **Aura**：审批只有简单的 `approval-required` / `auto-approved` 二元状态，没有 Guardian 级别的智能审批评估。

### 5. Shell 命令拦截不够完善

`resolveShellFileMutationInterception` 拦截了 `sed -i`、`python writeFile` 等模式，但 Codex 有更完整的 `BANNED_PREFIX_SUGGESTIONS`（禁止 `git`、`bash`、`python`、`node`、`osascript` 等直接执行），Aura 只拦截了写文件相关的模式。

### 6. 缺少危险命令检测

Codex 有 `command_might_be_dangerous` 函数和 `is_known_safe_command` 白名单机制。Aura 缺少这类前置安全检查。

---

## 三、运行时能力

### 7. 缺少 Hooks 系统

- **Codex**：有完整的 `hooks` 机制，支持 `pre-tool-use`、`post-tool-use`、`permission-request`、`session-start`、`stop`、`user-prompt-submit` 等生命周期钩子，每个钩子有 JSON Schema 定义，可以通过外部脚本扩展行为。
- **Aura**：完全没有 hooks。无法在工具执行前后注入自定义逻辑（如自动 lint、自动 format、自动 commit 等）。

### 8. 缺少 Memories（持久记忆）系统

- **Codex**：有 `memories` crate，分 `read`（读取记忆、引用、提示词注入）和 `write`（两阶段写入、guard 机制、工作区感知），记忆保存在项目 `.codex/memories` 目录中，跨会话持久化。
- **Aura**：没有跨会话的项目级记忆。每次新会话 Agent 对项目上下文的了解从零开始。

### 9. 消息压缩/上下文管理缺失

- **Codex**：有 `compact.rs`、`compact_remote.rs`、`context_manager/history.rs`，在上下文窗口接近上限时自动压缩历史消息。
- **Aura**：没有看到上下文压缩机制。长会话会直接超过模型的上下文窗口限制。

### 10. 子 Agent 架构较弱

- **Codex**：`agent/` 子系统有完整的 `registry`、`role`、`control`、`mailbox`、`status`、`resolver`，支持多种内置 agent 角色（`awaiter`、`explorer`），有 agent 命名和解析机制。
- **Aura**：有 `spawn_subagent` 能力，但架构上是简单的 task delegation，缺少 agent 间 mailbox 通信、角色注册、状态管理。

### 11. `inferRouteEscalationFromMessage` 硬编码返回 null

```js
function inferRouteEscalationFromMessage(message, availableEscalations) {
  return null
}
```

这意味着 Agent 无法从用户消息中推断是否需要路由升级，只能通过显式的 tool call 触发。Codex 有更完整的路由推断逻辑。

---

## 四、体验与工程化

### 12. 测试覆盖不足

Aura 的 `bridge/` 目录下只有 **6 个测试文件**：

- `applyPatchShell.test.mjs`
- `applyPatchStreaming.test.mjs`
- `applyPatchTool.test.mjs`
- `fileVerification.test.mjs`
- `textMutationRuntime.test.mjs`
- `unifiedExecRuntime.test.mjs`

核心的 `agent.mjs`、`providers.mjs`、`agentRouting.mjs`、`tools.mjs`、`extensions.mjs`、`completionGate.mjs` 都没有测试。Codex 每个核心模块都有 `_tests.rs` 或 `_test.rs` 文件，还有专门的 `tests/` 目录和 fixture 文件。

### 13. 能力覆盖规则形同虚设

前端有 `ProjectCapabilityOverrides`、`WorkspaceCapabilityOverrides` 类型定义，UI 也有 capability panel，但后端 `evaluateRuntimeCapabilityContract` 始终返回 null，意味着用户在 UI 里做的能力开关覆盖 **实际上不生效**。

### 14. 缺少 Agent Names / Multi-Agent Identity

Codex 有 `agent_names.txt`、`agent_resolver.rs`、`role.rs`，支持多 Agent 身份和角色分工。Aura 的多 Agent 是简单的主从委派。

### 15. 缺少 `AGENTS.md` 项目指令

Codex 支持在项目根目录放置 `AGENTS.md`，作为项目级指令注入到 system prompt。Aura 有 `skills/` 目录但缺少类似的项目级指令注入机制。

### 16. CLI 只有基础实现

Codex 有完整的 CLI（`codex-rs/cli`），支持 debug sandbox、desktop app、login、marketplace、MCP 命令。Aura 的 `bridge/cli.mjs` 相对简单。

### 17. Windows/Linux 平台支持

Codex 有 `windows-sandbox`、`landlock`（Linux）、`bwrap`、`WSL paths` 等跨平台支持。Aura README 也承认目前只对 macOS 做了增强，Windows/Linux 体验不完整。

---

## 五、总结优先级排序

| 优先级 | 问题 | 影响 |
|--------|------|------|
| 🔴 P0 | 沙箱隔离缺失 | Agent 可以自由读写系统，安全风险极高 |
| 🔴 P0 | 执行策略引擎缺失 | 无法精细控制 shell 命令权限 |
| 🟠 P1 | Guardian 智能审批缺失 | 高风险操作缺乏智能评估 |
| 🟠 P1 | Hooks 系统缺失 | 无法扩展工具生命周期行为 |
| 🟠 P1 | Memories 系统缺失 | 跨会话项目记忆丢失 |
| 🟠 P1 | 消息压缩/上下文管理缺失 | 长会话会超限 |
| 🟡 P2 | `runtimeCapabilityContract` 空实现 | 能力覆盖 UI 不生效 |
| 🟡 P2 | 测试覆盖不足 | 回归风险高 |
| 🟡 P2 | `inferRouteEscalationFromMessage` 空实现 | 路由升级不够智能 |
| 🟢 P3 | 子 Agent 架构增强 | 复杂任务分解能力有限 |
| 🟢 P3 | 项目级指令注入（AGENTS.md） | 缺少项目上下文感知 |
| 🟢 P3 | 跨平台完善 | Windows/Linux 体验差 |

---

## 六、可参考 Codex 的具体方向

| 方向 | Codex 参考代码 | Aura 改造建议 |
|------|---------------|--------------|
| 沙箱 | `codex-rs/linux-sandbox/`、`exec_policy.rs` | 在 `runShellStreaming` 前加入沙箱约束层 |
| 执行策略 | `codex-rs/execpolicy/` | 设计声明式规则引擎替换当前的硬编码正则 |
| Guardian | `codex-rs/core/src/guardian/` | 用独立 LLM session 做审批评估 |
| Hooks | `codex-rs/hooks/` | 支持 `pre-tool-use` / `post-tool-use` 等生命周期 |
| Memories | `codex-rs/memories/` | 实现项目级跨会话记忆 |
| 上下文压缩 | `codex-rs/core/src/compact.rs` | 长会话自动压缩 |
| 多 Agent | `codex-rs/core/src/agent/` | 完善 agent 间通信和角色管理 |
| 危险命令检测 | `codex-core/src/config_types/` | 增加危险命令白名单/黑名单机制 |
