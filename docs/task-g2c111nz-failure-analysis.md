# 任务 g2c111nz-260515105039-simul95g 执行失败分析报告

> 分析时间：2026-05-15
> 任务 ID：`g2c111nz-260515105039-simul95g`
> Session ID：`2605151050-g2c111nz`
> Task ID：`faec3714-3067-4433-8119-2e2401c9b2f0`
> 模型：`mimo-v2.5-pro`（custom provider）
> 运行模式：`route-first`（legacy architecture）

---

## 1. 用户意图

用户请求从 GitHub 仓库 `https://github.com/anthropics/skills/tree/main/skills/docx` 安装 `docx` skill。

## 2. 执行时间线

| 时间 (UTC+8) | 阶段 | 事件 | 说明 |
|---|---|---|---|
| 10:50:39.437 | 启动 | `bridge_launch_prepared` | Bridge 启动，路径和 Node 运行时验证通过 |
| 10:50:39.439 | 启动 | `agent_task_spawned` | 任务创建，使用 mimo-v2.5-pro 模型 |
| 10:50:40.025 | 执行 | `agent_task_started` | 任务开始 |
| 10:50:40.026 | 执行 | phase=`preparing` | 准备阶段 |
| 10:50:40.028 | 执行 | `agent.run.started` | route-first 模式启动 |
| 10:50:40.029 | 路由 | `agent.classifier.result` | 分类：standard 复杂度，medium 风险，需工具+写操作 |
| 10:50:40.029 | 路由 | `agent.path.selected` | 选择 standard 路径 |
| 10:50:40.362 | 执行 | `agent_task_tree_updated` | 任务树创建：1 个 main task |
| 10:50:40.429 | 路由 | `agent.route.decision` | 路由决策：execute 模式，挂载 22 个工具 |
| 10:50:40.431 | 模型 | phase=`model_connecting` | 连接模型 |
| 10:50:43.609 | 模型 | phase=`model_streaming` | 模型开始流式输出 |
| 10:50:43.826 | 模型 | `agent_reasoning_started` | 模型推理开始 |
| 10:50:45.695 | 工具 | phase=`tool_running` | 模型决定调用 `aura_install_skill` |
| 10:50:45.714 | 审批 | phase=`awaiting_approval` | 触发审批流程（file_write 类别） |
| 10:50:48.954 | 审批 | `agent_approval_submitted` | 用户批准（approve_for_task） |
| 10:50:48.955 | 工具 | `agent.tool.event` status=running | 工具开始执行 |
| 10:50:48.956 | 工具 | `agent_tool_event` | 参数：从 GitHub 安装 docx skill |
| **10:51:19.473** | **错误** | **`agent.tool.event` status=error** | **工具执行失败（耗时 ~30 秒）** |
| **10:51:19.475** | **错误** | **`agent_tool_event` ERROR** | **GitHub API HTTP 403** |
| 10:51:19.537 | 恢复 | phase=`model_connecting` | 进入恢复流程，重新连接模型 |
| 10:51:20.008 | 恢复 | `agent.recovery.event` stage=recovering | 恢复阶段开始 |
| 10:51:29.934 | 恢复 | `agent_reasoning_started` | 模型生成恢复总结 |
| 10:51:29.935 | 恢复 | `agent_task_tree_updated` | 任务树标记 completed |
| 10:51:29.936 | 恢复 | `agent.recovery.event` recovered=true | 恢复完成 |
| 10:51:29.936 | 检查 | `agent.completion.checked` | **completionState=not_executed** |
| 10:51:29.937 | 结束 | `agent.run.finished` | **terminationReason=not_executed**，总耗时 49.9s |

## 3. 错误详情

### 3.1 直接原因

`aura_install_skill` 工具在递归遍历 GitHub 仓库目录时，请求以下 URL 返回 HTTP 403：

```
GET https://api.github.com/repos/anthropics/skills/contents/skills/docx/scripts/office/schemas/microsoft/wml-cex-2018.xsd?ref=main
→ HTTP 403
```

