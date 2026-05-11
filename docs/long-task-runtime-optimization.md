# Long Task Runtime 优化方案

> 日期：2026-05-11  
> 背景：长任务中出现上下文压缩不可见、重复读取、表格/代码草稿滚雪球、用户无法判断真实上下文占用等问题。  
> 目标：补齐通用长任务运行时能力，让表格生成、代码修改、文档分析等大任务稳定分步执行、可恢复、可观测。

---

## 1. 结论

长任务不能依赖“把所有内容塞进模型上下文”。上下文窗口应该只是当前工作台，不是数据库。

通用解法是引入 **Long Task Runtime**：

```text
Context             = 当前最小工作窗口
Artifact Store      = 大产物和中间结果的外部存储
Progress Ledger     = 当前任务结构化进度
Tool Evidence Index = 已成功执行过的工具证据
Compression         = checkpoint 状态迁移
Transcript          = 可丢弃过程，不是事实源
```

这套方案要解决的不只是“重复读文件”，还包括：

- 源材料不大，但模型在分析/生成表格时自己输出过长，导致上下文爆炸。
- 代码任务中长分析、长 diff、长日志反复进入 transcript。
- 压缩后模型忘记已完成步骤，重新读取、重新分析或重新生成。
- 用户看到 UI 底部只有 9k，但日志显示已经发生压缩，缺少解释和提示。

---

## 2. 当前问题

### 2.1 上下文展示口径和压缩触发口径不一致

聊天框底部显示的通常是当前估算值或压缩后的值，不是触发压缩前的真实请求上下文。

实际请求还包含：

- system prompt
- route prompt / skills / carryover context
- tool schema
- tool call / tool result 历史
- runtime tool evidence
- provider 层 transcript
- max output 和 tool result buffer 预留

所以用户可能看到 9k，但实际 provider runtime 已经因为 60k+ / 100k+ 的 transcript 触发压缩。

### 2.2 压缩事件不是持久用户可见状态

agent 层压缩会发 `context_compression`，但 UI 主要表现为短暂 phase，容易被后续状态覆盖。

provider 层 runtime transcript compression 目前更偏日志/思考流事件，不一定形成结构化、持久的用户提示。

结果是：用户通过日志才知道执行中发生了压缩。

### 2.3 工具证据只能缓解“忘记读过”，不能处理“大产物滚雪球”

`autoToolEvidence + outputRecall` 能让模型压缩后知道“读过什么、读到大概什么”，这是必要能力。

但如果爆炸来源是模型自己生成的中间表格、分析草稿、长代码方案，则工具证据无法解决。此时需要把中间产物外置化，而不是继续塞进 transcript。

### 2.4 work memory / carryover 可能成为不可压缩死重

历史 memory、snapshot、nextAction 如果不做预算，会在任务启动时就占用大量 prompt。

更危险的是旧 `nextAction` 可能变成压缩后的孤儿指令：当前任务已经完成了某一步，但压缩后模型只看到旧 snapshot，又回去执行“读文件”等历史动作。

### 2.5 模型普通输出缺少硬约束

只靠 prompt 要求“不要长篇思考”不稳定。模型仍可能在中间轮输出：

- 完整表格草稿
- 长推导过程
- 大段代码分析
- 大量日志复述

如果这些内容进入下一轮 transcript，就会造成上下文滚雪球。

---

## 3. 设计原则

### 3.1 上下文是工作台，不是仓库

上下文只放当前决策需要的最小工作集：

- 用户目标
- 当前阶段
- 进度摘要
- 关键决策
- 当前 chunk 的原始材料
- artifact 引用
- 必要工具证据

不长期放：

- 完整大文件
- 完整大表格
- 完整中间草稿
- 完整 reasoning
- 重复 tool result
- 已经写入 artifact 的完整产物

### 3.2 大内容必须 artifact 化

任何会增长的中间产物都要写到外部 artifact：

- 表格 rows
- 文档 outline
- 多文件代码分析
- patch plan
- 测试报告
- 数据清洗结果
- 设计稿草案

模型下一轮只带 artifact id、摘要、进度和必要切片。

### 3.3 长任务必须有结构化进度账本

