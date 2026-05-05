# Aura Token 消耗与重试记忆机制分析

> 对比 Codex，分析 Aura 在重试/继续场景下的记忆机制与 Token 浪费问题。

---

## 现状校对（2026-05-05）

结论：**部分符合现状，但需要修正一个关键点。**

- 当前 `src/lib/agent.ts` 启动任务时只传 `role/content/parts/researchMode`，不会把历史 assistant message 里的 `events` 或 session 级 `toolEvents` 原样塞进 `messages`。所以“跨轮重试会把之前所有 tool output 原样重发”这一点**不符合当前实现**。
- 仍然符合的问题：
  - 历史 user/assistant 文本内容会持续增大，需要 token 预算控制。
  - 历史 `parts` 也会进入运行时，旧图片 `dataUrl` 尤其容易放大请求体。
  - 单次 provider run 内，OpenAI/Gemini transcript 会随着工具调用结果持续增长，后续模型 step 会反复携带之前的工具输出。
  - system prompt/skill prompt 每轮仍会重建并发送。
- 已开始的短期优化：
  - 前端不再做字符级历史裁剪，避免压缩前先丢信息。
  - bridge 侧按 token 预算触发 LLM 语义压缩，旧历史变成结构化摘要，最近消息保持原文。

---

## 一、重试时有没有之前的思考记忆？

**有，但方式很粗暴。**

当一个任务失败后用户点"重试"或发送"继续"时，前端会把当前 session 里的历史 user/assistant 消息内容传给 `runAgent`。模型**能看到之前的用户输入和助手最终回复**，但当前实现不会把历史 assistant message 的 `events` 或 session 级 `toolEvents` 原样传入 `messages`。

问题在于：历史文本内容和 `parts` 此前基本是**原样传递，没有压缩**。如果旧消息里带图片 `dataUrl`、大段粘贴内容或长回复，仍会在后续轮次反复消耗 token/请求体积。

---

## 二、为什么 Token 消耗特别大？

核心原因有三个：

### 2.1 缺少完整上下文压缩机制（Context Compaction）

Aura 此前没有完整的 context compaction。现在已先补上一层 token 预算触发的摘要式 compaction；后续还可以继续扩展工具运行期 transcript 的语义压缩和持久记忆。

- **Codex** 的做法：在上下文接近窗口上限时，调用一次压缩模型把历史消息摘要化（`compact.rs` / `compact_remote.rs`）
- **Aura 当前短期优化**：旧历史超过 token 阈值时由 LLM 压缩成结构化摘要，最近 6 条消息保持原始内容。

一个 10 轮对话如果包含长回复、大段粘贴内容或旧图片 parts，仍可能把大量历史上下文反复发送。历史 tool output 不会跨轮原样重发，但单次 provider run 内的工具结果仍会进入 transcript 并在后续 step 中重复携带。

### 2.2 System Prompt 每轮重建但不精简

从 `bridge/agent.mjs` 代码可以看到，每轮都会重新构建 system prompt，包含：

| 组成部分 | 说明 |
|---------|------|
| 完整能力说明（`exposureNote`） | 每轮重复 |
| 所有挂载 skills 指令（`skillPrompt`） | 每轮重复 |
| 路由升级证据累积（`routeNotes`） | 最多保留 2 条 |
| 之前轮次 carryover 上下文（`carryoverContext`） | 累积增长 |

这些全部拼接成一个巨大的 system prompt，**每轮都完整发送**。

### 2.3 单次 provider run 内工具 transcript 不断累积

在 `agent.mjs` 的主循环中（`for (let pass = 0; pass < MAX_ROUTE_RUNTIME_PASSES; pass += 1)`），`toolEvents` 数组在整个运行过程中**只增不减**。

- 路由升级笔记只会摘要最近工具证据，并不会把原始 `toolEvents` 作为历史 `messages` 传给 provider。
- 真正会膨胀的是 OpenAI/Gemini provider 内部 transcript：每次工具调用结果都会作为 tool/function response 进入后续模型 step。
- 如果连续多步读取文件、搜索或执行命令，后续 step 会反复携带之前的工具输出。

---

## 三、具体的 Token 浪费场景

| 场景 | 发生了什么 | Token 代价 |
|------|-----------|-----------|
| 单次 run 里读了 5 个文件 | 5 个文件的输出进入 provider transcript，后续 step 会继续携带 | 可能几万 token |
| 第 2 轮用户说"继续" | 历史 user/assistant 文本和 parts 会继续发送，历史 tool output 不会原样重发 | 取决于历史文本、旧图片和长回复 |
| 第 3 轮用户说"重试刚才的任务" | 会保留目标用户消息之前的对话文本；失败助手消息的 events 主要留在 UI/存储层 | 文本历史继续增长 |
| 10 轮对话后 | 每轮都携带之前 user/assistant 内容，旧富媒体 parts 此前也会保留 | 线性增长，但不等同于 tool output 全量跨轮重发 |

### Token 增长示意

