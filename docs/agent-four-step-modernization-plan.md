# Aura Agent 四步现代化改造执行计划

> 日期：2026-05-14
> 基准分支：`feature_1.1.3-fix`
> 目标：在不丢失现有执行能力的前提下，将 Aura Agent 改造成可规划、可恢复、可观测、可分层执行的成熟 Agent Runtime。

---

## 1. 总目标

这次改造不以“代码看起来更像新架构”为目标，而以“Agent 真的更成熟、更稳定、更可验证”为目标。

四步完成后，Aura Agent 应具备：

1. **执行能力不退化**：现有 route-first、capability tier、skills/plugins/MCP、provider recovery、domain cooldown、evidence policy 都保留。
2. **简单任务足够快**：简单问答、单步读取、低风险小改走 Fast Path，不强行进入完整 Planner/State Graph。
3. **复杂任务足够稳**：长任务走 Planner/Executor 分离、State Graph、Checkpoint、Working Memory、结构化 completion。
4. **日志完整可诊断**：每次运行能从日志看出选择了哪条路径、为什么继续、为什么升级、为什么恢复、为什么完成。
5. **每步可回滚**：所有新执行路径通过 feature flag 开启，默认策略逐步切换。

---

## 2. 核心架构原则

### 2.1 不推倒现有执行能力

`feature_1.2.0` 的问题不是方向错，而是新 loop 没有完整迁移旧架构的执行能力。后续改造必须把当前分支已有能力当作“执行内核”，新架构先包裹它，再逐步接管它。

### 2.2 分层执行，不让简单任务变重

所有任务先进入轻量 classifier，再选择路径：

```
User Request
  -> Task Classifier
      -> Fast Path          # 简单问答 / 无工具 / 单步低风险
      -> Standard Path      # 常规工具任务 / 少量文件修改 / 简单验证
      -> Long Task Graph    # 多步骤 / 多文件 / 高风险 / 需要恢复和 checkpoint
```

Planner、完整 Memory、Checkpoint、State Graph 都是按需启用，不是每次强行启用。

### 2.3 Completion 基于证据，不基于文本长度

复杂执行任务不能因为模型写了一段看似完整的中间回复就结束。完成判断必须基于：

- 是否完成目标
- 是否有未处理 tool result
- 是否有未验证写入
- 是否有失败链未恢复
- 是否达到用户可接受的最终交付

### 2.4 日志是一等公民

每个改造阶段都必须同步补日志。后续测试和用户验证时，要能从日志回答这些问题：

- 本次任务走了 Fast / Standard / Long 哪条路径？
- 为什么选择这个路径？
- 挂载了哪些能力和工具？
- 每个 step 执行了什么？
- 是否发生 retry、recovery、escalation、compression、checkpoint？
- completion 为什么判定为完成或未完成？
- token、耗时、pass 数是否符合预期？

---

## 3. 四步执行总览

| 步骤 | 名称 | 核心产物 | 主要目的 |
|------|------|----------|----------|
| Step 1 | 能力基线与日志底座 | Golden tests + Runtime logs + 架构开关 | 先锁住现有能力，避免重构掉能力 |
| Step 2 | Fast Path 与 Runtime 抽取 | 分层执行路径 + completion/recovery/memory runtime | 简单任务更快，旧 loop 职责开始拆分 |
| Step 3 | Hybrid State Graph | Planner/Executor 分离 + Graph states + Checkpoint | 复杂任务可规划、可恢复、可解释 |
| Step 4 | 成熟化与默认切换 | 评估指标 + UI 日志看板增强 + 默认启用策略 | 让新架构稳定成为主路径 |

当前执行状态：

| 步骤 | 状态 | 说明 |
|------|------|------|
| Step 1 | 已完成首轮落地 | 已新增 runtime log 底座、架构模式归一、日志测试、Rust app log 接入、架构文档补充 |
| Step 2 | 已完成首轮落地 | 已新增轻量任务分类器、保守 Fast Path、Fast Path 日志与分类器测试；runtime 深抽取留到下一轮 |
| Step 3 | 已完成 | 已新增 Hybrid State Graph、动态 plan、状态转换日志、checkpoint/restore、自动验证续跑、失败恢复续跑；执行节点仍委托 route-first |
| Step 4 | 未开始 | 等前三步稳定后再做默认策略与日志看板增强 |