### 3.2 错误堆栈

```
Error: Failed to fetch https://api.github.com/repos/anthropics/skills/contents/.../wml-cex-2018.xsd?ref=main: HTTP 403
    at fetchJson (skillInstaller.mjs:107)
    at async writeGithubContents (skillInstaller.mjs:319)
    at async writeGithubContents (skillInstaller.mjs:314)  ← 递归调用
    at async writeGithubContents (skillInstaller.mjs:314)  ← 递归调用
    at async writeGithubContents (skillInstaller.mjs:314)  ← 递归调用
    at async writeGithubContents (skillInstaller.mjs:314)  ← 递归调用
    at async stageGithubSource (skillInstaller.mjs:356)
    at async resolveAuraSkillInstallSource (skillInstaller.mjs:609)
    at async Object.run (tools.mjs:2483)
```

### 3.3 错误分类

| 属性 | 值 |
|---|---|
| 错误类别 | `execution_failed` |
| 严重性 | `transient` |
| 可重试 | `retryable=true` |
| 重试配置 | maxRetries=1, initialDelay=500ms, maxDelay=3000ms, exponential_backoff |
| 实际重试次数 | 0（`shouldRetry(error, 1)` → `1 < 1` → false） |

### 3.4 GitHub API 403 的可能原因

1. **GitHub API 速率限制**：未认证请求限制 60 次/小时，遍历含大量文件的仓库容易触发
2. **仓库中某些路径需要认证**：大文件或 LFS 内容可能返回 403
3. **文件路径变化**：目标 .xsd 文件可能已被移动或删除

> 注：GitHub API 对未认证请求的速率限制通常返回 403 而非 429，当前错误分类将其归为 `execution_failed` 而非 `rate_limit`，导致重试策略不匹配。

## 4. 根因分析：为什么任务"中途停了"

### 4.1 完整调用链

```
runAgent()
  └→ runRouteFirstAgent()                     ← 外层 pass 循环 (MAX_ROUTE_RUNTIME_PASSES=5)
       └→ runProviderTurn()                    ← 中层
            └→ runOpenAiCompatibleAgent()      ← 内层 while 循环 (step < maxIterations)
                 ├→ [Step 0] 模型推理 → 产出 tool_call: aura_install_skill
                 ├→ invokeToolWithRetry()
                 │    └→ 工具执行 → HTTP 403 → ToolExecutionError
                 │    └→ shouldRetry(error, 1) → false (maxRetries=1)
                 ├→ formatToolErrorForTranscript() → 错误信息压入 transcript
                 ├→ hasUnresolvedToolError = true
                 └→ [Step 1] 再次调用模型（模型看到错误信息）
                      └→ 模型生成文本响应 → finalizedToolCalls.length === 0
                      └→ 循环退出 → 返回结果
                           └→ runRouteFirstAgent 进入恢复路径
                                └→ finalizeOpenAiCompatibleAnswer()（无 tools）
                                     └→ 生成文字总结 → 任务结束
```

### 4.2 三个断链点

#### 断链 1：错误信息缺乏行动指引

模型在 Step 1 收到的 tool result 内容：

```
Tool aura_install_skill execution failed.
Error category: execution_failed
Suggested action: 请展开详细信息查看原始错误，再决定下一步操作。
Detail: Error: Failed to fetch ... HTTP 403
```

问题：

- **`suggestedAction` 是面向用户的 UI 提示**，不是给模型的行动指引。"请展开详细信息查看原始错误"对模型来说毫无意义。
- **没有告诉模型它还有哪些可用工具**。模型不知道自己还有 `exec_command`、`run_shell`、`web_fetch` 可以用来完成安装。
- **SelfHealing 引擎未接入**。`selfHealing.mjs` 定义了 `ALTERNATIVE_TOOL`、`DECOMPOSE`、`FALLBACK_OR_SKIP` 等策略，但 `runOpenAiCompatibleAgent` 的工具执行循环（`providers.mjs:3382-3443`）完全没有调用 SelfHealing 引擎。