不能靠模型记住“做到哪了”。runtime 要维护 progress ledger：

```json
{
  "goal": "根据文档小标题生成表结构",
  "phase": "append_rows",
  "artifactId": "table-abc123",
  "completed": ["heading-1", "heading-2"],
  "current": "heading-13",
  "pendingCount": 42,
  "nextAction": "处理 headings 13-24"
}
```

压缩后必须优先注入这份 ledger。

### 3.4 压缩是 checkpoint，不只是摘要

压缩不应该只把旧消息总结成自然语言，而应该更新/保留：

- task state
- artifact refs
- completed work
- pending work
- tool evidence
- open questions
- next action

### 3.5 提示词是软约束，runtime 是硬约束

提示词告诉模型该怎么做；runtime 要保证模型失控时仍不会污染上下文。

硬约束包括：

- 中间 step 输出 token 上限
- 长 assistant content 自动 spillover
- 重复全文读取 guard
- 重复 chunk 处理 guard
- prompt 装箱预算
- 压缩事件持久化

---

## 4. 需要补齐的能力

### 4.1 Context Budget Ledger

新增统一上下文预算账本，每次请求前记录并上报：

```json
{
  "contextWindowTokens": 64000,
  "configuredWindowTokens": 256000,
  "windowSource": "model_metadata",
  "effectiveThresholdTokens": 48000,
  "systemPromptTokens": 7200,
  "toolSchemaTokens": 8200,
  "runtimeEvidenceTokens": 900,
  "conversationTokens": 26000,
  "artifactSummaryTokens": 1200,
  "progressLedgerTokens": 300,
  "reservedOutputTokens": 8000,
  "estimatedProviderInputTokens": 51800
}
```

要求：

- token meter 显示模型窗口来源：模型 metadata 还是用户设置。
- 如果用户设置 256k 但模型 metadata 是 64k，要明确提示“模型配置覆盖本地预算”。
- 压缩前、压缩后、有效阈值都要可见。
- `calculateContextBudget` 必须计入 runtime tool evidence、progress ledger、artifact summaries。

### 4.2 Progress Ledger

新增 runtime 级进度账本，而不是只依赖 todo/work memory。

建议 API：

```text
update_progress({
  phase,
  completed,
  current,
  pending,
  nextAction,
  artifactRefs,
  sourceRefs
})

read_progress()
```

规则：

- 每个长任务至少有一个 progress ledger。
- 压缩后必须注入 ledger。
- 旧 work memory 中的 nextAction 只能作为历史建议，不能覆盖当前 ledger。
- 重复处理同一 completed item 时，工具层应该提醒或拒绝。

### 4.3 Artifact Store

新增通用 artifact 存储，不为表格写死。

建议 API：

```text
create_artifact({ type, title, schema, metadata })
append_artifact_chunk({ artifactId, chunk, sourceRefs })
read_artifact_slice({ artifactId, offset, limit })
summarize_artifact({ artifactId })
finalize_artifact({ artifactId, outputFormat })
```

Artifact 类型示例：

| type | 用途 |
| --- | --- |
| `table` | 表结构、CSV、Markdown 表格 rows |
| `outline` | 文档标题树、代码符号树 |
| `analysis` | 多文件分析结论 |
| `patch_plan` | 代码修改计划和文件清单 |
| `verification` | 测试、lint、人工校验结果 |
| `draft` | 长草稿，等待最终整理 |

Artifact 返回给模型的内容必须短：

```text
artifact table-abc123 updated: appended 12 rows, totalRows=36, processed=headings 25-36.
```

不要把完整 artifact 回塞 transcript。

### 4.4 Assistant Output Spillover

新增长输出自动外置化。

触发条件建议：

- 中间 step 的 assistant content 超过 4k-8k tokens。
- 内容像表格、长分析、长日志、长 markdown。
- 当前任务尚未完成，还需要下一轮工具或模型调用。

处理方式：

```text
1. 保存完整输出为 artifact。
2. 生成短摘要。
3. transcript 中只保留 artifact id、摘要、下一步。
4. UI 中仍可展示完整内容或折叠查看，但不要让完整内容进入下一轮 prompt。
```

