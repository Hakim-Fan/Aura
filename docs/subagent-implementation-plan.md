# Aura Subagent 实现方案

> 日期：2026-05-17
> 参考对象：`codex-main`
> 设计结论：Aura 的 subagent 不参考 `open-agent-sdk-typescript-main` 的 AgentTool / Tool Plus 模式，而参考 Codex 的系统级协作 Agent 模式。

---

## 1. 总目标

Aura 引入 subagent 的目标不是让所有任务都变复杂，而是让复杂任务更像一个可协作、可并行、可验收的生产级 Agent Runtime。

最终目标：

1. **主 Agent 保持调度权**：主 Agent 负责规划、派发、合并、最终决策和最终回复。
2. **Explorer 并行收集上下文**：多个 explorer 可以同时读取代码、日志、skill、附件、历史任务数据。
3. **Worker 单实例执行修改**：同一任务内最多一个 worker，避免多个 Agent 同时写文件导致冲突。
4. **Verifier 单实例做质量验收**：同一任务内最多一个 verifier，负责最终语义验收和风险判断。
5. **简单任务不启用 subagent**：Fast Path 和普通单步任务仍由主 Agent 直接完成。
6. **上下文不被子 Agent 拖爆**：子 Agent 的详细过程不注入主上下文，主 Agent 只接收结构化摘要、证据索引和产物引用。

---

## 2. 不采用 AgentTool / Tool Plus 模式

`open-agent-sdk-typescript-main` 的 AgentTool 本质更像：

```text
主 Agent 调用一个带上下文和工具集的高级工具
  -> 工具内部跑一个嵌套 Agent
  -> 返回结果给主 Agent
```

这种方式有委托能力，但不够像真正的 subagent：

- 没有完整生命周期管理。
- 没有独立 agent 状态。
- 没有 agent 间消息、等待、关闭、恢复。
- 没有清晰的主 Agent / 子 Agent 协作协议。
- 不适合作为 Aura 复杂任务长期架构。

Aura 应参考 Codex 的系统级模式：

```text
主 Agent
  -> spawn explorer / worker / verifier
  -> 子 Agent 独立运行
  -> wait / close / collect result
  -> 主 Agent 合并证据并继续执行
```

---

## 3. Agent 角色设计

Aura 第一版只实现三个角色，不做 `default`。

| 角色 | 数量策略 | 主要职责 | 是否允许写文件 |
|------|----------|----------|----------------|
| `explorer` | 可多个并行 | 只读探索，收集上下文、读取 skill、分析日志、读取文件、解析附件 | 否 |
| `worker` | 最多一个 | 执行修改、生成文件、跑命令、完成主交付 | 是 |
| `verifier` | 最多一个 | 最终验收、质量检查、风险判断、确认是否满足验收标准 | 默认只读，可跑测试 |

### 3.1 Explorer

Explorer 是资料员和侦察员。

适合派给 explorer 的任务：

- 查找相关代码位置。
- 读取指定文件。
- 读取 skill 说明。
- 分析历史运行日志。
- 解析附件内容。
- 搜索多处上下文。
- 对某个模块做只读分析。

Explorer 的约束：

- 不允许修改文件。
- 不允许执行高风险命令。
- 返回结构化结论，不返回完整原始上下文。
- 多个 explorer 可以并行执行不同探索任务。

### 3.2 Worker

Worker 是执行员。

适合派给 worker 的任务：

- 修改代码。
- 生成文档或产物。
- 跑必要命令。
- 按主 Agent 汇总后的上下文完成交付。

Worker 的约束：

- 同一任务内最多一个 worker。
- 必须带明确任务目标。
- 必须带验收标准。
- 必须记录修改文件、命令输出和产物路径。
- 不允许自己继续派生其他 worker。

后续如果要支持多个 worker，必须先实现文件 ownership、冲突检测和合并策略。第一版不做。

### 3.3 Verifier

Verifier 是质检员。

适合派给 verifier 的任务：

