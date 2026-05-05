# Aura Token 消耗与重试记忆机制分析

> 对比 Codex，分析 Aura 在重试/继续场景下的记忆机制与 Token 浪费问题。

---

## 现状校对（2026-05-05）

结论：**部分符合现状，但需要修正一个关键点。**

- 当前 `src/lib/agent.ts` 启动任务时只传 `role/content/parts/researchMode`，不会把历史 assistant message 里的 `events` 或 session 级 `toolEvents` 原样塞进 `messages`。所以“跨轮重试会把之前所有 tool output 原样重发”这一点**不符合当前实现**。
- 仍然符合的问题：
  - 历史 user/assistant 文本内容会持续增大，需要 token 预算控制。
  - 历史 `parts` 也会进入运行时；不过已落盘的 session 会去掉图片 `dataUrl`/附件 preview，真正会放大请求体的是**当前活跃会话里仍保留为原始视觉输入的图片消息**。
  - 单次 provider run 内，OpenAI/Gemini transcript 会随着工具调用结果持续增长；虽然现在已经有运行期 transcript compaction，但在触发阈值之前仍会累积。
  - system prompt/skill prompt 每轮仍会重建并发送。
- 已开始的短期优化：
  - 前端不再做字符级历史裁剪，避免压缩前先丢信息。
  - bridge 侧已按 token 预算触发 LLM 语义压缩，旧历史变成结构化摘要，最近消息按预算自适应保留。
  - provider 运行期 transcript 也已接入 token 预算压缩，避免单次长工具链无限膨胀。
  - 步数打满后的 finalizer 现在不会再把 transcript 中已有的工具结果和 reasoning 摘要重复塞一遍。

---

## 一、重试时有没有之前的思考记忆？

**有，但现在已经不再是完全裸传。**

当一个任务失败后用户点"重试"或发送"继续"时，前端会把当前 session 里的历史 user/assistant 消息内容传给 `runAgent`。模型**能看到之前的用户输入和助手最终回复**，但当前实现不会把历史 assistant message 的 `events` 或 session 级 `toolEvents` 原样传入 `messages`。

问题在于：历史文本内容和 `parts` 仍然会进入下一轮，只是现在会在 preflight 和 runtime pass 前按 token 预算压缩。未触发压缩阈值时，旧长回复、长粘贴，以及仍保留为原始视觉输入的图片消息，还是会继续消耗 token/请求体积。

---

## 二、为什么 Token 消耗特别大？

核心原因有三个：

### 2.1 上下文压缩主路径已补齐，但仍有残余开销

Aura 此前没有完整的 context compaction；这一点现在已经补齐。当前实现里，历史消息会在进入 agent 前和每轮 provider 调用前按 token 预算触发摘要式 compaction；provider 内部 transcript 也会在接近阈值时做语义压缩。

- **Codex** 的做法：在上下文接近窗口上限时，调用一次压缩模型把历史消息摘要化（`compact.rs` / `compact_remote.rs`）
- **Aura 当前状态**：旧历史超过 token 阈值时由 LLM 压缩成结构化摘要，最近消息按预算自适应保留原始内容；单次 run 内旧 transcript 也会被压成摘要后再继续。

因此，这一节原文“缺少完整上下文压缩机制”已经不再成立。现在更准确的说法是：Aura 已经有完整的 token-budget compaction，但在**压缩阈值以下**，历史文本、最近原文消息、当前 run 的新工具结果仍会正常累积。

### 2.2 System Prompt 每轮重建但不精简

从 `bridge/agent.mjs` 代码可以看到，每轮都会重新构建 system prompt，包含：

| 组成部分 | 说明 |
|---------|------|
| 完整能力说明（`exposureNote`） | 每轮重复 |
| 所有挂载 skills 指令（`skillPrompt`） | 每轮重复 |
| 路由升级证据累积（`routeNotes`） | 最多保留 2 条 |
| 之前轮次 carryover 上下文（`carryoverContext`） | 累积增长 |

这些内容仍会拼成一份较大的 system prompt，并在每轮完整发送。这里的判断基本成立，但也要注意两点：

- `carryoverContext` 目前只保留有限的前轮 web 证据，且有长度上限，不是无限累积。
- 这一项更偏向架构成本，而不是“上下文压缩缺失”导致的 bug。

### 2.3 单次 provider run 内工具 transcript 仍会增长，但现在会被运行期压缩兜底

在 `agent.mjs` 的主循环中（`for (let pass = 0; pass < MAX_ROUTE_RUNTIME_PASSES; pass += 1)`），`toolEvents` 数组在整个运行过程中**只增不减**。