---

## 4. Step 1：能力基线与日志底座

### 4.1 改造内容

这一阶段不重写主循环，重点是“立规矩”和“装仪表盘”。

| 改造项 | 说明 | 建议文件 |
|--------|------|----------|
| 架构模式开关 | 增加 `agentArchitectureMode`: `legacy` / `hybrid` / `graph`，默认 `legacy` | `bridge/agent.mjs`、settings 类型 |
| Runtime trace id | 每次 agent run 生成 `runId`，贯穿 route、tool、memory、checkpoint、completion | `bridge/executionIds.mjs`、`bridge/ipc.mjs` |
| Golden capability tests | 建立现有能力保护测试集 | `bridge/agentGolden.test.mjs` 或分模块测试 |
| 统一 Agent 日志事件 | 在现有 hooks 基础上增加结构化 runtime log | `bridge/agentRuntimeLogs.mjs` |
| 文档化现有合约 | 记录 `messages`、`toolEvents`、`workMemories`、`routeDecision` 的语义 | `docs/ARCHITECTURE.md` |

### 4.2 必须锁住的现有能力

| 能力 | 验证场景 |
|------|----------|
| 文件读取 | 能准确读指定文件并回答 |
| 文件修改 | 能 apply patch / edit，并返回修改摘要 |
| 写入验证 | 写入后能 read back 或跑测试验证 |
| Provider recovery | Provider 在最终回答阶段失败时能 fallback |
| Route escalation | 当前 tier 能力不足时能升级或给出 budget stop reason |
| Domain cooldown | 同域连续 fetch 失败后能 short-circuit |
| Context compression | 压缩后仍能继续，不误删关键近期上下文 |
| skills/plugins/MCP | 启用能力后工具能被发现和挂载 |

### 4.3 日志规划

新增统一事件前缀：`agent.*`。

| 事件 | 触发时机 | 核心字段 |
|------|----------|----------|
| `agent.run.started` | Agent 开始 | `runId`, `sessionId`, `taskId`, `architectureMode`, `model`, `cwd` |
| `agent.path.selected` | 选择执行路径 | `pathMode`, `reason`, `confidence`, `estimatedRisk` |
| `agent.route.decision` | route decision 产生 | `capabilityTier`, `availableEscalations`, `mountedTools`, `budgets` |
| `agent.tool.event` | 工具开始/成功/失败 | `toolName`, `status`, `durationMs`, `errorCode`, `summary` |
| `agent.error.classified` | 错误归类 | `source`, `category`, `code`, `retryable`, `suggestedAction` |
| `agent.recovery.event` | recovery 开始/成功/失败 | `stage`, `recovered`, `fallbackUsed`, `partialMessageLength` |
| `agent.completion.checked` | 完成判断 | `completionState`, `issues`, `evidence`, `isComplete` |
| `agent.run.finished` | Agent 结束 | `status`, `terminationReason`, `totalPasses`, `inputTokens`, `outputTokens`, `durationMs` |

这些事件可以先写入现有 app log，同时继续通过 IPC hooks 给前端任务 UI 使用。

### 4.4 验证逻辑

自动验证：

1. Golden tests 全部通过。
2. 每次 agent run 至少产生 `agent.run.started` 和 `agent.run.finished`。
3. 有工具调用的 run 必须产生 `agent.tool.event`。
4. 有写入的 run 必须产生 `agent.completion.checked`，且包含 write verification 结果。
5. 有 provider error 的 run 必须产生 `agent.error.classified` 和 `agent.recovery.event`。

等待你验证：

1. 你用当前常见任务跑一轮，确认执行能力没有下降。
2. 你打开日志看板，能按 `runId` 看完整执行链路。
3. 你能从日志看出一次任务为什么成功、为什么失败、为什么恢复。

### 4.5 完成标准

Step 1 完成后，旧架构仍是默认执行路径，但任何后续改造都能被日志和测试保护起来。

首轮落地记录：