- 检查最终结果是否满足用户目标。
- 检查计划中的验收标准是否全部完成。
- 检查 worker 是否有真实执行证据。
- 检查是否有遗漏、冲突、回归风险。
- 判断失败恢复后是否可以继续。

Verifier 的约束：

- 同一任务内最多一个 verifier。
- 默认不参与每一步验证。
- 只在最终验收、复杂语义判断或失败恢复后介入。

---

## 4. 执行流程

改造后的复杂任务流程：

```text
User Request
  -> 主 Agent 调用 Planning Prompt
  -> 返回执行计划、验收标准、证据要求、建议 agentRole
  -> Orchestrator 分配任务
      -> 多个 explorer 并行收集上下文
      -> 主 Agent 汇总 explorer 结果
      -> worker 单实例执行修改或生成产物
      -> Orchestrator 做步骤证据检查
      -> verifier 做最终质量验收
  -> 主 Agent 合并结果并回复用户
```

### 4.1 Planning 输出需要新增字段

每个计划步骤建议包含：

```json
{
  "title": "读取 docx skill 的使用说明",
  "kind": "context",
  "agentRole": "explorer",
  "parallelGroup": "context-gathering",
  "acceptance": "明确知道 docx skill 的正确解析方式",
  "requiredEvidence": ["skill_read"],
  "verifierPolicy": "none"
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `agentRole` | `main` / `explorer` / `worker` / `verifier` |
| `parallelGroup` | 同组 explorer 可并行执行 |
| `acceptance` | 这一步完成的自然语言验收标准 |
| `requiredEvidence` | 这一步必须产生的证据类型 |
| `verifierPolicy` | 是否需要 verifier 介入 |

### 4.2 Agent 分配规则

Orchestrator 不直接盲信模型规划，而是结合系统约束做最终分配。

| 计划建议 | Orchestrator 行为 |
|----------|-------------------|
| `agentRole = explorer` | 若步骤只读，则可派 explorer；多个 explorer 可并行 |
| `agentRole = worker` | 若任务需要写入或执行产出，则派唯一 worker；已有 worker 时排队或由主 Agent 执行 |
| `agentRole = verifier` | 保留到最终验收阶段，默认不在每步都执行 |
| `agentRole = main` | 主 Agent 自己执行 |
| 未指定或不可信 | 主 Agent 按工具权限、证据要求和风险重新判断 |

安全边界：

1. Explorer 永远不能写文件。
2. Worker 同一任务最多一个。
3. Verifier 同一任务最多一个。
4. 主 Agent 可以随时接管无法分配的步骤。
5. 子 Agent 默认不能继续 spawn 子 Agent。

---

## 5. 验证机制

引入 subagent 后，验证分两层。

### 5.1 每步证据检查

每一步完成后，Orchestrator 做轻量证据检查。

这个检查不需要 verifier，也不需要额外模型调用。

示例：

| 步骤要求 | 检查方式 |
|----------|----------|
| `skill_read` | 是否真实调用过 skill 读取工具 |
| `file_read` | 是否读取过目标文件 |
| `file_parsed` | 是否解析出结构化内容 |
| `file_mutation` | 是否有真实文件修改事件 |
| `command_output` | 是否有命令执行输出 |
| `structured_output` | 是否产生结构化结果 |

如果证据满足，步骤可以打钩。

如果证据不满足，主 Agent 尝试恢复。恢复后仍不满足，才考虑让 verifier 介入判断。

### 5.2 Verifier 介入策略

`verifierPolicy` 建议支持四种：

| 策略 | 含义 |
|------|------|
| `none` | 不需要 verifier，证据检查即可 |
| `on_failure` | 证据缺失、恢复失败、结果冲突时才调用 verifier |
| `required` | 这一步必须由 verifier 验收 |
| `final_only` | 不在步骤中调用，最终统一验收 |

默认策略：

1. 每一步不调用 verifier。
2. 每一步先做系统证据检查。
3. 证据不满足时，主 Agent 先恢复。
4. 恢复后仍不满足时，verifier 可介入。
5. 任务结束时，如果任务复杂、涉及 worker 修改、或存在最终验收标准，则调用 verifier 做最终验收。

---

## 6. 上下文与记忆策略

Subagent 不能把所有原始上下文都塞回主 Agent。

正确模式：

```text
子 Agent 原始过程
  -> 存日志 / agent session / evidence store
  -> 不直接进入主 Agent 上下文

