# 参考 feature_1.2.0 的架构改造计划

> 日期：2026-05-14
> 基准分支：`feature_1.1.3-fix`
> 参考分支：`feature_1.2.0`
> 参考文档：`docs/architecture-comparison-report.md`、`docs/new-architecture-migration-guide.md`
> 四步执行计划：`docs/agent-four-step-modernization-plan.md`

---

## 1. 结论

`feature_1.2.0` 的方向值得采用：状态机执行循环、Working Memory、结构化任务完成校验、压缩恢复、实时事件推送，这些都能解决当前分支长任务容易中断、压缩后失忆、终止条件分散的问题。

但 `feature_1.2.0` 不适合直接整包替换当前分支。它把 `runAgent` 强制切到 `runAgentLoop`，同时弱化或绕开了当前分支已经成熟的 routing、capability tier、tool registry、skills/plugins/MCP、route escalation、provider recovery、checkpoint/evidence policy 等链路。更稳妥的路线是：

1. 先把 1.2.0 中低耦合、收益明确的模块抽出来，接入当前 `runRouteFirstAgent`。
2. 再把当前主循环的终止判断改成结构化 completion gate。
3. 最后让状态机成为外层编排器，但内部继续复用当前分支的 routing、工具挂载、recovery 和 evidence 体系。

---

## 2. 分支对比后的关键判断

### 2.1 当前分支必须保留的能力

当前 `feature_1.1.3-fix` 虽然主循环偏大，但已有多条线上可靠性逻辑：

| 能力 | 当前位置 | 保留原因 |
|------|----------|----------|
| route-first 能力路由 | `bridge/agent.mjs`、`bridge/agentRouting.mjs` | 保证只挂载当前 tier 合法工具，支持渐进能力开放 |
| escalation 与预算 | `getRouteEscalationTargets`、`escalateRouteState` | 防止工具失败后卡死，也防止无限升级 |
| provider recovery | `runRouteFirstAgent` catch 块 | Provider 失败后能用已有 tool evidence 产出 fallback |
| evidence/completion gate | `agentEvidence.mjs`、`completionGate.mjs` | 避免把未验证写入标记为完成 |
| checkpoint manager | `checkpoint.mjs` | pass 级快照已经存在，可作为后续压缩恢复基础 |
| domain failure memory | `retrievalRuntime.mjs` | 已有模块级 `DOMAIN_FAILURE_MEMORY`，应服务化和加测试，而不是另起一套 |
| skills/plugins/MCP 工具挂载 | `loadSkillCatalog`、`loadPluginToolInventory`、`loadMcpToolInventory` | 这是桌面 Agent 的核心能力面 |

### 2.2 feature_1.2.0 值得吸收的设计

| 设计 | 参考文件 | 采用方式 |
|------|----------|----------|
| 状态机循环 | `bridge/agent/runAgentLoop.mjs` | 先作为外层编排模型，不直接替换 provider/tool 执行语义 |
| 结构化任务完成校验 | `bridge/memory/taskCompletion.mjs` | 合并当前 `agentEvidence` 与 `completionGate`，替代纯文本启发式终止 |
| Working Memory | `bridge/memory/workingMemory.mjs` | 先作为当前 loop 的 scratchpad/carryover 层接入 |
| 分层 Prompt Builder | `bridge/memory/promptBuilder.mjs` | 只接管 execution history / compression summary 段落，主 system prompt 保持现有构建 |
| 压缩 checkpoint/recovery | `bridge/memory/contextCompressor.mjs`、`compressionRecovery.mjs` | 在当前 `maybeCompressMessagesForContext` 上增量增强 |
| 实时状态事件 | `bridge/events/stateEmitter.mjs` | 复用现有 hooks，逐步增加 loop progress / memory update 事件 |

### 2.3 feature_1.2.0 不能直接合入的点

1. `runAgentLoopIfEnabled` 总是启用新 loop，缺少 feature flag 和 legacy fallback。
2. 新 loop 只创建 builtin tools，没有完整复用当前 tool registry、advanced tools、plugin tools、MCP tools 和 capability selector。
3. 新 loop 没有完整 `routeState`，因此 capability tier、预算、escalation 语义会退化。
4. `runProviderTurn` 本身已经会调用工具，新 loop 的 `ACTION` 状态目前更像日志态，不是真正的工具执行态。
5. `executeReasoning` 中 `recentToolEvents.length > startToolCount` 判断不正确；`recentToolEvents` 已经是 slice 后的数组，应判断 `> 0`。
6. `FINALIZING` 返回 `type: 'text'` 后仍会进入 text 分支，存在覆盖 `COMPLETED` 状态的风险。
7. 1.2.0 删除了当前两份 review 文档，不利于迁移过程追踪。