- 新增 `bridge/agentRuntimeLogs.mjs`，统一生成 `agent.*` runtime logs。
- `runAgent` 外层已接入 `agent.run.started`、`agent.path.selected`、`agent.completion.checked`、`agent.error.classified`、`agent.run.finished`。
- `route-first` 在 runtime 日志中归一为 `architectureMode: "legacy"`；`hybrid` / `graph` 已进入 Step 3 的图式外壳，执行节点仍委托 route-first。
- `bridge/ipc.mjs` 已支持 `runtime_log` 事件。
- Rust 侧已将 `runtime_log` 写入现有 app log，事件名保持 `agent.*`。
- 已新增 `bridge/agentRuntimeLogs.test.mjs` 覆盖架构模式归一、fallback、日志基础字段、hooks 转发、完成/错误摘要。
- [docs/ARCHITECTURE.md](/Users/fanhuaze/Documents/YunWork/desk-agent/docs/ARCHITECTURE.md) 已补充 Agent Runtime 日志与数据合约。

---

## 5. Step 2：Fast Path 与 Runtime 抽取

### 5.1 改造内容

这一阶段开始拆 `agent.mjs`，但仍保持当前 route-first 能力为主。

| 改造项 | 说明 | 建议文件 |
|--------|------|----------|
| Task classifier | 轻量判断任务复杂度和风险 | `bridge/agent/taskClassifier.mjs` |
| Fast Path | 简单问答、无工具、单步读取直接执行 | `bridge/agent/fastPath.mjs` |
| Standard Path | 常规 route-first loop，但接入 runtime 模块 | `bridge/agent/standardPath.mjs` |
| Completion Runtime | 抽出 completion/evidence 判断 | `bridge/agent/completionRuntime.mjs` |
| Recovery Runtime | 抽出 provider recovery/fallback | `bridge/agent/recoveryRuntime.mjs` |
| Memory Runtime | 抽出 Working Memory 与 tool result carryover | `bridge/agent/memoryRuntime.mjs` 或 `bridge/memory/*` |

### 5.2 路径选择规则

| 路径 | 进入条件 | 禁用内容 |
|------|----------|----------|
| Fast Path | 简单解释、无需工具、或单个只读工具即可完成 | 不启用 Planner，不建完整 checkpoint，不注入完整 memory |
| Standard Path | 1-3 步工具、普通文件改动、简单验证 | 不启用完整 State Graph，只启用轻量 Working Memory |
| Long Task Graph | 多文件、多步骤、高风险、长任务、需要恢复/压缩 | 启用 Planner、Checkpoint、完整 completion gate |

Fast Path 必须能被日志证明没有走重流程。

### 5.3 日志规划

Step 2 增加这些事件：

| 事件 | 触发时机 | 核心字段 |
|------|----------|----------|
| `agent.classifier.result` | 任务分类完成 | `pathMode`, `complexity`, `risk`, `requiresTools`, `requiresWrite`, `reason` |
| `agent.fast_path.started` | Fast Path 开始 | `runId`, `reason` |
| `agent.fast_path.finished` | Fast Path 结束 | `status`, `durationMs`, `toolCount`, `inputTokens`, `outputTokens` |
| `agent.runtime.extracted` | 临时开发日志，确认模块接管点 | `runtimeName`, `legacyParity` |
| `agent.memory.updated` | Working Memory 更新 | `entryType`, `toolName`, `entryId`, `preservedForPrompt` |

### 5.4 验证逻辑

自动验证：

1. 简单问答任务日志中 `pathMode=fast`，没有 `agent.plan.created`，没有 checkpoint。
2. 单文件只读任务最多一次工具调用，`totalPasses <= 1`。
3. 简单任务 token 使用不高于 legacy 同类任务，或至少没有明显增加。
4. 文件写入任务不会走 Fast Path，必须进入 Standard 或 Long。
5. Provider recovery 抽出后，原 recovery 测试仍通过。

等待你验证：

1. 你用简单任务试跑，确认速度没有变慢。
2. 你用普通修改任务试跑，确认仍能改文件、验证、总结。
3. 你通过日志确认简单任务没有进入 Planner/Checkpoint 重流程。

### 5.5 完成标准

Step 2 完成后，Aura 具备分层执行能力：简单任务轻，常规任务稳，复杂任务为下一步 State Graph 做准备。