示例替换内容：

```text
Large intermediate table draft saved as artifact table-draft-1.
Summary: generated rows for headings 1-24 using columns A/B/C.
Next: continue from heading 25.
```

### 4.5 Chunked Execution Contract

长任务必须进入分块执行协议。

通用流程：

```text
1. 获取结构：outline / file list / search results
2. 设计 schema / plan
3. 创建 artifact
4. 按 chunk 处理
5. 每个 chunk append artifact + update progress
6. 最后 finalize artifact
```

中间轮普通文本输出限制：

```text
不要输出完整中间表格、完整分析草稿或 raw reasoning。
每轮只处理当前 chunk。
结果写入 artifact。
普通 assistant content 只输出短状态。
```

运行时配套：

- 中间 step 使用较小 `max_output_tokens`。
- 最终回答阶段再放宽输出预算。
- 如果模型没有调用 artifact/progress 工具却输出长文本，触发 spillover。

### 4.6 Tool Evidence Index

当前 `autoToolEvidence` 需要升级为可查询索引。

记录字段建议：

```json
{
  "tool": "read_file",
  "target": "docs/test.md",
  "range": { "startLine": 1, "endLine": 120 },
  "mode": "edit_context",
  "contentHash": "sha256:...",
  "mtime": 1715400000000,
  "outputRecall": "短摘录",
  "recordedAt": 1715400000000
}
```

规则：

- 同一任务重复全文读取同一文件时，不直接返回全文。
- 如果文件未变化，返回已读证据和建议 range。
- 如果确实需要新鲜上下文，鼓励窄范围读取。
- 压缩后注入 evidence summary，但控制 token 预算。

### 4.7 Work Memory Carryover Budget

历史 memory 要按预算和相关性注入。

建议：

- carryover 总预算 2k-4k tokens 起步。
- 优先当前 session / 当前文件 / 当前 artifact 相关 memory。
- `nextAction` 标记为 historical guidance，不是命令。
- 对过长 memory 做 summary，不把完整 content 全量注入。
- todo progress 用稳定 ID upsert，避免同一任务生成多条重复 memory。

### 4.8 Compression Observability

压缩事件必须结构化、持久、用户可见。

统一事件字段：

```json
{
  "kind": "agent_preflight | agent_runtime | provider_runtime_transcript",
  "beforeTokens": 67300,
  "afterTokens": 7299,
  "effectiveThresholdTokens": 64000,
  "contextWindowTokens": 64000,
  "windowSource": "model_metadata",
  "summaryTokens": 1315,
  "preserved": ["progress_ledger", "artifact_refs", "tool_evidence"],
  "createdAt": 1715400000000
}
```

UI 要展示：

```text
已自动压缩上下文：67.3k -> 7.3k
触发阈值：64k，窗口来源：模型配置
保留：进度、artifact 引用、工具证据
```

不能只靠短暂 phase 或日志。

---

## 5. 表格任务参考流程

目标：根据文档小标题生成表结构。

推荐流程：

```text
1. extract_document_outline
   -> 返回 heading tree、heading id、level、start/end range、少量预览

2. create_artifact(type=table)
   -> 定义 columns/schema

3. update_progress
   -> phase=append_rows, current=heading-1

4. process headings 1-20
   -> append_artifact_chunk(rows)
   -> update_progress(completed=headings 1-20, next=headings 21-40)

5. process headings 21-40
   -> append_artifact_chunk(rows)
   -> update_progress(...)

6. finalize_artifact
   -> 输出 Markdown/CSV/文件
```

上下文中只保留：

- schema
- 当前 chunk 的 headings
- artifact id
- 已处理范围
- 下一批范围
- 少量冲突/待确认项

不保留完整表格草稿。

---

## 6. 代码任务参考流程

目标：修改大型代码库中的 bug 或功能。

推荐流程：

```text
1. search_code / glob_files 定位候选文件
2. read_file 只读相关 range
3. create_artifact(type=patch_plan)
4. update_progress(filesLocated, filesModified, testsPending)
5. apply_patch
6. run tests
7. append verification artifact
8. finalize
```

上下文中只保留：