---

## 3. 改造原则

1. **不整包替换主循环**：新架构作为目标形态，先抽模块、再包外层。
2. **保留旧架构保命逻辑**：provider recovery、route escalation、evidence policy、domain cooldown 必须在每个阶段都可用。
3. **先补可靠性，再做美化式拆分**：长任务 completion、压缩后工具结果保真、fallback 是 P0。
4. **状态机只统一状态，不改变能力边界**：状态机不能绕开 tool router 和 capability tier。
5. **所有切换必须可回滚**：通过设置项或内部 flag 控制 `legacy` / `hybrid` / `state-machine`。
6. **测试先行锁行为**：先给当前行为补回归测试，再迁移实现。

---

## 4. 目标架构

目标不是简单把 `runRouteFirstAgent` 换成 `runAgentLoop`，而是拆成五层：

```
runAgent
  └─ AgentExecutionController
      ├─ RouteRuntime              # intent/classification/capability tier/escalation/budget
      ├─ AgentLoopStateMachine     # reasoning/action/observation/finalizing 状态编排
      ├─ MemoryRuntime             # working memory + compression summary + checkpoint
      ├─ CompletionRuntime         # evidence policy + structured task completion
      └─ RecoveryRuntime           # provider recovery + fallback + domain cooldown visibility
```

第一阶段仍可由 `runRouteFirstAgent` 承担 `AgentExecutionController` 的职责，只要把 Memory / Completion / Recovery 模块逐步抽出去即可。

---

## 5. 分阶段实施计划

### Phase 0：基线保护与迁移开关

目标：在改动主循环前，先建立可回滚和可验证的边界。

| 任务 | 文件 | 验收标准 |
|------|------|----------|
| 增加内部架构模式开关：`legacy` / `hybrid` / `state-machine` | `bridge/agent.mjs`、设置读取处 | 默认仍为 `legacy`；新路径异常时可回到旧路径 |
| 给当前 route-first 主流程补关键回归测试 | `bridge/agentRouting.test.mjs`、新增 agent loop 相关测试 | escalation、provider recovery、completion gate 均有覆盖 |
| 记录当前 toolEvents / messages / workMemories 合约 | 本文档或 `docs/ARCHITECTURE.md` | 明确哪些数据会进入 LLM prompt，哪些只给 UI/内部使用 |

建议先不要改 `runAgent` 默认入口，避免一次性影响所有任务。

### Phase 1：抽取 Working Memory 与结构化 Completion

目标：先把 1.2.0 的优势接入旧 loop，解决长任务和压缩失忆的核心问题。

| 任务 | 做法 | 验收标准 |
|------|------|----------|
| 新增 `bridge/memory/workingMemory.mjs` | 参考 1.2.0，但要从当前 `toolEvents` 填充 tool_call/tool_result/checkpoint | 最近工具结果能以结构化摘要注入 prompt |
| 新增 `bridge/memory/taskCompletion.mjs` | 合并 1.2.0 的 `findUnverifiedWriteEvents`、`findOrphanedToolEvents` 与当前 `agentEvidence` | execute 模式只有 `executed_verified` 才能完成 |
| 改造 `appendRuntimeToolEvidenceToSystemPrompt` | 增加 Working Memory scratchpad 段落 | 压缩后仍能看到最近工具名、路径、关键输出 |
| 拆分 `shouldRunFinalization` 语义 | 拆成 `shouldFinalizeDraft` 与 `shouldContinueExecution` | 不再用“文本足够长”作为 execute 长任务完成条件 |

这一阶段完成后，即使还没有状态机，长任务提前结束和压缩后失忆的问题也应明显缓解。

### Phase 2：补强当前主循环的完成判断与恢复

目标：让当前 `runRouteFirstAgent` 先具备“结构化循环终止”。

