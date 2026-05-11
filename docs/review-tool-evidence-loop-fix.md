# Review: 工具证据循环读文件优化 & 用量准确性

> 审查日期：2026-05-11  
> 审查范围：`bridge/tools.mjs`、`bridge/agent.mjs`、`bridge/ipc.mjs`、`src/lib/agent.ts`  
> 问题背景：长任务中 Agent 思考流会循环读取已读过的文件，根源是 context compression 压缩掉了早期 `read_file` 结果，LLM 看不到已读内容

---

Now I have a complete picture. Let me present my review.

---

## Findings

### Finding 1 (Critical) — 工具证据只记录但不回注当前任务，循环读文件的核心问题未解决

**位置**：`bridge/tools.mjs` L630–L672 (`recordToolEvidenceCheckpoint`)

每次 `read_file` 等工具调用成功后，`recordToolEvidenceCheckpoint` 把证据写入 `context.workMemories` 并通过 `appControl` 持久化。但问题是：

**这些 work memory 只被注入到了下一轮任务的 carryover context 里**（`src/lib/agent.ts` `loadWorkMemoryCarryoverContext`），在当前同一任务运行期间，没有任何机制把累积的工具证据回注到 LLM 的 prompt 中。

你描述的"循环读取文件"问题发生在**同一个长任务内部**：随着对话变长，context compression 压缩掉了早期的 `read_file` 结果，LLM 看不到已经读过的内容，于是又读一遍。但此时虽然 `context.workMemories` 里已经积累了"I read file X successfully"的记录，这些记录对当前正在运行的 prompt 是**不可见的**。

系统提示里写的 _"treat those checkpoints as handoff hints and avoid repeating already successful extraction or setup steps"_ 只是一句指导语——LLM 看不到这些 checkpoints 的实际内容，所以这句 instruction 无法起到实际作用。

**建议修复**：在当前任务运行中，把累积的 work memory 注入到 prompt 里。最轻量的方式是在工具调用的 output 末尾追加一段 "evidence reminder"，类似：

```js
// 在 recordToolEvidenceCheckpoint 之后，修改工具返回值
if (context.autoToolEvidence?.length > 1) {
  const priorEvidence = context.autoToolEvidence
    .slice(0, -1)
    .map((e) => `${e.tool}(${e.input.path || e.input.query || ''})`)
    .join(', ')
  output._evidenceReminder = `You have already successfully used these tools this session: ${priorEvidence}. Do not repeat them unless the content has changed.`
}
```

或者在 `buildRouteFirstSystemPrompt` 中，如果有累积的 work memory，把最近几条的 summary 动态拼入 system prompt。

---

### Finding 2 (Medium) — `record_work_memory` 标记为 `internalOnly` 但仍暴露给 LLM

**位置**：`bridge/tools.mjs` L1173–L1177

```js
{
  source: 'builtin',
  name: 'record_work_memory',
  aliases: ['record_phase_artifact', 'write_work_memory'],
  internalOnly: true,
```

`internalOnly: true` 的含义是：工具调用不作为 UI event 发送到前端（参见 L1958 `shouldEmitEvent = effectiveTool.internalOnly !== true`）。但这个工具**仍然注册在工具列表中**，会发送给 LLM 作为可调用工具。

结合系统提示的 instruction："call `record_work_memory` with a short structured artifact"，LLM 确实会主动调用这个工具。但问题是：

- 如果 LLM 每次 read_file 后都调 `record_work_memory`，会产生大量额外的 API 调用开销（每个 record 本身也是 tool_call + tool_result 会话轮次）
- 同时 `autoToolEvidence` 已经自动记录了，再让 LLM 手动记录会重复

**建议**：二选一——要么让 auto evidence 机制完全接管（把 `record_work_memory` 从 LLM 工具列表中隐藏，只保留为 runtime 内部调用），要么去掉 auto evidence，全靠 LLM 主动记录。目前两套机制并存会互相干扰。