```
轮次 1:  system_prompt(~3K) + user_msg(~200) + provider_step_tool_output(~5K)       = ~8K
轮次 2:  system_prompt(~3K) + 文本历史/parts(~取决于会话) + user_msg(~200) + 本轮工具输出
轮次 3:  system_prompt(~3K) + 更多文本历史/parts + user_msg + 本轮工具输出
...
轮次 N:  system_prompt(~3K) + 历史文本/parts + 本轮 provider transcript 工具输出
```

增长主要来自两块：跨轮的历史文本/parts，以及单次 run 内 provider transcript 的工具输出累积。

---

## 四、对比 Codex 的做法

Codex 有三层机制避免这个问题：

### 4.1 上下文压缩（Context Compaction）

**实现位置：** `codex-rs/core/src/compact.rs` / `compact_remote.rs`

- 当 token 接近窗口限制时，自动触发压缩
- 用一次独立的 LLM 调用把历史消息压缩成精简摘要
- 支持两种模式：
  - **本地压缩**（`compact.rs`）：使用当前模型压缩
  - **远程压缩**（`compact_remote.rs`）：使用更小/更便宜的模型压缩，降低压缩本身的成本
- 压缩后的摘要替代原始历史，大幅减少后续每轮的 token 消耗

### 4.2 Persistent Memories（持久记忆）

**实现位置：** `codex-rs/memories/src/read.rs` / `write.rs`

- 跨会话的项目级记忆存储在 `.codex/memories` 目录
- 每次 session 启动时自动注入关键上下文
- 不需要靠重发历史消息来恢复项目记忆
- 包含两阶段写入和 guard 机制，防止记忆污染

### 4.3 消息裁剪策略

- 智能截断早期的 tool output，只保留摘要
- 对长时间对话中的冗余信息做选择性丢弃
- 保证最近的上下文完整，但对历史上下文做有损压缩

---

## 五、建议的改进方向

### 5.1 短期（解决当前痛点）

#### 方案 A：Tool Output 截断

在 `runAgent` 中，对超过一定长度的 tool output 做截断或摘要替换：

```
// 伪代码
for (const event of toolEvents) {
  if (event.output.length > MAX_TOOL_OUTPUT_CHARS) {
    event.output = event.output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n... [truncated]'
  }
}
```

建议阈值：单个 tool output 不超过 4000 字符。

#### 方案 B：前端历史消息裁剪

在前端 session 层面，对超过 N 轮的历史消息做摘要裁剪后再传给 `runAgent`：

- 保留最近 3 轮的完整消息
- 对更早的消息，只保留 user message 和 assistant 的文字回复（去掉 tool output）
- 或者用一次轻量调用生成历史摘要

### 5.2 中期

#### 方案 C：实现上下文压缩（参考 Codex compact.rs）

当总 token 接近模型上下文窗口时，自动调用一次压缩：

1. 检测当前 messages 总 token 数
2. 如果超过阈值（如窗口的 70%），触发压缩
3. 调用一次 LLM 把旧历史转为精简摘要
4. 用摘要替换原始历史，后续轮次只传递摘要

```
// 伪代码
if (estimateTokens(messages) > CONTEXT_WINDOW * 0.7) {
  const summary = await compressMessages(messages.slice(0, -3))
  messages = [systemPrompt, ...summaryAsMessages, ...messages.slice(-3)]
}
```

#### 方案 D：实现 Project Memories

把项目的关键上下文持久化存储：

- 目录结构摘要
- 关键文件的元信息（路径、用途、最近修改）
- 之前的任务记录和结论
- 每次 session 启动时注入到 system prompt，而不是靠重发历史

### 5.3 长期

#### 方案 E：远程压缩能力

参考 Codex 的 `compact_remote.rs`，支持用更小的模型做上下文压缩：

- 用低成本模型（如 GPT-4o-mini）做压缩
- 降低压缩本身的 token 成本
- 支持压缩策略配置（有损程度、保留结构化信息等）

#### 方案 F：分层记忆架构

```
┌─────────────────────────────────────────┐
│  Session Memory（当前会话）              │  ← 完整，不压缩
├─────────────────────────────────────────┤
│  Recent Memory（最近 3 轮摘要）          │  ← 摘要保留
├─────────────────────────────────────────┤
│  Project Memory（跨会话持久化）          │  ← 存储在文件系统
├─────────────────────────────────────────┤
│  Global Memory（全局知识）               │  ← skills / AGENTS.md
└─────────────────────────────────────────┘
```

---

## 六、参考代码路径

| 功能 | Codex 参考路径 | 说明 |
|------|---------------|------|
| 上下文压缩 | `codex-rs/core/src/compact.rs` | 本地模型压缩 |
| 远程压缩 | `codex-rs/core/src/compact_remote.rs` | 远程小模型压缩 |
| 压缩策略 | `codex-rs/core/src/compact/summarize.rs` | 摘要生成逻辑 |
| 压缩触发判断 | `codex-rs/core/src/context_manager/history.rs` | token 估算与触发 |
| 持久记忆读取 | `codex-rs/memories/src/read.rs` | 跨会话记忆注入 |
| 持久记忆写入 | `codex-rs/memories/src/write.rs` | 两阶段写入 + guard |
| 记忆存储格式 | `.codex/memories/` 目录 | 项目级记忆文件 |

---

*文档生成日期：2026-05-05*