| 任务 | 做法 | 验收标准 |
|------|------|----------|
| 在每个 pass 后调用 `verifyTaskCompletion` | 输入 `result`、`toolEvents`、`messages`、`routeState` | 有未验证写入、孤儿工具结果、低质量最终答复时继续循环或 finalization |
| 长任务 completion gate 前置 | `executionMode === 'long-task' && answerMode === 'execute'` 时强制校验证据 | 不再出现任务未完成但 status completed 的路径 |
| 将 checkpoint 与压缩关联 | compression 发生时保存 execution checkpoint 到 working memory | 压缩事件里能追踪 pass、last tool、pending context |
| Domain cooldown 服务化 | 保留 `retrievalRuntime.mjs` 模块级 memory，导出可测试 tracker API | 同域连续失败跨 pass 可触发 cooldown，成功后可清理 |
| Provider recovery 不回退 | 抽为 `RecoveryRuntime`，新旧 loop 共用 | 模拟 provider 报错时仍返回 recovered/fallback message |

这里要特别注意：当前 `retrievalRuntime.mjs` 已经有 `DOMAIN_FAILURE_MEMORY`。文档里提到的“新架构 Domain Memory 丢失”不应通过复制第二套 tracker 解决，而应把现有模块级 memory 显式服务化，并加跨 pass / 跨 provider turn 测试。

### Phase 3：引入 Hybrid AgentLoop 外层编排

目标：让状态机接管“状态表达”，但不绕开当前成熟的 route runtime。

| 状态 | Hybrid 语义 |
|------|-------------|
| `INITIALIZING` | 做当前 `runRouteFirstAgent` 的 preflight、classification、tool registry、capability selection |
| `REASONING` | 调用现有 `runProviderTurn`，保留 provider 内部工具调用机制 |
| `OBSERVATION` | 消化本轮新增 toolEvents，写入 Working Memory，更新 completion evidence |
| `FINALIZING` | 复用当前 finalize/recovery/fallback 逻辑 |
| `BLOCKED` | 仅用于 approval、capability budget exhausted、用户输入确实必要的场景 |
| `COMPLETED` | 只能由结构化 completion gate 进入 |

这一阶段的关键不是拆工具执行，而是把“为什么继续、为什么结束、为什么升级”变成统一状态。

### Phase 4：压缩恢复与事件推送

目标：吸收 1.2.0 的 memory/event 模块，改善长任务可观测性。

| 任务 | 做法 | 验收标准 |
|------|------|----------|
| 接入 `contextCompressor` | 当前 `maybeCompressMessagesForContext` 增加 checkpoint + structured summary | 压缩后 prompt 有 earlier summary、recent messages、scratchpad |
| 接入 `compressionRecovery` | 压缩后恢复 pending task、last tool、未验证写入 | 不重复读取已明确保留的文件内容，除非需要 fresh verification |
| 接入 `stateEmitter` | 用现有 hooks 包装，不直接写 stdout | 前端能收到 phase、pass progress、memory update、compression triggered |
| 增加 progress throttle | 参考 1.2.0 的 2s progress | 长任务 UI 不再表现为卡死 |

### Phase 5：默认切换与旧路径收敛

目标：Hybrid 稳定后，再考虑默认切换。

| 条件 | 要求 |
|------|------|
| 测试覆盖 | route escalation、provider recovery、domain cooldown、compression recovery、write verification 全部通过 |
| 线上回滚 | 设置中可强制使用 legacy loop |
| 指标观测 | 可以记录 terminationReason、totalPasses、completionState、recovered、compressionCount |
| 文档更新 | `docs/ARCHITECTURE.md` 更新为新分层架构，review 文档归档但不删除 |

---

## 6. 优先级清单

### P0：先做，直接降低失败率

1. 长任务 completion gate：execute 模式未验证不完成。
2. Tool result carryover：压缩后保留最近工具结果的结构化摘要。
3. Provider recovery 抽公共模块：新旧 loop 共用，不能丢。
4. Domain cooldown 测试与服务化：确认跨 pass、跨 provider turn 有效。
5. Hybrid 开关：任何新 loop 都必须可回退。

### P1：新架构主体

1. Working Memory manager 接入当前 loop。
2. `taskCompletion.mjs` 接入当前 `agentEvidence`。
3. Hybrid state machine 接管 pass 状态与 termination reason。
4. Compression checkpoint 与 recovery 接入。
5. Escalation 事件进入统一状态机。

### P2：体验与维护性