首轮落地记录：

- 新增 `bridge/agent/taskClassifier.mjs`，先用确定性规则识别 `fast` / `standard` / `long`。
- Fast Path 只处理非常明确的简单无工具问答；附件、工作区/文件、写入/执行、网页/最新信息、复杂架构任务都会继续走标准 route-first。
- `runAgent` 已记录 `agent.classifier.result`，并根据分类结果记录更准确的 `agent.path.selected`。
- Fast Path 已接入 `agent.fast_path.started` 和 `agent.fast_path.finished` 日志。
- 新增 `bridge/agent/taskClassifier.test.mjs`，覆盖简单问答、文件任务、写入任务、复杂任务、网页/最新信息、附件任务。
- 本轮只完成 Fast Path 和分类器的安全切入；`completionRuntime`、`recoveryRuntime`、`memoryRuntime` 的深抽取放到 Step 2 下一轮，避免和执行路径变化叠加过大。

---

## 6. Step 3：Hybrid State Graph 与 Planner/Executor 分离

### 6.1 改造内容

这一阶段引入真正的 Hybrid State Graph，但节点内部复用当前成熟 runtime。

目标状态图：

```
INIT
  -> CLASSIFY
  -> PLAN?              # Fast/Standard 可跳过
  -> SELECT_CAPABILITY
  -> EXECUTE_STEP
  -> OBSERVE
  -> VERIFY
  -> DECIDE_NEXT
      -> EXECUTE_STEP
      -> RECOVER
      -> ESCALATE
      -> CHECKPOINT
      -> FINALIZE
      -> BLOCKED
```

| 改造项 | 说明 | 建议文件 |
|--------|------|----------|
| State Graph Runtime | 管理状态、条件边、termination reason | `bridge/agent/stateGraphRuntime.mjs` |
| Planner Runtime | 生成结构化 plan/subtasks/success criteria | `bridge/agent/plannerRuntime.mjs` |
| Executor Runtime | 执行单个 step，调用现有 tool routing | `bridge/agent/executorRuntime.mjs` |
| Checkpoint Runtime | 每个关键状态保存可恢复快照 | `bridge/agent/checkpointRuntime.mjs` |
| Result Merger | 合并 subtask 结果、artifact、evidence | `bridge/agent/resultMerger.mjs` |

### 6.2 Planner / Executor 合约

Planner 输出：

```json
{
  "goal": "用户目标",
  "pathMode": "long",
  "subtasks": [
    {
      "id": "subtask-1",
      "title": "检查当前实现",
      "requiredCapability": "read-only",
      "successCriteria": ["找到入口文件", "确认现有行为"],
      "dependencies": [],
      "status": "pending"
    }
  ]
}
```

Executor 输出：

```json
{
  "subtaskId": "subtask-1",
  "status": "completed",
  "evidence": ["tool:event-id", "file:/path/to/file"],
  "artifacts": [],
  "errors": [],
  "nextRecommendation": "继续执行 subtask-2"
}
```

Planner 不直接调用工具；Executor 不随意改计划，只反馈执行结果和建议。

### 6.3 日志规划

Step 3 增加这些事件：

| 事件 | 触发时机 | 核心字段 |
|------|----------|----------|
| `agent.graph.transition` | 状态转换 | `from`, `to`, `reason`, `passIndex`, `stepId` |
| `agent.plan.created` | Planner 产出计划 | `planId`, `subtaskCount`, `risk`, `estimatedSteps` |
| `agent.plan.updated` | 子任务状态更新 | `planId`, `subtaskId`, `oldStatus`, `newStatus`, `evidenceCount` |
| `agent.step.started` | Executor 开始 step | `stepId`, `subtaskId`, `capabilityTier`, `toolsAvailable` |
| `agent.step.finished` | Executor 完成 step | `stepId`, `status`, `durationMs`, `toolCount`, `evidenceCount` |
| `agent.checkpoint.created` | checkpoint 创建 | `checkpointId`, `state`, `subtaskId`, `toolEventCount`, `memoryEntryCount` |
| `agent.checkpoint.restored` | checkpoint 恢复 | `checkpointId`, `restoredState`, `reason` |
| `agent.escalation.event` | 能力升级 | `fromTier`, `toTier`, `reason`, `budgetBefore`, `budgetAfter` |