- 用户目标
- 相关文件路径
- 当前函数/组件片段
- patch plan 摘要
- 已修改文件
- 测试结果摘要

不保留：

- 整个仓库文件内容
- 完整测试日志
- 多轮重复 diff
- 长篇代码分析草稿

---

## 7. 实施路线

### P0：可观测性和预算口径统一

目标：先让问题可见。

改动：

- 在预算计算中计入 runtime tool evidence / progress ledger / artifact summaries。
- 统一 agent 压缩和 provider runtime 压缩事件。
- UI 持久显示压缩事件。
- token meter 显示窗口来源、有效阈值、压缩前后值。

涉及模块：

- `bridge/contextCompression.mjs`
- `bridge/agent.mjs`
- `bridge/providers.mjs`
- `bridge/ipc.mjs`
- `src/views/ChatView.tsx`
- `src/MainWindowApp.tsx`

验收：

- 用户不看日志也知道何时压缩。
- UI 能解释“设置 256k 但实际 64k”的原因。
- provider 层压缩也有结构化事件。

### P1：Progress Ledger + Tool Evidence Guard

目标：压缩后不重做已完成工作。

改动：

- 新增 progress ledger 数据结构和工具。
- 压缩后 system prompt 必须注入 progress ledger。
- Tool evidence 记录 target/range/hash/mtime。
- 重复全文读取同一目标时返回 guard 提示，而不是再次返回全文。
- carryover memory 增加 token budget 和相关性过滤。

涉及模块：

- `bridge/tools.mjs`
- `bridge/agentPrompting.mjs`
- `src/lib/agent.ts`
- `bridge/contextCompression.mjs`

验收：

- 压缩后模型知道已完成哪些 heading/file/function。
- 同一任务不会连续重复全文读取同一文件。
- 旧 snapshot 的 nextAction 不会覆盖当前任务进度。

### P2：Artifact Store + Chunked Execution

目标：大中间产物不进入 transcript。

改动：

- 新增 artifact store 和工具 API。
- 表格、outline、analysis、patch_plan、verification 等类型统一承载。
- 长任务 prompt 明确 chunk 协议。
- 每个 chunk 写 artifact + 更新 progress。

涉及模块：

- 新增 `bridge/artifacts.mjs`
- `bridge/tools.mjs`
- `bridge/agentPrompting.mjs`
- `src/lib/storage.ts`
- UI artifact 展示入口

验收：

- 100+ headings 表格任务不会把完整表格反复塞进上下文。
- 代码分析任务不会把长方案/长日志作为 transcript 滚雪球。
- artifact 可切片读取、可 summary、可 finalize。

### P3：Assistant Output Spillover

目标：模型失控长输出也不会污染下一轮上下文。

改动：

- provider loop 检测中间 assistant content 长度。
- 超阈值时保存为 artifact，transcript 替换为摘要。
- reasoning delta 只展示/归档，不作为下一轮事实源。
- finalizer 输入限制 reasoning digest 和 draftMessage 长度。

涉及模块：

- `bridge/providers.mjs`
- `bridge/tools.mjs`
- `src-tauri/src/main.rs`
- `src/views/ChatView.tsx`

验收：

- 中间轮输出 20k 表格草稿时，下一轮 prompt 只包含 artifact 摘要。
- UI 仍能查看完整输出，但 runtime 不再携带全文。
- 压缩频率明显降低。

---

## 8. Prompt 协议建议

系统提示中新增长任务协议：

```text
Long task execution protocol:
- Treat context as a working window, not durable storage.
- Do not write long intermediate tables, drafts, logs, or raw reasoning in assistant content.
- For reusable large results, create or append an artifact.
- For progress, update the progress ledger.
- Process one bounded chunk at a time.
- After each chunk, record only row counts, processed ids, artifact refs, decisions, open questions, and next action.
- Do not repeat completed chunks or identical full-file reads unless the source changed or a narrower fresh read is necessary.
```

表格任务可追加：

```text
For table generation, never carry the full table draft across turns.
Append rows to a table artifact and keep only schema, artifact id, processed heading ids, and next heading range in context.
```

代码任务可追加：