1. StateEmitter 推送 progress / memory / compression 事件。
2. PromptBuilder 拆分 system prompt 的动态段落。
3. `runRouteFirstAgent` 大函数拆分为 route/memory/completion/recovery runtime。
4. 文档归档与架构图更新。

---

## 7. 建议的文件落点

```
bridge/
├── agent.mjs                         # 保留 runAgent 入口与 legacy fallback
├── agent/
│   ├── loopState.mjs                  # 状态枚举、termination reason
│   ├── hybridAgentLoop.mjs            # Hybrid 状态机外层编排
│   ├── routeRuntime.mjs               # 从 agent.mjs 抽 route/capability/escalation
│   ├── completionRuntime.mjs          # completion gate + evidence policy
│   └── recoveryRuntime.mjs            # provider recovery + fallback
├── memory/
│   ├── workingMemory.mjs
│   ├── promptBuilder.mjs
│   ├── contextCompressor.mjs
│   └── compressionRecovery.mjs
└── events/
    └── stateEmitter.mjs
```

迁移时不要一次性移动所有逻辑。建议先新增模块并由 `agent.mjs` 调用，稳定后再把代码搬出。

---

## 8. 测试计划

| 场景 | 测试点 |
|------|--------|
| 长任务未验证写入 | `apply_patch` / `write_file` 后没有 read/test，不允许 `completed` |
| 长任务验证成功 | 写入后 read back 或 test 成功，允许 `executed_verified` |
| Provider recovery | provider 在 final answer 阶段失败，使用 toolEvents 构建 recovery/fallback |
| Route escalation | capability 不足或工具链失败时升级，预算耗尽时返回明确 stop reason |
| Domain cooldown | 同一 domain 连续失败后下一轮 short-circuit，成功后清理 failure memory |
| Context compression | 压缩后 prompt 仍包含最近工具结果、checkpoint、pending task |
| Hybrid parity | legacy 与 hybrid 对同一输入的 routeDecision、tool availability、completionState 基本一致 |
| UI events | 长任务每隔固定时间有 progress，compression 和 memory update 可见 |

建议新增或扩展：

```
bridge/taskCompletion.test.mjs
bridge/workingMemory.test.mjs
bridge/agentLoopHybrid.test.mjs
bridge/retrievalRuntime.test.mjs
bridge/contextCompression.test.mjs
```

---

## 9. 第一批具体改动建议

第一批 PR 建议控制在低风险范围：

1. 从 `feature_1.2.0` 拿 `workingMemory.mjs` 和 `taskCompletion.mjs` 的思想，但不要原样复制；先适配当前 `toolEvents` shape。
2. 修改当前 `shouldRunFinalization` 周边逻辑：`long-task + execute` 场景必须优先看 completionState，而不是最终文本长度。
3. 在 `maybeCompressMessagesForContext` 成功压缩后，把 checkpoint 摘要写入 Working Memory。
4. 给 `retrievalRuntime.mjs` 的 domain failure memory 增加测试辅助导出，只在 test 环境使用。
5. 新增 `agentArchitectureMode` 内部配置，但默认仍跑 legacy。

完成这批后，再开始 Hybrid loop，避免同时改“判断逻辑”和“执行框架”导致问题难定位。

---

## 10. 暂不做的事

1. 暂不删除 `bridge/agentModes/routeFirst.mjs`。
2. 暂不让 `runAgent` 默认强制走 `runAgentLoop`。
3. 暂不把工具执行从 `runProviderTurn` 中拆出来，除非 provider 层接口同步调整。
4. 暂不删除两份 review 文档；它们应作为迁移背景保留。
5. 暂不新增第二套 domain failure memory。

---

## 11. 成功标准

迁移完成后应满足：

1. 长任务不会因为“模型写了一段看起来完整的中间文本”就提前结束。
2. 上下文压缩后，模型仍能看到最近关键工具结果和 checkpoint，不需要盲目重做。
3. Provider 异常时能恢复或给出带已有证据的 fallback，而不是直接失败。
4. 工具失败链能触发能力升级或明确的 budget stop reason。
5. 新状态机能解释每次继续、终止、升级、阻塞的原因。
6. 当前分支已有的 skills/plugins/MCP/capability tier 不因新 loop 丢失。
7. 新旧路径可通过配置切换，并有测试覆盖关键差异。