子 Agent 结构化结果
  -> summary
  -> evidence
  -> filesRead
  -> artifacts
  -> risks
  -> suggestedNextActions
  -> 注入主 Agent 上下文
```

### 6.1 子 Agent 返回结构

建议统一为：

```json
{
  "agentRole": "explorer",
  "taskTitle": "读取 docx skill 的使用说明",
  "status": "completed",
  "summary": "docx skill 支持读取 .docx 并解析标题层级。",
  "evidence": [
    {
      "type": "skill_read",
      "source": "skills/docx/SKILL.md",
      "summary": "确认需要先读取 skill 说明，再调用解析能力。"
    }
  ],
  "filesRead": ["skills/docx/SKILL.md"],
  "filesChanged": [],
  "artifacts": [],
  "risks": [],
  "suggestedNextActions": ["使用 docx skill 解析目标文件"]
}
```

### 6.2 主 Agent 上下文计算

主 Agent 上下文应包含：

- 用户当前请求。
- 当前执行计划。
- 已完成步骤摘要。
- 子 Agent 结构化结果。
- 关键 evidence 索引。
- 最近必要对话。
- 当前任务 checkpoint。

主 Agent 上下文不应包含：

- 子 Agent 完整思考流。
- 子 Agent 完整工具输出。
- 子 Agent 读取的大段原文。
- 与当前步骤无关的历史日志。

### 6.3 任务继续时的记忆恢复

如果任务中断后继续，Aura 不应简单重读所有文件。

恢复时优先读取：

- 已完成 plan steps。
- 每个 step 的 evidence。
- 子 Agent result summaries。
- worker 修改文件列表。
- verifier 验收结论。
- checkpoint 状态。

只有当 evidence 不足、用户目标变化、文件已变更或 verifier 认为需要复核时，才重新读取原文件。

---

## 7. 运行时模块设计

建议新增或扩展以下模块。

| 模块 | 作用 |
|------|------|
| `bridge/agent/subagents/agentControl.mjs` | 创建、等待、关闭、恢复子 Agent |
| `bridge/agent/subagents/agentRoles.mjs` | 定义 explorer / worker / verifier 的提示词、工具权限、预算 |
| `bridge/agent/subagents/agentSession.mjs` | 管理子 Agent session、状态、日志、结果 |
| `bridge/agent/subagents/resultContract.mjs` | 规范子 Agent 返回结构 |
| `bridge/agent/subagents/orchestrator.mjs` | 根据 plan 分配 agent、并行 explorer、串行 worker/verifier |
| `bridge/agent/subagents/contextBridge.mjs` | 控制哪些子 Agent 结果进入主 Agent 上下文 |

现有模块需要改造：

| 模块 | 改造点 |
|------|--------|
| `bridge/agent/modelPlanningRuntime.mjs` | planning prompt 增加 `agentRole`、`parallelGroup`、`verifierPolicy` |
| `bridge/agent/plannerRuntime.mjs` | plan subtask 保存 agent 分配、并行组和 verifier 策略 |
| `bridge/agent/stateGraphRuntime.mjs` | 执行 plan 时调用 subagent orchestrator |
| `bridge/agent/executorRuntime.mjs` | 收集子 Agent 结果并转换成 evidence |
| `bridge/agentEvidence.mjs` | 增加 `subagent_result`、`explorer_context`、`verifier_passed` 等证据 |
| `bridge/agentRuntimeLogs.mjs` | 记录 subagent 生命周期日志 |
| `src/views/ChatView.tsx` | 在执行计划中展示 explorer / worker / verifier 状态 |

---

## 8. 日志规划

Subagent 必须可诊断。新增事件建议：

| 事件 | 触发时机 | 核心字段 |
|------|----------|----------|
| `agent.subagent.spawned` | 子 Agent 创建 | `runId`, `subagentId`, `role`, `parentStepId`, `taskTitle` |
| `agent.subagent.started` | 子 Agent 开始执行 | `subagentId`, `role`, `toolsAllowed` |
| `agent.subagent.completed` | 子 Agent 完成 | `subagentId`, `role`, `status`, `durationMs`, `evidenceTypes` |
| `agent.subagent.failed` | 子 Agent 失败 | `subagentId`, `role`, `errorClass`, `recoverable` |
| `agent.subagent.wait.started` | 主 Agent 等待子 Agent | `targets`, `timeoutMs` |
| `agent.subagent.wait.completed` | 等待结束 | `completed`, `pending`, `timedOut` |
| `agent.subagent.result.merged` | 结果合并进主上下文 | `subagentId`, `summaryTokenEstimate`, `evidenceCount` |
| `agent.subagent.context.skipped` | 原始内容未注入主上下文 | `subagentId`, `reason` |
| `agent.verifier.started` | 最终验收开始 | `stepIds`, `acceptanceCount` |
| `agent.verifier.completed` | 最终验收完成 | `passed`, `failedAcceptance`, `risks` |

日志必须能回答：

1. 本次任务为什么启用了 subagent？
2. 派出了几个 explorer？
3. 每个 explorer 分别读取了什么？
4. worker 修改了哪些文件？
5. verifier 根据哪些验收标准通过或失败？
6. 哪些子 Agent 原始上下文没有进入主 Agent？
7. 主 Agent 最终合并了哪些 evidence？

---

## 9. UI 展示策略

UI 不展示复杂内部协议，只展示用户能理解的执行状态。

计划步骤可以显示：

```text
执行计划
  ✓ 收集 docx skill 的使用方式
  ✓ 解析建设内容.docx 的文档结构
  ⟳ 生成数据实体表
  ○ 验证输出是否覆盖所有子标题