- 路由升级笔记只会摘要最近工具证据，并不会把原始 `toolEvents` 作为历史 `messages` 传给 provider。
- 真正会膨胀的是 OpenAI/Gemini provider 内部 transcript：每次工具调用结果都会作为 tool/function response 进入后续模型 step。
- 如果连续多步读取文件、搜索或执行命令，后续 step 会反复携带之前的工具输出；不过现在 transcript 接近预算时会自动压缩成摘要再继续。
- 另外，步数打满后的 finalizer 之前会把 transcript 里已经存在的工具结果和 reasoning 再拼一份提示，造成额外重复；这一点现已修复。

---

## 三、具体的 Token 浪费场景

| 场景 | 发生了什么 | Token 代价 |
|------|-----------|-----------|
| 单次 run 里读了 5 个文件 | 5 个文件的输出进入 provider transcript，后续 step 会继续携带；超过阈值后会被 runtime transcript compaction 摘要化 | 先增长，达到阈值后回落 |
| 第 2 轮用户说"继续" | 历史 user/assistant 文本和 parts 会继续发送，历史 tool output 不会原样重发 | 取决于历史文本、旧图片和长回复 |
| 第 3 轮用户说"重试刚才的任务" | 会保留目标用户消息之前的对话文本；失败助手消息的 events 主要留在 UI/存储层 | 文本历史继续增长 |
| 10 轮对话后 | 每轮都携带之前 user/assistant 内容；超预算的旧历史会被摘要替换，活跃图片输入和最近原文消息仍然保留 | 增长受阈值控制，但不会变成 0 |

### Token 增长示意

```
轮次 1:  system_prompt(~3K) + user_msg(~200) + provider_step_tool_output(~5K)       = ~8K
轮次 2:  system_prompt(~3K) + 文本历史/parts(~取决于会话) + user_msg(~200) + 本轮工具输出
轮次 3:  system_prompt(~3K) + 更多文本历史/parts + user_msg + 本轮工具输出
...
轮次 N:  system_prompt(~3K) + 历史文本/parts + 本轮 provider transcript 工具输出
```

增长主要来自三块：跨轮的历史文本/parts、单次 run 内 provider transcript 的工具输出累积，以及每轮都要重发的 system prompt。

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

### 5.1 已完成或已确认的方向

#### 方案 A：按 token 预算做上下文压缩，而不是前端先裁剪

- 这条已经实现，并且是当前主路径。
- 旧历史消息会在 bridge 侧按 token 预算压缩成结构化摘要。
- 最近保留的原文消息不是固定 6 条硬编码，而是按目标 token 预算自适应缩减。
- 这比“先在前端按字符裁剪”更符合当前目标，因为不会在压缩前先丢失语义信息。

#### 方案 B：运行期 transcript 压缩，避免单次长工具链持续膨胀

- 这条也已经实现。
- OpenAI/Gemini provider 内部 transcript 超过阈值后，会把较旧的 transcript 语义压缩成摘要，再继续后续 step。
- 步数打满后的 finalizer 也已经去掉了对 transcript 中已有工具结果 / reasoning 的重复注入。

### 5.2 中期

#### 方案 C：继续压 system prompt / carryover 的固定成本

这部分分析方向是对的，但它更像下一阶段优化，不是当前“压缩机制缺失”的主 bug。可以继续看的点包括：

- skill prompt 是否能按路由或能力层级进一步裁小
- carryoverContext 是否能做更细的按需注入
- 附件说明文本是否还有重复表达

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

## 七、当前实现 Code Review（2026-05-05）

本轮 review 结论：**未发现阻塞性错误**。当前实现已经具备按 token 预算做历史消息压缩和运行期 transcript 压缩的主路径，也没有发现“跨轮把历史 tool output 原样重发”的旧问题仍残留在运行链路里。

### 7.1 本轮已确认

- `startAgentTask` 只传 `role/content/parts/researchMode`，不会把历史 `events/toolEvents` 原样塞回 `messages`。
- session 持久化时会去掉图片 `dataUrl` 和附件 preview，避免存储层无限膨胀。
- 历史消息压缩、运行期 transcript 压缩、手动压缩入口、阈值配置与会话进度展示都已经接上主流程。

### 7.2 本轮已修复

- 步数打满后的 finalizer 之前会把 transcript 中已经存在的工具结果和 reasoning 再重复拼进 prompt，造成额外 token 消耗；这一点现已修复。

### 7.3 当前剩余的非阻塞优化点

1. `system prompt / skill prompt` 仍然是每轮完整重发，这是当前最稳定、也最难完全规避的一块固定成本。
2. 当前活跃会话里如果仍保留原始图片输入，后续轮次在压缩阈值触发前仍会重复携带这些视觉内容。
3. `carryoverContext`、附件说明文字、以及部分系统提示之间仍有轻微重复表达，后续还有继续瘦身空间。

### 7.4 结论

当前版本的主要问题已经从“压缩机制缺失”转为“固定成本仍偏高”。后续优化应优先放在 system prompt 瘦身、活跃图片输入策略，以及更细粒度的 carryover 注入上，而不是回退到前端裁剪历史或粗暴截断上下文。

---

*文档生成日期：2026-05-05*
