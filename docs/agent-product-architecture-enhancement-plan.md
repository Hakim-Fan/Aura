# Aura Agent 产品化架构增强四步计划

> 日期：2026-05-16
> 参考对象：`workany-dev`、`open-agent-sdk-typescript-main`
> 基准状态：Aura 已完成 Fast Path + Route-first Stable Core + Hybrid State Graph + Checkpoint + Runtime Logs 的 Agent Runtime 改造。

---

## 1. 总目标

前一轮四步改造解决的是 Agent Runtime 的成熟度：简单任务快，普通任务稳，复杂任务可规划、可恢复、可诊断。

这一轮四步计划解决的是产品应用架构成熟度：让 Aura 不只是一个能执行任务的 Agent Runtime，而是一个更接近生产级产品的桌面 Agent 平台。

最终目标：

1. **保留 Aura 自研执行内核**：不把核心 loop 替换成 `@codeany/open-agent-sdk` 的通用 ReAct loop。
2. **吸收 SDK 的产品化能力**：标准 hook 生命周期、工具目录组织、session transcript、skills/MCP 一等入口；任务/后台执行模型放入任务二期。
3. **吸收 WorkAny 的应用架构优点**：本期只吸收计划确认和风险审批；任务管理、产物面板、后台任务切换放入任务二期。
4. **形成生产级闭环**：Agent run 可追踪、会话可恢复、工具可治理、权限可审计、日志可复盘、指标可验收。

---

## 2. 架构原则

### 2.1 内核不替换，只增强外围

`open-agent-sdk-typescript-main` 的优势是通用 SDK 能力面宽，包括 hooks、tools、MCP、skills、session、subagents、task/team/worktree 等。

但它的执行模型仍然是：

```text
API call -> tools -> repeat
```

Aura 现在的执行模型是：

```text
Task Classifier
  -> Fast Path
  -> Route-first Standard Path
  -> Hybrid State Graph Long Path
```

后续改造应该让 SDK/WorkAny 的产品化能力挂到 Aura Runtime 外围，而不是把 Aura 的 `completion gate`、`checkpoint`、`structured errors`、`runtime logs` 换掉。

### 2.2 产品架构补齐四个面

生产级桌面 Agent 需要四个面同时成熟：

| 面向 | 当前 Aura 优势 | 需要补齐 |
|------|----------------|----------|
| 执行内核 | Hybrid Runtime、Checkpoint、Recovery、Completion Gate | 继续保持 |
| 产品流程 | 会话、消息、工具事件、审批、按会话绑定运行中任务、最终变更文件卡片已有基础 | 本期只做计划确认与风险审批；任务中心、后台任务增强、产物面板放入任务二期 |
| 扩展生态 | MCP、插件、技能已有基础 | 标准工具目录、Hook API、Skill/MCP 产品化入口 |
| 运营诊断 | Runtime Logs、Metrics Summary 已有基础 | 指标看板、运行级验收、审计日志、长期趋势 |

### 2.3 每一步都要有日志和验证

每个阶段交付时都必须回答：

- 用户能不能看懂 Agent 接下来要做什么？
- 任务失败后能不能知道失败在哪一层？
- Agent run 恢复后能不能找回上下文、checkpoint 和日志？
- 工具、技能、MCP 的启用和禁用能不能被审计？
- 简单任务是否仍然走 Fast Path，不被产品化流程拖慢？

---

## 3. 四步执行总览

| 步骤 | 名称 | 核心产物 | 主要目的 |
|------|------|----------|----------|
| Step 1 | 标准 Hook 与工具目录治理 | Runtime Hook Bus + Tool Catalog | 把 Agent 生命周期和工具能力产品化、可扩展、可审计 |
| Step 2 | Session / Run 持久化 | 运行记录 + transcript + checkpoint 索引 | 让每次 Agent run 可恢复、可追踪、可复盘 |
| Step 3 | Plan Approval 与风险审批 UX | 计划确认 + 风险分级 + 审批门 | 吸收 WorkAny 的计划确认优势，但不引入任务中心/产物面板改造 |
| Step 4 | 生产验收与诊断质量面板 | Log Viewer 增强 + 验收场景集 + 权限审计 | 让架构从“能跑”进入“可诊断、可验收、可交付” |

当前执行状态：