```

展开详情时可以看到：

```text
并行探索
  ✓ Explorer 1：读取 docx skill
  ✓ Explorer 2：解析附件结构

执行
  ⟳ Worker：生成实体表

验收
  ○ Verifier：检查覆盖率和输出格式
```

默认规则：

- 聊天框上方继续显示简洁计划。
- Explorer 并行过程默认折叠。
- 用户开启执行详情时，才展示每个 subagent 的摘要。
- 任务结束或停止回答后，临时执行步骤隐藏。
- 最终消息保留结果、产物、修改文件和验收摘要。

---

## 10. 示例流程

用户任务：

```text
使用 docx skill 解析「建设内容.docx」文档，提取所有子标题，并为每个子标题生成数据实体表。
```

### 10.1 Planning 输出

```json
[
  {
    "title": "读取 docx skill 的使用说明",
    "agentRole": "explorer",
    "parallelGroup": "context",
    "acceptance": "确认 docx skill 的正确解析方式",
    "requiredEvidence": ["skill_read"],
    "verifierPolicy": "none"
  },
  {
    "title": "解析 建设内容.docx 的文档结构和标题列表",
    "agentRole": "explorer",
    "parallelGroup": "context",
    "acceptance": "获得完整标题层级和关键段落内容",
    "requiredEvidence": ["file_parsed", "structured_output"],
    "verifierPolicy": "none"
  },
  {
    "title": "为每个子标题生成数据实体表",
    "agentRole": "worker",
    "acceptance": "每个子标题都有对应实体表，字段包含名称、类型、说明",
    "requiredEvidence": ["structured_output"],
    "verifierPolicy": "final_only"
  },
  {
    "title": "验证所有子标题均已覆盖且格式正确",
    "agentRole": "verifier",
    "acceptance": "无遗漏标题，输出结构清晰，可直接阅读",
    "requiredEvidence": ["verifier_passed"],
    "verifierPolicy": "required"
  }
]
```

### 10.2 实际执行

```text
主 Agent
  -> 同时 spawn Explorer A 和 Explorer B

Explorer A
  -> 读取 docx skill 说明
  -> 返回解析方法摘要和 skill_read evidence