SelfHealing 引擎中已有的策略定义：

```javascript
// selfHealing.mjs
SelfHealingStrategy = {
  RETRY: 'retry',
  RECONSTRUCT_ARGS: 'reconstruct_args',
  ALTERNATIVE_TOOL: 'alternative_tool',   // ← 换工具
  REFRESH_AND_RETRY: 'refresh_and_retry',
  ESCALATE: 'escalate',
  DECOMPOSE: 'decompose',                 // ← 分解任务
  FALLBACK_OR_SKIP: 'fallback_or_skip',   // ← 降级跳过
}
```

这些策略只在 `taskPlanner.mjs`（graph 模式）和 `executor.mjs` 中使用，**route-first 模式下完全未接入**。

#### 断链 2：恢复阶段不携带 tools

当 Step 1 模型生成的响应触发恢复路径时（`agent.mjs:2060`），调用了 `finalizeOpenAiCompatibleAnswer()`：

```javascript
// providers.mjs:2870
body: JSON.stringify({
  model: settings.model,
  messages: transcript,
  stream: false,
  // ← 没有 tools 参数
})
```

恢复调用**没有传 tools**。模型在此上下文中变成了纯文本生成器，即使想到替代方案也无法执行。

#### 断链 3：模型响应被截断

模型在恢复阶段的输出以 "让我先尝试直接执行：" 结尾，看似未完成。原因：

1. 模型决定尝试替代方案，开始写 "让我先尝试直接执行："
2. 模型尝试输出工具调用，但恢复调用没有 tools
3. 模型可能以文本形式输出了工具调用（如 `exec_command("git clone ...")`），但不被系统识别
4. `extractInlineToolCalls()` 未从内容中提取到合法工具调用
5. `finalizedToolCalls.length === 0` → 循环退出 → 返回文本

最终指标：

| 指标 | 值 |
|---|---|
| outputTokens | 433 |
| completionState | `not_executed` |
| 总耗时 | 49.9 秒（其中工具执行 ~30 秒，恢复 ~10 秒） |

## 5. 执行日志体系评估

日志体系**工作正常**，完整记录了：

- 任务全生命周期（spawned → started → running → completed）
- 路由决策（route-first, standard path, execute mode, 22 tools mounted）
- 工具调用详情（输入参数、输出、错误堆栈、重试配置）
- 审批流程（required → submitted → approve_for_task）
- 恢复流程（recovering → recovered / not recovered）
- 最终状态（completionState, terminationReason, token usage, duration）

日志可用于的问题排查场景：
- 工具执行失败的根因定位
- 模型推理过程追溯
- 任务状态转换审计
- 性能瓶颈分析

## 6. 改进建议

### 已落地：Tool Failure Continuation Gate

本轮优化不采用“半截回答关键词判断”（例如匹配“让我先尝试”或冒号结尾）。这类启发式容易误伤正常表达，也不能真正解决执行状态判断问题。

已改为基于结构化 evidence / toolEvents 的 continuation gate：

1. **执行型工具识别补齐**
   - `aura_install_skill` 已加入执行/写入 evidence 识别。
   - 该工具失败后，`completionState` 会从原先容易落到的 `not_executed` 变成 `failed_after_execution`。
   - 这能让 route-first 与 Hybrid Graph 都明确知道“任务执行失败且未恢复”，而不是把失败当成普通未执行文本收尾。

2. **新增公共 Tool Failure Continuation Gate**
   - 新增 `bridge/agent/toolFailureContinuationGate.mjs`。
   - 当满足以下条件时触发 continuation：
     - 当前是 execute route；
     - completionState 为 `failed_after_execution`；
     - evidenceSummary 里仍有未恢复的执行型工具失败；
     - 未超过 continuation budget。
   - Gate 会生成 runtime repair note，包含最近失败工具、错误类别/细节、当前可用工具名，并要求模型继续用工具修复、替代执行或明确阻塞。