| 步骤 | 状态 | 说明 |
|------|------|------|
| Step 1 | 已完成首轮落地 | 已新增 Runtime Hook Bus、Tool Catalog 元数据、工具权限/审计日志、Hook block 测试和工具目录测试；不改变现有工具执行内核 |
| Step 2 | 已完成首轮落地 | 已新增 `agent_runs`、`agent_run_checkpoints` 持久化表；runtime log 自动按 `runId` upsert run 记录，并提供查询命令 |
| Step 3 | 未开始 | Plan Approval 与风险审批 UX 待设计与实现 |
| Step 4 | 未开始 | 诊断质量面板、验收场景集与权限审计待设计与实现 |

---

## 4. Step 1：标准 Hook 与工具目录治理

### 4.1 改造内容

这一阶段吸收 `@codeany/open-agent-sdk` 的 hook lifecycle 和 tool catalog 优点，但保留 Aura 当前工具执行链。

新增一层标准 Runtime Hook Bus：

```text
Aura Agent Runtime
  -> Hook Bus
      -> PreRun / PostRun
      -> PreToolUse / PostToolUse / PostToolUseFailure
      -> PreCompact / PostCompact
      -> PermissionRequest / PermissionDenied
      -> PlanCreated / PlanApproved / PlanRejected
      -> CheckpointCreated / CheckpointRestored
      -> SessionStart / SessionEnd
```

工具目录治理目标：

| 改造项 | 说明 | 建议落点 |
|--------|------|----------|
| Tool Catalog | 把工具元数据、schema、权限、风险等级、展示分组集中管理 | `bridge/tools/catalog.mjs` |
| Tool Adapter | 保留现有工具实现，外层包一层标准 metadata/permission/log contract | `bridge/tools/adapter.mjs` |
| Hook Bus | 所有生命周期事件先进入统一 hook bus，再转发 runtime log / UI / plugin hook | `bridge/agent/hookBus.mjs` |
| Permission Contract | 将工具权限从分散判断收敛成标准 `permissionRequest` 数据结构 | `bridge/permissions/*` |
| Tool Audit Log | 记录工具启用、禁用、调用、失败、审批、拒绝 | `agent.tool.*` logs |

首轮落地结果：