Explorer B
  -> 解析 建设内容.docx
  -> 返回标题列表、文档结构和 file_parsed evidence

主 Agent
  -> 合并两个 explorer 的结果
  -> 判断上下文足够
  -> 派 worker 生成实体表

Worker
  -> 生成完整实体表
  -> 返回 structured_output evidence

Verifier
  -> 检查标题覆盖率和输出格式
  -> 返回 passed / failed / risks

主 Agent
  -> 汇总最终结果
  -> 回复用户
```

---

## 11. 分阶段落地建议

### Phase 1：Explorer 并行只读

先实现风险最低、收益最大的部分。

交付内容：

- `explorer` role。
- `spawn explorer` / `wait explorer`。
- explorer 只读工具权限。
- planning 增加 `agentRole` 和 `parallelGroup`。
- 多 explorer 结果结构化返回。
- 主 Agent 合并 explorer summary 和 evidence。

验证逻辑：

1. 同一任务可以派出多个 explorer。
2. 多个 explorer 不能写文件。
3. 主 Agent 上下文只注入 explorer summary，不注入完整工具输出。
4. 日志能看到每个 explorer 的读取范围和 evidence。

### Phase 2：Worker 单实例

在 explorer 稳定后再引入 worker。

交付内容：

- `worker` role。
- 同一 run 内 worker 单实例锁。
- worker 执行结果 contract。
- 修改文件、命令输出、产物路径 evidence。

验证逻辑：

1. 同一任务不会同时启动两个 worker。
2. worker 修改文件必须产生 `file_mutation` evidence。
3. worker 没有真实执行证据时，步骤不能直接完成。
4. 主 Agent 能接管 worker 失败后的恢复。

### Phase 3：Verifier 最终验收

引入单实例 verifier 做最终质量闸门。

交付内容：

- `verifier` role。
- `verifierPolicy`。
- 最终验收 prompt。
- 验收结果结构化输出。
- `verifier_passed` / `verifier_failed` evidence。

验证逻辑：

1. 简单任务不调用 verifier。
2. 每步证据检查不调用 verifier。
3. 复杂任务或 worker 修改后触发最终 verifier。
4. verifier 能指出缺失验收项、风险和建议修复动作。

### Phase 4：上下文、恢复与 UI 完整化

把 subagent 接入生产体验。

交付内容：

- 子 Agent session 持久化。
- 子 Agent result summary 进入 work memory。
- checkpoint 恢复时读取 subagent evidence。
- UI 展示 subagent 简洁状态。
- 日志看板支持按 subagent 过滤。

验证逻辑：

1. 任务中断后继续，不需要重复读取所有已完成上下文。
2. 重启 App 后能看到最终回答和关键执行摘要。
3. 日志能定位每个 subagent 的生命周期。
4. UI 不被 subagent 细节淹没，默认只展示用户可理解步骤。

---

## 12. 第一版明确不做

为了避免架构过早复杂化，第一版不做：

1. 不做 `default` subagent。
2. 不允许多个 worker 并行。
3. 不允许多个 verifier 并行。
4. 不允许子 Agent 再 spawn 子 Agent。
5. 不做跨任务长期驻留 Agent。
6. 不把子 Agent 完整上下文注入主 Agent。
7. 不把 subagent 用在所有任务上。
8. 不用 AgentTool / Tool Plus 模式冒充系统级 subagent。

---

## 13. 最终效果

改造完成后，Aura 的复杂任务执行体验应变成：

```text
简单任务
  -> 主 Agent 快速完成

普通任务
  -> 主 Agent 按计划执行

复杂任务
  -> 主 Agent 规划
  -> 多 explorer 并行收集上下文
  -> 主 Agent 汇总
  -> 单 worker 执行
  -> 单 verifier 验收
  -> 主 Agent 输出最终结果
```

这套设计既吸收 Codex 的系统级 subagent 思路，又保留 Aura 当前的计划、证据、日志、checkpoint、route-first 执行能力。核心原则是：

```text
读可以并行，写要集中，验收要清晰，最终决策永远在主 Agent。
```