3. **route-first 接入 continuation gate**
   - `runRouteFirstAgent` 在 `enforceEvidencePolicy` / `applyCompletionGate` 后检查 gate。
   - 如果 gate 判断需要继续，不直接返回最终文本，而是把 repair note 注入 route notes 并进入下一 pass。
   - 默认最多继续 2 次，避免无限循环。

4. **Hybrid Graph 复用失败判定**
   - `resultMerger` 复用 Tool Failure Continuation Gate 的失败 continuation 判定。
   - Graph 层仍通过 `failed_after_execution -> recovery_step` 表达恢复路径。

5. **工具重试预算语义修正**
   - `shouldRetry()` 已改为 `currentAttempt <= maxRetries`。
   - `maxRetries=1` 现在表示“首次失败后允许再重试 1 次”，不再是实际 0 次重试。

已补测试：

- `bridge/agentEvidence.test.mjs`：覆盖 `aura_install_skill` 失败会进入 `failed_after_execution`。
- `bridge/agent/toolFailureContinuationGate.test.mjs`：覆盖 continuation 触发、预算耗尽、非 execute route 不触发。
- `bridge/toolErrors.test.mjs`：覆盖 `maxRetries=1` 的重试预算语义。
- `bridge/agent/stateGraphRuntime.test.mjs`：确认 Graph recovery continuation 仍正常。

本轮未做：

- 不在 `finalizeOpenAiCompatibleAnswer()` 中挂载 tools。
- 不引入关键词式 incomplete final answer guard。
- 不把完整 SelfHealing executor 搬进 provider loop；后续如果继续优化，可以把 SelfHealing 作为 repair hint provider 接到本 gate 后面。

### route-first 模式接入 SelfHealing 引擎

在 `runOpenAiCompatibleAgent` 的工具执行循环中，工具失败后调用 SelfHealing：

```javascript
// providers.mjs 工具执行循环中
if (!result.success && result.error instanceof ToolExecutionError) {
  const healingEngine = createSelfHealingEngine()
  const strategy = healingEngine.generateRepairStrategy(result.error, toolName)
  const repairResult = await healingEngine.executeRepair(strategy, toolCall, args)

  if (repairResult.hint) {
    // 将修复提示注入 transcript
    transcript.push({
      role: 'system',
      content: `[Self-Healing] ${repairResult.hint}`,
    })
  }
}
```

### 恢复阶段携带 tools

在 `finalizeOpenAiCompatibleAnswer()` 调用时传入当前可用的 tools：

```javascript
// agent.mjs 恢复路径
const recovered = await finalizeOpenAiCompatibleAnswer({
  settings,
  systemPrompt: lastSystemPrompt,
  messages,
  toolEvents,
  tools: allTools,  // ← 传入 tools
  // ...
})
```

## 7. 问题链路图

```
用户请求: 安装 docx skill
  │
  ▼
aura_install_skill 调用 GitHub API 递归下载仓库
  │
  ▼
HTTP 403 (遍历到 wml-cex-2018.xsd 时)
  │
  ├─ 错误分类: execution_failed (应为 rate_limit)
  ├─ 重试: maxRetries=1, 实际 0 次重试
  │
  ▼
formatToolErrorForTranscript()
  │
  ├─ 输出: "请展开详细信息查看原始错误，再决定下一步操作"
  ├─ SelfHealing 引擎: 未接入 (route-first 模式)
  ├─ 替代方案提示: 无
  │
  ▼
模型 Step 1: 看到错误信息
  │
  ├─ 知道失败了
  ├─ 不知道还能用什么工具
  ├─ 尝试文本回复: "让我先尝试直接执行："
  │
  ▼
恢复流程: finalizeOpenAiCompatibleAnswer()
  │
  ├─ tools: 未传入
  ├─ 模型变为纯文本生成器
  ├─ 有想法但无法执行
  │
  ▼
任务结束: completionState=not_executed
  │
  └─ 用户看到: 安装失败的文字说明（含截断的 "让我先尝试直接执行："）
```

---

*报告基于 `~/.aura/logs/app-2026-05-15.jsonl` 和源码分析生成。*