---

### Finding 3 (Medium) — Tool evidence 数组无限增长但 summary 只展示最近 6 条

**位置**：`bridge/tools.mjs` L641 & L618

```js
context.autoToolEvidence = [...context.autoToolEvidence, entry].slice(-12) // 保留最近12条
```

```js
const recent = entries.slice(-6) // summary 只展示最近6条
```

这两个截断限制不一致：内部保留 12 条，但 summary 文本只包含最近 6 条。如果一个长任务读了 10 个文件，前 4 条的证据信息会被完全丢弃。考虑到核心目的是防止重新读取早期文件，这些被丢弃的可能恰恰是最需要保留的。

**建议**：保持一致，或者改为"保留最近 N 条但 summary 展示全部保留项"，或者采用更智能的去重策略（按 path/unique key 去重而非按时间截断）。

---

### Finding 4 (Low) — `taskApprovalGrants` 是全局 Set，跨任务不清理

**位置**：`bridge/ipc.mjs` L160

```js
const taskApprovalGrants = new Set()
```

`approve_for_task` 会把 category 加入 `taskApprovalGrants`，之后同 category 的审批自动通过。但这个 Set 是 module 级别变量，没有在任务结束时清理。如果用户在 task A 中 approve 了 `shell` category，task B 开始后同 category 也会被自动通过，可能超出用户预期。

**建议**：在任务结束（`end` 事件处理）时 `taskApprovalGrants.clear()`，或者把 grants 绑定到 `taskId`。

---

### Finding 5 (Low) — `buildTodoProgressMemory` 生成的 memory ID 基于 session-task-message

**位置**：`bridge/tools.mjs` L490–L496

```js
function stableWorkMemoryId(context, suffix) {
  const sessionId = normalizeWorkMemoryIdPart(logContext.sessionId, 'session')
  const taskId = normalizeWorkMemoryIdPart(logContext.taskId, 'task')
  const messageId = normalizeWorkMemoryIdPart(
    logContext.assistantMessageId,
    'message',
  )
  return `work-memory-${sessionId}-${taskId}-${messageId}-${suffix}`
}
```

`assistantMessageId` 是每个 LLM 响应的唯一 ID。每次调用 `todo_write` 时 message 都不同，所以每次都会生成一个新的 work memory ID，而不是 upsert 现有的 todo progress。这意味着一个任务如果反复 `todo_write`，work memory 列表里会堆满相同内容不同 ID 的条目（虽然 `upsertWorkMemory` 有按 ID 去重逻辑，但 ID 每次都不同）。

**建议**：todo progress 的 ID 不应该包含 `messageId`，应该用稳定的 `${sessionId}-${taskId}-todo-progress`，这样后续更新会 upsert 覆盖而不是不断新增。

---

## 总结

| #   | 问题                                                    | 严重度       | 状态     |
| --- | ------------------------------------------------------- | ------------ | -------- |
| 1   | 工具证据只保存不回注当前任务，循环读文件的根因未解决    | **Critical** | 未完成   |
| 2   | `record_work_memory` 双重机制（auto + LLM手动）互相干扰 | Medium       | 需要选择 |
| 3   | evidence 截断策略不一致，早期证据可能被丢弃             | Medium       | 需要调整 |
| 4   | `taskApprovalGrants` 跨任务泄漏                         | Low          | 需要清理 |
| 5   | todo progress memory ID 不稳定导致 upsert 失效          | Low          | 需要修复 |

**核心结论**：当前实现搭好了 work memory 的基础设施（持久化、carryover、system prompt 指令），但**最关键的闭环没有完成**——当前任务运行期间累积的工具证据无法被 LLM 看到。要真正解决"长任务循环读文件"的问题，需要把 work memory 在任务执行过程中注入到 prompt 的可见部分（system prompt 动态段、工具返回值附言、或作为 user message 注入）。