```text
For code changes, inspect by search and narrow ranges. Keep patch plans and verification summaries compact. Do not carry full files, full logs, or repeated diffs across turns.
```

---

## 9. 测试计划

### 9.1 单元测试

- `buildRuntimeToolEvidencePrompt` 包含 range/hash/mtime 摘要。
- 重复全文读取 guard 在文件未变化时生效。
- `buildWorkMemoryCarryoverContext` obey token budget。
- `appendRuntimeStateToSystemPrompt` 注入 progress ledger 和 artifact refs。
- `compactRuntimeTranscript` 发结构化压缩事件。
- output spillover 把长 content 替换为 artifact summary。

### 9.2 集成测试

表格任务：

- 输入 100 个 headings。
- 每 20 个 heading 一个 chunk。
- artifact 最终有 100 行。
- transcript 中不存在完整 100 行表格重复出现。
- 压缩后继续从正确 heading 处理。

代码任务：

- 构造多个大文件。
- Agent 先 search，再 range read。
- 重复全文读取同一文件被 guard。
- 长测试日志被 artifact 化，下一轮只带摘要。

### 9.3 UI 测试

- 压缩发生时聊天流出现持久提示。
- token meter 显示压缩前后、有效阈值、窗口来源。
- artifact 可展开查看，但默认不污染上下文。

---

## 10. 成功标准

完成后，长任务应满足：

- 用户能看到压缩何时发生、为什么发生、压缩前后多少 token。
- 模型压缩后仍知道当前进度、artifact 引用、已完成项和下一步。
- 大表格、大分析、大日志不再作为普通 transcript 反复携带。
- 重复全文读取、重复 chunk 处理会被 runtime 拦截或提醒。
- 代码任务和文档任务都能用同一套状态机制推进。
- 上下文增长接近线性可控，不随中间产物指数式滚雪球。

---

## 11. 非目标

这些不是本方案要做的事：

- 不追求把所有原始内容永久放进模型上下文。
- 不保存或复用 raw chain-of-thought。
- 不用单纯增大上下文窗口掩盖状态管理问题。
- 不为表格任务写死专用流程，而是把表格作为 artifact subtype。

---

## 12. 一句话总结

长任务稳定性的关键不是更大的上下文，而是：

```text
分块执行 + 外置产物 + 结构化进度 + 工具证据 + 可观测压缩 + 运行时硬约束
```

---

## 13. 当前落地状态（2026-05-11）

已完成第一轮 runtime 级改造：

- **Context Budget Ledger**：压缩预算携带 `windowSource`、模型窗口、用户配置窗口、有效阈值、system/tool/output/buffer 预算。
- **Compression Observability**：agent preflight/runtime 和 provider runtime transcript 压缩都会发结构化 `context_compression` 事件，前端生成持久执行事件。
- **Progress Ledger**：新增 `update_progress` / `read_progress`，当前任务进度会回注 system prompt，压缩后仍可恢复。
- **Tool Evidence Index**：工具证据记录 output recall、文件 size/mtime/hash，并注入当前任务 prompt。
- **Repeat Read Guard**：同一任务重复全文读取未变化文件时，返回已读证据和窄读建议，避免再次塞全文。
- **Runtime Artifact Store**：新增 `create_artifact`、`append_artifact_chunk`、`read_artifact_slice`、`summarize_artifact`。大中间产物通过 artifact 承载，append 返回只保留摘要和计数。
- **Assistant Output Spillover**：provider 中间轮 assistant content 超过阈值且任务仍需继续时，自动分片保存为 artifact，并用 artifact 摘要替换后续 transcript 内容。
- **Finalizer Guard**：最终整理 prompt 对 draft message 设上限，避免极端长草稿再次撑爆 finalization 请求。
- **UI 可见性**：上下文 meter 显示实际窗口、窗口来源、有效压缩阈值；自动压缩作为执行事件展示。

本轮仍未做的增强：

- artifact store 目前是任务内存态，后续可接 SQLite/文件系统持久化。
- artifact UI 目前通过工具事件/摘要可见，后续可做专门 artifact 面板。
- 文档 outline 提取仍可作为领域工具单独增强，但不阻塞通用长任务 runtime。