### 6.4 验证逻辑

自动验证：

1. Long Task 日志必须出现 `agent.plan.created`。
2. 每个 `agent.step.started` 必须有对应 `agent.step.finished` 或 `agent.recovery.event`。
3. 每次状态转换必须有 `reason`。
4. 工具失败链能进入 `RECOVER` 或 `ESCALATE`，不能静默结束。
5. 写入后未验证时，`VERIFY -> DECIDE_NEXT` 必须继续执行验证或进入 blocked，而不是 completed。
6. checkpoint restore 测试能从中断点恢复 plan/subtask/memory。

等待你验证：

1. 你给一个真实复杂任务，确认 Agent 能分解、执行、验证、汇总。
2. 你查看日志，能看懂每个子任务为什么执行、如何完成。
3. 你故意制造失败场景，确认 Agent 会恢复/升级，而不是直接坏掉。

### 6.5 完成标准

Step 3 完成后，Aura 对复杂任务具备 Planner/Executor 分离和 State Graph 控制，但仍保留当前执行内核，不重演 1.2.0 的能力丢失问题。

首轮落地记录：

- 新增 `bridge/agent/stateGraphRuntime.mjs`，提供 `AgentGraphState`、`createHybridPlan`、`runHybridStateGraph`。
- `long` 路径会进入 Hybrid State Graph，生成三段式结构化 plan：理解约束、委托 route-first 执行、验证并合并结果。
- Graph 的 `EXECUTE_STEP` 节点仍调用现有 `runRouteFirstAgent`，保留当前 capability selection、tool routing、provider recovery、evidence policy、checkpoint manager。
- 已接入 `agent.plan.created`、`agent.plan.updated`、`agent.graph.transition`、`agent.step.started`、`agent.step.finished`、`agent.checkpoint.created`。
- route-first 执行失败时，Graph 会进入 `RECOVER` 状态，并把 `graphPlan` / `graphState` 挂到错误对象上。
- 新增 `bridge/agent/stateGraphRuntime.test.mjs`，覆盖 plan 创建、成功路径状态转换、失败路径 recovery transition。
- `bridge/agentFastPath.test.mjs` 已补复杂任务验证，确保复杂任务进入 Hybrid Graph 而不是 Fast Path。

第三步继续落地记录：

- 新增 `bridge/agent/plannerRuntime.mjs`、`executorRuntime.mjs`、`checkpointRuntime.mjs`、`resultMerger.mjs`，把计划生成、委托执行、图 checkpoint、结果合并从 `stateGraphRuntime` 中拆成明确合约。
- `AgentGraphState` 补齐 `CHECKPOINT`、`ESCALATE`、`COMPLETED`；成功路径现在为 `... -> VERIFY -> DECIDE_NEXT -> FINALIZE -> COMPLETED`，未验证/失败/审批或能力阻塞路径进入 `BLOCKED`。
- Graph 会在委托 route-first 前和观察结果后创建可恢复 checkpoint；恢复 API 会还原 `plan`、`classification`、图状态、工具事件摘要，且不会持久化 `apiKey`。
- `Executor` 产出结构化 step result：`status`、`evidence`、`artifacts`、`errors`、`nextRecommendation`；`ResultMerger` 负责把 `completionState` 转成 `graphCompletion` 和 `terminationReason`。
- Runtime hooks 已补 `agent.escalation.event`，根据 route decision 的 `escalationCount` 记录能力升级。
- `agent.run.finished` 会保留 graph 产出的 `blocked` 状态，不再把结构化阻塞统一写成 `completed`。
- 扩展 `bridge/agent/stateGraphRuntime.test.mjs`，新增未验证写入进入 `BLOCKED` 的回归；新增 `bridge/agent/checkpointRuntime.test.mjs` 覆盖 checkpoint restore 与敏感设置清理。

第三步循环能力补充记录：