- 新增 `bridge/agent/hookBus.mjs`，提供 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied` 等标准 Hook 事件。
- 新增 `bridge/tools/catalog.mjs`，统一推导工具 `riskLevel`、`permissionScope`、`approvalCategory` 等治理元数据。
- `invokeTool` 已接入 `PreToolUse` / `PostToolUse` / `PostToolUseFailure`，Hook 可显式阻止工具调用；Hook 自身异常不会影响主执行路径。
- 工具事件和 runtime log 已补 `riskLevel`、`permissionScope`、`approvalCategory`，并新增权限与审计日志。
- `createToolRegistry` 已生成 catalog 摘要，route-first 初始化工具池时会记录 `agent.tool.catalog.loaded`。

### 4.2 日志规划

新增或标准化事件：

| 事件 | 说明 |
|------|------|
| `agent.hook.invoked` | Hook 被触发 |
| `agent.hook.blocked` | Hook 阻止执行 |
| `agent.tool.catalog.loaded` | 工具目录加载完成 |
| `agent.tool.permission.requested` | 工具请求权限 |
| `agent.tool.permission.resolved` | 权限被允许、拒绝或自动通过 |
| `agent.tool.audit` | 工具调用审计摘要 |

### 4.3 验证逻辑

自动验证：

1. 原有 `bridge/**/*.test.mjs bridge/*.test.mjs` 全部通过。
2. 每个工具调用必须产生 `PreToolUse` 与 `PostToolUse` 或 `PostToolUseFailure`。
3. 写入类、shell 类、高风险浏览器类工具必须带 `riskLevel` 和 `permissionScope`。
4. 禁用工具时，Agent 能得到结构化拒绝原因，而不是普通字符串错误。
5. Hook Bus 出错不能影响 Agent 主执行路径，除非 hook 明确返回 `blocked`。

人工验证：

1. 在日志看板按 `runId` 查看一次写文件任务，能看到工具权限、工具开始、工具完成、完成验证。
2. 禁用某个工具后发起相关任务，UI 和日志都能解释为什么不能执行。

---

## 5. Step 2：Session / Run 持久化

### 5.1 改造内容

这一阶段吸收 WorkAny 的任务/消息持久化，以及 SDK 的 session transcript 思路。

Aura 当前已有会话和消息持久化，但 Agent Runtime 的执行态、checkpoint、日志之间还需要更强关联。

目标数据模型：

```text
Session
  -> Messages
  -> AgentRuns
      -> RuntimeLogs
      -> Checkpoints
      -> ToolEvents
      -> ValidationResults
```

建议新增或补齐的数据对象：

| 对象 | 作用 |
|------|------|
| `AgentRunRecord` | 一次 Agent 执行的主记录，绑定 `runId`、`sessionId`、`taskId`、`messageId` |
| `TranscriptRecord` | 用户可读 transcript，区别于模型上下文 messages |
| `CheckpointRecord` | Graph checkpoint 的可恢复快照索引 |
| `ValidationRecord` | 测试、typecheck、人工验收、日志验收结果 |

说明：后台任务中心、任务切换、统一产物面板属于任务二期；本步骤只保存当前 Agent run 的必要恢复与复盘数据，不做新的任务管理 UI。

首轮落地结果：

- Rust SQLite schema 新增 `agent_runs`，保存 `runId`、session/message/task 关联、路径模式、状态、token、耗时、完成状态、错误摘要等字段。
- Rust SQLite schema 新增 `agent_run_checkpoints`，保存 `agent.checkpoint.created` / `agent.checkpoint.restored` 的 checkpoint 索引。
- Rust stdout runtime log 处理链路会在收到 `runtime_log` 时自动持久化 Agent run；写入失败只记录 `agent_run_persist_failed` app log，不影响 Agent 主执行。
- 新增 Tauri 查询命令：`list_agent_runs_sqlite`、`load_agent_run_sqlite`。
- 前端 persistence wrapper 新增 `listPersistedAgentRuns`、`loadPersistedAgentRun`，类型定义为 `AgentRunRecord` / `AgentRunCheckpointRecord`。

### 5.2 持久化边界

| 数据 | 是否长期保存 | 说明 |
|------|--------------|------|
| 用户消息和最终回答 | 是 | 产品历史 |
| Tool result 摘要 | 是 | 复盘需要 |
| 大段命令输出 / 文件内容 | 默认摘要保存 | 避免数据库膨胀和敏感信息泄露 |
| Graph checkpoint | 是，按数量/时间清理 | 支持恢复 |
| Runtime logs | 是，支持按 runId 查询 | 支持诊断 |
| Provider 原始响应 | 默认不保存 | 避免敏感和体积问题 |

### 5.3 日志规划

新增或标准化事件：

| 事件 | 说明 |
|------|------|
| `agent.session.started` | 会话级 Agent 上下文开始 |
| `agent.session.transcript.updated` | transcript 写入 |
| `agent.run.persisted` | Agent run 主记录写入 |
| `agent.run.status.changed` | Agent run 状态变化 |
| `agent.checkpoint.persisted` | checkpoint 写入持久层 |

首轮实现说明：当前没有新增 Node runtime 事件，持久化由 Rust runtime log 消费端自动完成；失败时写 `agent_run_persist_failed` app log。后续如果诊断面板需要展示持久化状态，再补 `agent.run.persisted` / `agent.checkpoint.persisted` UI 事件。

### 5.4 验证逻辑

自动验证：

1. 创建 Agent run 后，数据库中能通过 `runId` 找到 runtime logs、tool events、checkpoint。
2. Agent 中断后，能从最近 checkpoint 恢复到明确状态，而不是只恢复聊天文本。
3. 大输出只保存摘要或引用，不把完整大输出塞进消息上下文。
4. 删除会话时，相关 run/checkpoint/runtime log 按规则清理。

人工验证：

1. 执行一个多步骤任务后，能按 `runId` 看到 transcript、checkpoint、日志摘要。
2. 重启应用后，仍能打开同一会话并看到最近 run 的恢复与复盘信息。

---

## 6. Step 3：Plan Approval 与风险审批 UX

状态：已完成首轮落地。

### 6.1 改造内容

这一阶段只吸收 WorkAny 的两阶段计划确认体验，同时结合 Aura 的 Hybrid State Graph。

后台运行、任务切换、产物面板不进入本步骤，统一放到任务二期。

不是让所有任务都强行计划确认，而是按风险和复杂度触发：

```text
Fast Path
  -> 直接回答

Standard Path
  -> 低风险自动执行
  -> 中风险显示轻量确认

Long Path / High Risk
  -> 生成 plan
  -> 用户 approve / edit / reject
  -> 进入 Hybrid State Graph 执行
```

核心产品能力：

| 能力 | 说明 |
|------|------|
| Plan Preview | 展示目标、步骤、风险、将使用的工具、预计验证方式 |
| Plan Approval | 用户可批准、拒绝、编辑计划 |
| Risk Summary | 展示写入、shell、浏览器、外部服务等风险 |
| Validation Plan | 展示预计验证命令、验证依据或人工验收点 |
| Approval Result | 将批准、拒绝、编辑结果写入 runtime log |

### 6.2 Runtime 集成

Plan Approval 不替换 Hybrid Graph，而是作为 Graph 执行前的人工门：

```text
Task Classifier
  -> Long Path
  -> PlannerRuntime.createPlan()
  -> PlanApproval Gate
      -> approved: runHybridStateGraph()
      -> edited: regenerate/patch plan
      -> rejected: stop with user_cancelled
```

对普通任务保持轻量：

- 简单问答不出现计划确认。
- 单文件低风险修改可以只展示一行风险提示或直接执行。
- 多文件、高风险 shell、外部系统操作默认需要计划确认。

### 6.3 日志规划

新增或标准化事件：

| 事件 | 说明 |
|------|------|
| `agent.plan.preview.created` | 计划预览生成 |
| `agent.plan.approval.requested` | 请求用户确认 |
| `agent.plan.approval.resolved` | 用户批准、编辑或拒绝 |
| `agent.plan.risk.summarized` | 计划风险摘要生成 |

### 6.4 验证逻辑

自动验证：

1. Fast Path 不触发 plan approval。
2. Long Path 可生成结构化 plan preview。
3. 用户拒绝计划时，不调用写入类工具，并记录 `user_cancelled`。
4. 用户批准计划后，Graph 从 checkpoint 记录的计划开始执行。
5. 风险摘要必须包含即将使用的高风险工具类别。
6. 本步骤不能新增任务中心、后台任务切换或产物面板逻辑。

人工验证：

1. 发起一个多文件重构任务，先看到计划，再批准执行。
2. 拒绝计划后，确认不会产生写入类工具调用。
3. 批准计划后，日志能显示 plan approval 与 graph 执行衔接。

### 6.5 首轮落地结果

已完成：

1. 参考 WorkAny 的两阶段体验，新增模型驱动的 planning prompt。它先输出 `direct_answer` 或结构化 `plan`，不再只靠字数和关键词决定是否进入长任务。
2. `direct_answer` 会直接形成轻量回答；`plan` 会转换为 Aura `HybridPlan`，进入 Hybrid State Graph。
3. 计划会先以 task tree 推送到聊天消息上方，Graph 每完成一个 subtask 都会同步更新步骤状态。
4. 可执行计划继续复用现有 `approval_required` 通道；用户拒绝时，运行直接以 `blocked_by_approval` / `user_cancelled` 结束，不进入 Graph，也不会触发工具执行。
5. Graph checkpoint 恢复路径跳过计划审批，避免恢复任务被二次确认打断。
6. 前端审批卡片支持 `plan` 类别，能展示计划目标和执行计划文案。
7. 新增 `agent.planning.started`、`agent.planning.resolved`、`agent.plan.preview.created`、`agent.plan.risk.summarized`、`agent.plan.approval.requested`、`agent.plan.approval.resolved` 日志。
8. 自动测试覆盖 planning JSON 解析、附件 planning prompt、计划风险摘要、审批生命周期、拒绝计划阻断执行。

---

## 7. Step 4：生产验收与诊断质量面板

### 7.1 改造内容

这一阶段把前面三步做成生产级验收闭环。

目标不是再加很多新能力，而是让已有能力可运营：

| 能力 | 说明 |
|------|------|
| Agent Diagnostics / Quality Dashboard | 放在 Log Viewer / Developer Diagnostics，统计 Fast/Standard/Long 命中率、成功率、平均耗时、token、失败原因 |
| Run Validation Suite | 固化真实运行验收集，覆盖问答、读取、写入、多文件、网页、恢复、MCP |
| Permission Audit | 展示高风险工具调用、审批结果、拒绝原因 |
| Failure Explorer | 按 error code、provider、tool、checkpoint、pathMode 查询失败 |
| Release Checklist | 每次发布前跑自动验证 + 人工验收场景 |

### 7.2 指标口径

核心指标：

| 指标 | 目标 |
|------|------|
| Fast Path 命中率 | 简单任务稳定命中，不被 plan/session/run 机制拖慢 |
| Standard Path 成功率 | 常规文件任务保持高成功率 |
| Long Path 恢复率 | 复杂任务失败后能进入 recover 或 blocked，而不是静默结束 |
| Completion Gate 有效率 | 未验证写入不能直接完成 |
| Checkpoint Restore 成功率 | 中断/重启后能恢复关键运行状态 |
| Permission 可解释率 | 高风险工具调用都有审计记录 |
| Run 可追踪率 | 每次执行都能从 runId 找回日志、checkpoint、验证摘要 |

### 7.3 日志规划

新增或标准化事件：

| 事件 | 说明 |
|------|------|
| `agent.metrics.rollup` | 多次 run 的聚合指标 |
| `agent.validation.started` | 验收场景开始 |
| `agent.validation.finished` | 验收场景完成 |
| `agent.permission.audit.summary` | 权限审计摘要 |
| `agent.release.checklist` | 发布前检查结果 |

### 7.4 验证逻辑

自动验证：

1. 全量单元测试通过。
2. `pnpm typecheck` 通过。
3. `cargo check` 通过。
4. `pnpm build` 通过。
5. 验收场景集能自动写入 `agent.validation.summary`。
6. 指标面板能基于真实 runtime logs 生成统计，而不是 mock 数据。

人工验证：

1. 运行 10 个真实任务，覆盖简单问答、文件读取、单文件修改、多文件修改、网页检索、失败恢复。
2. 在日志看板中按 `runId` 能复盘任意一次任务。
3. 在日志看板中能看到计划审批、风险摘要、验证结果。
4. 在权限审计中能看到 shell、写入、浏览器自动化等高风险动作。

---

## 8. 四步完成后的目标架构

完成后，Aura 的产品级架构应变成：

```text
React Desktop UI
  -> Chat / Plan Approval / Log Viewer / Agent Diagnostics / Permission Audit

Rust Tauri Layer
  -> Window management / SQLite / Native permissions / App logs

Node Agent Runtime
  -> Task Classifier
  -> Fast Path
  -> Route-first Standard Path
  -> Hybrid State Graph Long Path
  -> Hook Bus
  -> Tool Catalog
  -> Permission Runtime
  -> Session / Run Runtime
  -> Runtime Logs / Metrics

Extension Ecosystem
  -> MCP
  -> Skills
  -> Plugins
  -> Browser Runtime
  -> Computer Use
```

这时 Aura 会同时具备两类能力：

1. **比通用 SDK 更强的执行可靠性**：graph、checkpoint、completion gate、structured recovery。
2. **接近生产应用的产品完整度**：计划确认、运行复盘、权限审计、指标运营。

---

## 9. 任务二期：后台任务、任务切换、产物面板

以下三项不进入本轮四步计划，放到任务二期统一设计和实现。

### 9.1 后台任务增强

当前 Aura 已有基础：Agent task 由 Rust 侧 `AgentTaskStore` 持有，前端用 `runningTasksBySession` 按会话轮询快照；用户切换会话时任务可继续执行。

二期目标：

- 后台任务可跨应用重启恢复。
- 支持暂停、恢复、失败续跑。
- 任务状态从内存快照升级为持久化任务记录。
- 长任务与 graph checkpoint、runtime logs、validation summary 全链路绑定。

### 9.2 任务切换 / 任务中心

当前 Aura 已有基础：每个 session 绑定自己的 running task、composer state、message variant 和 tool events。

二期目标：

- 增加全局 Task Center / Task Switcher。
- 显示运行中、等待审批、失败、已完成任务。
- 支持从任务跳回对应会话和消息。
- 支持按 workspace、session、状态、风险等级筛选任务。

### 9.3 产物面板

当前 Aura 已有基础：ChatView 已根据编辑类 tool event 汇总最终变更文件、diff preview、撤销/应用事务，具备 Codex-like 最终修改文件展示雏形。

二期目标：

- 将最终变更文件卡片扩展为统一 Artifact Panel。
- 覆盖修改文件、生成报告、截图、命令摘要、测试结果、网页预览。
- 支持从 artifact 反查 `runId`、tool event、checkpoint、验证记录。
- 保留并增强现有 diff preview、撤销/应用事务能力。

---

## 10. 不做什么

为了避免重复 `1.2.0` 的问题，这一轮明确不做：

1. 不用 `@codeany/open-agent-sdk` 替换 Aura Runtime 主循环。
2. 不让所有任务强制进入 plan approval。
3. 不把工具错误退回字符串错误。
4. 不把 checkpoint 简化成 transcript。
5. 不牺牲 Fast Path 的速度来换取产品流程一致性。

---

## 11. 推荐执行顺序

1. 先做 Step 1，把 Hook Bus 和 Tool Catalog 打稳。
2. 再做 Step 2，把 run/checkpoint/runtime log 持久化关系打通。
3. 然后做 Step 3，把计划确认和风险审批产品化。
4. 最后做 Step 4，用指标、验收场景集、权限审计把它变成可发布的生产架构。
5. 四步完成后，再进入任务二期，统一做后台任务增强、任务切换、产物面板。

这条路线的核心思想是：

```text
Aura Runtime 负责可靠执行
产品化架构负责可用、可管、可恢复、可运营
```