- `DECIDE_NEXT` 现在会根据结构化 completion decision 生成 continuation subtask；`executed_unverified` 会追加 `verification_step` 并再次委托 route-first 执行验证，超过 `maxGraphPasses` 后才进入 `BLOCKED`。
- `failed_after_execution` 会追加 `recovery_step`，让 Graph 层在 route-first 返回失败状态但未抛异常时也能尝试一次结构化恢复。
- capability blocker 会显式记录 `DECIDE_NEXT -> ESCALATE -> BLOCKED`，让日志能区分“需要升级”与普通失败。
- `ResultMerger` 已返回 `graphExecutions`，用于保留多轮 subtask 执行历史；最终 `graphExecution` 仍指向最近一次执行，方便现有 UI/日志消费。
- continuation request 会保留原始目标、上一轮 completion state、近期 evidence/error 摘要，并通过 `carryoverContext` 注入，不改变 route-first 工具挂载和 provider recovery 语义。
- `bridge/agent/stateGraphRuntime.test.mjs` 已覆盖自动验证续跑、pass limit 后阻塞、失败结果 recovery 续跑、capability blocker escalation transition。

第三步收尾完成记录：

- `PlannerRuntime` 会根据分类信号生成动态执行计划：workspace 写入任务会先拆出 `inspect_step` 再进入 `execute`，需要当前信息的任务会拆出 `research_step`。
- `runHybridStateGraph` 会按计划执行多个 runnable subtask，并在每个关键状态创建 checkpoint；已完成的 planned subtask 不会被重复执行。
- `runtime.graphCheckpoint` / `runtime.restoreGraphCheckpoint` 已接入 `runAgent`，传入 graph checkpoint 会强制进入 long graph 路径并发出 `agent.checkpoint.restored`、`agent.plan.restored`。
- checkpoint restore 支持 `ExecutionCheckpoint` 实例和 JSON 快照；恢复时沿用当前请求的 live settings/API key，只从 checkpoint 恢复 messages、plan、classification、logContext 等执行上下文。
- Step 3 相关测试覆盖动态 plan、动态 planned subtask 顺序执行、Graph 自动验证、Graph recovery continuation、capability escalation transition、checkpoint restore、`runAgent` 恢复入口。
- 截至本记录，Step 3 的计划项已全部完成；剩余成熟化、默认策略、日志看板与指标汇总进入 Step 4。

---

## 7. Step 4：成熟化、默认切换与测试闭环

### 7.1 改造内容

这一阶段让新架构从“可用”变成“默认可靠”。

| 改造项 | 说明 | 建议文件 |
|--------|------|----------|
| 默认策略切换 | 根据任务类型默认启用 Fast/Standard/Graph | `bridge/agent.mjs` |
| 指标面板 | 在日志看板中展示 run path、duration、tokens、passes、recovery | `src/LogViewerWindowApp.tsx` |
| Regression suite | 固化四步改造后的端到端测试 | `bridge/*test.mjs` |
| Replay / Diagnose | 能按 `runId` 聚合一次任务的全部日志 | 日志看板与 app log 查询 |
| 架构文档更新 | 更新最终架构、模块职责、调试指南 | `docs/ARCHITECTURE.md` |

### 7.2 成熟度指标

| 指标 | 目标 |
|------|------|
| 简单任务路径命中率 | 简单任务大部分命中 Fast Path |
| 简单任务 token 增量 | 相比 legacy 不明显增加 |
| 长任务提前结束率 | 显著下降，未验证写入不允许完成 |
| Recovery 成功率 | Provider/tool 异常时能给出可用 fallback 或继续执行 |
| Checkpoint 可恢复率 | 中断后能恢复 plan/subtask/memory |
| 日志可诊断性 | 通过 runId 能还原完整执行链 |
| 能力保持率 | Golden tests 全部通过 |

### 7.3 日志规划

Step 4 增加汇总类事件：

| 事件 | 触发时机 | 核心字段 |
|------|----------|----------|
| `agent.metrics.summary` | run 结束 | `pathMode`, `durationMs`, `totalPasses`, `toolCount`, `checkpointCount`, `recoveryCount`, `inputTokens`, `outputTokens` |
| `agent.validation.summary` | 测试或手动验证后 | `scenario`, `passed`, `expectedPath`, `actualPath`, `notes` |
| `agent.architecture.fallback` | 新路径需要回退 legacy | `fromMode`, `toMode`, `reason`, `errorCode` |

### 7.4 验证逻辑

自动验证：

1. 所有 Golden tests 通过。
2. Fast / Standard / Long 三类路径都有测试覆盖。
3. 日志 schema 校验通过：关键事件字段完整。
4. Hybrid/Graph 模式失败时能进入 `RECOVER` 或显式回退 legacy，并记录对应日志。
5. 压缩、checkpoint、recovery、escalation 都有独立回归测试。

等待你验证：

1. 你用一组真实任务做验收：简单问答、单文件修改、多文件重构、web 失败、provider 失败。
2. 你通过日志看板确认每类任务都能解释路径选择和完成原因。
3. 你确认默认策略开启后，日常使用没有明显变慢，复杂任务更稳。

### 7.5 完成标准

Step 4 完成后，Aura 的默认 Agent Runtime 应达到：

- 简单任务快
- 普通任务稳
- 复杂任务可规划
- 失败任务可恢复
- 长任务可 checkpoint
- 执行过程可通过日志完整复盘

---

## 8. 统一日志 Schema

所有 Agent runtime 日志建议统一包含这些基础字段：

```json
{
  "runId": "run-...",
  "sessionId": "session-...",
  "taskId": "task-...",
  "assistantMessageId": "message-...",
  "architectureMode": "legacy|hybrid|graph",
  "pathMode": "fast|standard|long",
  "phase": "classify|plan|execute|verify|recover|finalize",
  "state": "INIT|CLASSIFY|PLAN|EXECUTE_STEP|VERIFY|FINALIZE",
  "passIndex": 0,
  "stepId": "step-...",
  "subtaskId": "subtask-...",
  "capabilityTier": "read-only|local-write|web-lookup|browser-interactive",
  "eventVersion": 1
}
```

不同事件再追加自己的专属字段，例如 `toolName`、`durationMs`、`completionState`、`terminationReason`、`checkpointId`。

日志必须遵守：

1. **不记录完整敏感内容**：文件内容、API key、大段模型输出要截断或摘要。
2. **不让日志影响主流程**：写日志失败只能吞掉，不能中断 Agent。
3. **事件名稳定**：后续日志看板和测试都依赖事件名。
4. **每个 run 可聚合**：`runId` 必须贯穿所有事件。
5. **每个结束可解释**：`agent.run.finished` 必须有 `status` 和 `terminationReason`。

---

## 9. 验收任务集

后续每步完成后，可以用下面任务集验收。

| 类型 | 示例任务 | 期望路径 | 核心日志 |
|------|----------|----------|----------|
| 简单问答 | “解释这个函数的作用” | Fast | `agent.path.selected(pathMode=fast)` |
| 单文件读取 | “看一下 README 里安装步骤” | Fast 或 Standard | `toolCount <= 1` |
| 单文件修改 | “把按钮文案改成 X” | Standard | `completionState=executed_verified` |
| 多文件修改 | “重构 provider 设置页” | Long | `agent.plan.created`、多个 `agent.step.finished` |
| 写入未验证 | “改完不跑测试”场景 | Standard/Long | `agent.completion.checked(isComplete=false)` |
| Provider 失败 | 模拟 finalization error | Standard/Long | `agent.recovery.event(fallbackUsed=true)` |
| Web 同域失败 | 连续抓取失败 URL | Standard/Long | `agent.error.classified(code=RETRIEVAL_DOMAIN_COOLDOWN)` |
| 压缩恢复 | 长上下文任务 | Long | `agent.checkpoint.created`、`context_compression` |
| 能力升级 | 只读 tier 遇到写入需求 | Standard/Long | `agent.escalation.event` |

---

## 10. 推荐执行顺序

1. 先做 Step 1，不改行为，只加测试、日志、开关。
2. 再做 Step 2，让简单任务变轻，并把 completion/recovery/memory 从大 loop 抽出来。
3. 再做 Step 3，用 Hybrid State Graph 管复杂任务，保留当前执行内核。
4. 最后做 Step 4，把日志看板和默认策略补齐，再逐步把新路径设为默认。

这条路线的核心是：**先保护能力，再拆分职责，再引入图，再默认启用**。
