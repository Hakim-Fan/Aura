# Aura 上下文控制与自动压缩方案

> 针对 Aura 当前 token 消耗过高的问题，制定上下文窗口控制与自动压缩策略。

---

## 方案校对（2026-05-05）

结论：**方向合理，核心应从“字符/条数裁剪”切换为“token 预算 + LLM 语义压缩”。**

需要调整的一点：第七节里提到把 `recencyWeightedTrimMessages` / `imposeHistoryMessageCharBudget` 作为前置防线，这会在压缩前先丢信息，不符合“按 token 压缩，而不是信息裁剪”的目标。更合理的顺序是：

```
原始历史消息
    ↓
estimateMessagesTokens()          ← token 预算估算
    ↓
[超过阈值?] → compactMessages()   ← LLM 语义压缩旧历史
    ↓
保留最近 N 条原始消息
    ↓
进入 runAgent 主循环
```

已落地的短期实现：
- 前端 `src/lib/agent.ts` 不再按字符裁剪历史消息，完整文本交给 bridge。
- bridge 新增 `contextCompression.mjs`，按模型上下文窗口、system prompt、最大输出和工具缓冲计算有效阈值。
- `runRouteFirstAgent` 入口和每个 route pass 前都会检查 token 预算，超阈值时调用 Provider 做结构化摘要压缩，并保留最近 6 条原始消息。
- 撤掉 provider transcript 的硬截断层，避免把工具结果直接 slice 掉。工具运行期的语义压缩可以作为下一步单独做。
- 旧图片/二进制 parts 在压缩 prompt 中只保留附件元信息，不嵌入 `dataUrl`；最近 6 条消息仍保留原始 parts。

---

## 一、行业上下文控制实践

| 厂商/项目 | 策略 |
|-----------|------|
| OpenAI ChatGPT | 50 条消息保留完整 + 更早消息按比例裁剪 + 自动摘要 |
| Anthropic Claude Code | 100K context budget 预留 system+tool 定义、保留最近 5 轮完整输出 |
| Cursor | 动态计算 system + 各工具可用 tokens + 5K 压缩目标预算 |

**核心思路**：不是"存下全部再裁剪"，而是"从一开始就有 token 预算"。

---

## 二、Aura 此前的裁剪参数（已废弃）

此前在 `src/lib/agent.ts` 里通过“最近消息条数 + 单条字符上限 + 旧消息字符上限”做粗裁剪。这套逻辑已经从代码中移除。

### 问题分析

- 按**消息条数 + 字符数**粗裁剪，不是按 token 估算
- 16K 字符 ≈ 5K-8K tokens（中英文混合），单条近期消息上限已达数万 token
- 没有总 token 预算概念，无法适配不同模型的上下文窗口差异
- 没有自动压缩机制，长会话必然超出模型上下文窗口
- 当前代码已经撤掉这些常量，改由 bridge 侧 token 预算触发 LLM compaction。

---

## 三、推荐的压缩参数设定

### 通用公式

```
compression_threshold = context_window × 0.6
compression_target    = context_window × 0.25
reserved_tokens       = system_prompt + max_output_tokens + tool_results_buffer
```

### 各模型推荐参数

| 模型 | 上下文窗口 | 压缩触发阈值 | 压缩后目标 | 安全余量 |
|------|-----------|-------------|-----------|---------|
| GPT-4o | 128K | 80K (60%) | 30K-40K (25%) | ~48K |
| Claude 3.5/4 | 200K | 130K (65%) | 50K-60K (25%) | ~70K |
| Gemini 1.5 Pro | 1M | 700K (70%) | 200K (20%) | ~300K |
| Qwen2.5-72B | 128K | 80K (60%) | 30K (25%) | ~48K |
| DeepSeek V3 | 128K | 80K (60%) | 30K (25%) | ~48K |

### 关键约束

**触发阈值必须扣除 reserved_tokens**：

```
effective_threshold = compression_threshold - reserved_tokens
```

否则压缩完成后 system prompt 已占满窗口，压缩等于白做。`reserved_tokens` 包括：
- system prompt（含 skills、routeNotes、exposureNote 等）
- 最大输出 token 数（`reasoning_effort` 对应的 max_tokens）
- 工具结果预估缓冲区（建议预留 10K-20K）

---

## 四、废弃裁剪方案 vs 当前建议方案

### 废弃方案（字符级粗裁剪）

```
字符级单条上限       → 移除
最近消息条数硬裁剪   → 改为最近消息原文保留 + 旧历史语义压缩
无总 token 预算      → 新增总 token 估算器和压缩触发检查点
```

### 建议方案（token 级动态预算）

```
┌─────────────────────────────────────────────────────┐
│                  上下文 Token 预算分配                │
├─────────────────────────────────────────────────────┤
│  System Prompt + Tools     │  ~10K-20K (固定)       │
│  压缩摘要 (compaction)     │  ~5K-8K                │
│  最近 N 条原始消息          │  ~30K-40K              │
│  工具结果缓冲              │  ~10K-20K              │
│  最大输出                  │  ~16K-32K              │
│  安全余量                  │  ~20K-30K              │
├─────────────────────────────────────────────────────┤
│  总计 ≈ 模型上下文窗口                               │
└─────────────────────────────────────────────────────┘
```

---

## 五、实现方案

### 5.1 Token 估算器

在 `bridge/agent.mjs` 中新增 token 估算函数：

```javascript
function estimateTokenCount(messages) {
  // 粗估：英文 ~4 chars/token，中文 ~1.5 chars/token
  // 实际应使用 tiktoken / tokenizer 库
  let totalChars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') totalChars += part.text.length
      }
    }
  }
  return Math.ceil(totalChars / 3)  // 中英混合保守估计
}
```

### 5.2 压缩触发检查点

在 `runAgent` 主循环每轮 pass 开始前插入检查：

```javascript
// bridge/agent.mjs - runAgent 主循环内
for (let pass = 0; pass < MAX_ROUTE_RUNTIME_PASSES; pass += 1) {
  // ===== 新增：压缩检查点 =====
  const estimatedTokens = estimateTokenCount(messages)
  const providerMeta = providerRegistry.get(provider) || {}
  const contextWindow = providerMeta.contextWindow || 128000
  const compressionThreshold = contextWindow * 0.6
  const reservedTokens = estimateSystemPromptTokens(systemPrompt) + 16000 + 15000

  if (estimatedTokens > compressionThreshold - reservedTokens) {
    const compacted = await compactMessages(messages, provider, {
      targetTokens: contextWindow * 0.25,
      keepRecentCount: 4,  // 保留最近 4 条原始消息
    })
    messages = compacted
    emitTelemetryEvent('context-compressed', {
      before: estimatedTokens,
      after: estimateTokenCount(messages),
    })
  }
  // ===== 压缩检查点结束 =====

  // ... 原有逻辑继续 ...
}
```

### 5.3 压缩函数

```javascript
async function compactMessages(messages, provider, options) {
  const { targetTokens, keepRecentCount } = options

  // 1. 分离：旧历史 vs 最近消息
  const recentMessages = messages.slice(-keepRecentCount)
  const olderMessages = messages.slice(0, -keepRecentCount)

  if (olderMessages.length === 0) return messages

  // 2. 用同一个 provider 的轻量模型做压缩
  const compactionPrompt = [
    {
      role: 'system',
      content: `请将以下对话历史压缩为结构化摘要，保留：
1. 用户的核心目标和需求
2. 已经完成的关键操作和结果
3. 遇到的错误和当前状态
4. 尚未完成的任务
5. 关键的技术决策和上下文（文件路径、变量名等）

输出格式：使用 Markdown，每个维度一个 section。`
    },
    {
      role: 'user',
      content: JSON.stringify(olderMessages)
    }
  ]

  // 3. 调用 provider 做压缩（用较低的 reasoning effort 节省成本）
  const summary = await callProviderForCompaction(provider, compactionPrompt, {
    reasoningEffort: 'low',
    maxOutputTokens: 2000,
  })

  // 4. 替换旧历史为摘要
  return [
    {
      role: 'system',
      content: `[以下为前 ${olderMessages.length} 条对话的压缩摘要]\n\n${summary}`
    },
    ...recentMessages,
  ]
}
```

### 5.4 各模型上下文窗口注册

在 `bridge/providers.mjs` 中为每个 provider 补充 `contextWindow` 元数据：

```javascript
// bridge/providers.mjs
const PROVIDER_CONTEXT_WINDOWS = {
  'openai': 128000,
  'openai-responses': 128000,
  'anthropic': 200000,
  'deepseek': 128000,
  'qwen': 128000,
  'gemini': 1000000,
  'local': 32000,           // 本地模型通常上下文较小
  'local-openai': 32000,
  'local-anthropic': 32000,
  'local-ollama': 32000,
  'local-llamacpp': 32000,
}
```

---

## 六、压缩策略的两种模式

### 模式 A：被动压缩（推荐先实现）

在 `runAgent` 主循环中检查，超过阈值时自动触发。

- 优点：实现简单，对现有流程侵入小
- 缺点：压缩本身有延迟，用户会感知到一次额外等待

### 模式 B：主动压缩（后续优化）

在 `runAgent` **入口**就检查历史消息 token 数，如果已经超标，先压缩再开始 agent 循环。

```javascript
export async function runAgent({
  prompt,
  historyMessages,   // ← 从 session 传入的历史
  ...
}) {
  // 主动压缩：如果历史已经很长，先压缩再开始
  const preflightTokens = estimateTokenCount(historyMessages)
  const contextWindow = getContextWindow(provider)
  if (preflightTokens > contextWindow * 0.5) {
    historyMessages = await compactMessages(historyMessages, provider, {
      targetTokens: contextWindow * 0.25,
      keepRecentCount: 4,
    })
  }

  const messages = [...historyMessages, userMessage]
  // ... 正常 agent 流程 ...
}
```

- 优点：用户发消息时就已经精简了上下文，第一轮 pass 就能用更少的 token
- 缺点：每次发消息都要检查，首次等待可能更明显

### 推荐策略

**两种模式结合**：
1. **入口处**做主动压缩（模式 B）—— 减少首次 agent 调用的 token 量
2. **主循环内**做被动压缩（模式 A）—— 兜底，防止 agent 运行过程中 token 累积超标

---

## 七、与现有裁剪逻辑的协调

Aura 不应把 `recencyWeightedTrimMessages` 和 `imposeHistoryMessageCharBudget` 作为常规前置处理，否则压缩前已经发生信息丢失。它们最多只能作为**压缩失败后的紧急兜底**，并且需要明确 telemetry 标记。

```
原始历史消息
    ↓
estimateTokenCount()              ← token 级精确估算（新增）
    ↓
[超过阈值?] → compactMessages()   ← LLM 压缩（新增）
    ↓
[未超过阈值] → 直接使用
    ↓
进入 runAgent 主循环
```

这样可以保证常规路径是“压缩信息”，不是“裁掉信息”。

---

## 八、预期效果

| 场景 | 当前 | 改进后 |
|------|------|--------|
| 10 轮对话首次重试 | 发送全部 ~150K tokens | 压缩后 ~50K tokens |
| 20 轮长会话 | 可能超出窗口限制 | 自动压缩到 ~40K |
| 首次进入长会话 | 原样发送所有历史 | 入口压缩后发送 |
| Token 成本估算 | 无 | 有 telemetry 事件记录压缩前后 token 数 |

---

## 九、后续优化方向

1. **使用专用 tokenizer**：替换字符估算，用 `tiktoken`（OpenAI）或 `@anthropic/tokenizer` 做精确计数
2. **压缩模型选择**：压缩任务用更小更便宜的模型（如 GPT-4o-mini），降低压缩本身的成本
3. **渐进式压缩**：不是一次性压缩全部历史，而是分层压缩（最近 5 轮完整 → 5-10 轮轻度压缩 → 10 轮前重度压缩）
4. **用户感知优化**：压缩时显示"正在整理上下文..."的 UI 提示，而非无声等待
5. **压缩质量监控**：记录压缩前后 agent 行为的变化（是否丢失关键上下文导致错误），持续调优压缩 prompt

---

---

## 十、实现 Code Review（2026-05-05）

> 基于已落地的代码：`contextCompression.mjs`（263行）、`manualContextCompression.mjs`（65行）、`providers.mjs` 中 `compactMessagesWithProvider`（68行）、`agent.mjs` 中 `maybeCompressMessagesForContext`（50行）及两处调用点。

### 整体评价

方案的**架构设计正确**——实现了完整的 token 估算 → 预算计算 → 触发判断 → 分批压缩 → 摘要合并的流水线，并且在 agent loop 中做了**两层拦截**（preflight + runtime pass），provider 层也独立做了 transcript 压缩。比之前完全没有压缩是质的提升。

复核结果：第 1/2/3/4 项在当时的代码里确实存在，已在后续实现中修复；第 5/6 项进一步核对后发现当前实现已经具备，不属于阻塞性缺陷。

### 🔴 需要修复

#### 1. `KEEP_RECENT = 6` 但未限制近期消息的 token 上限

```js
// contextCompression.mjs:10
const DEFAULT_KEEP_RECENT_MESSAGE_COUNT = 6
// agent.mjs
const recentMessages = recentCount > 0 ? allMessages.slice(-recentCount) : []
```

`compactMessagesWithProvider` 无条件保留最后 6 条消息。如果这 6 条消息中包含大量工具输出（如读取了 3 个大文件），近期消息本身可能就占 30K-50K tokens，压缩完旧历史后近期消息仍然超出预算。

**建议**：在 `compactMessagesWithProvider` 中，对近期消息也做 token 估算，如果近期消息本身超过 `targetConversationTokens` 的 50%，则进一步减少 `recentCount` 或对最早的近期消息做截断。

#### 2. 分批压缩时上下文割裂

```js
// providers.mjs:654-668
for (const [index, batch] of batches.entries()) {
  const summary = await callProviderForCompaction(compactionSettings, {
    systemPrompt: buildCompactionSystemPrompt(batchTargetTokens),
    userPrompt: buildCompactionUserPrompt(batch, { ... }),
  })
  batchSummaries.push(summary)
}
// providers.mjs:671-685
const summary = batchSummaries.length === 1
  ? batchSummaries[0]
  : await callProviderForCompaction(compactionSettings, { /* merge */ })
```

每个 batch 被独立压缩，**batch 之间缺乏上下文**。例如 batch 1 包含"用户让我创建文件 X"，batch 3 包含"修复文件 X 的 bug"——独立压缩时 batch 1 不知道这个文件后来有 bug，batch 3 不知道文件是什么时候创建的。虽然有合并步骤，但合并只是把几个摘要拼在一起再压缩一次，信息已经不可逆地丢失了。

**建议**：采用 `chain-of-summary` 模式，将前一个 batch 的摘要注入下一个 batch 的压缩 prompt：

```js
let previousSummary = ''
for (const [index, batch] of batches.entries()) {
  const summary = await callProviderForCompaction(compactionSettings, {
    systemPrompt: buildCompactionSystemPrompt(batchTargetTokens),
    userPrompt: [
      previousSummary ? `Previous context:\n${previousSummary}\n\n---\n` : '',
      buildCompactionUserPrompt(batch, ...),
    ].join(''),
  })
  batchSummaries.push(summary)
  previousSummary = summary
}
```

### 🟠 建议优化

#### 3. Token 估算的 CJK 系数偏保守

```js
// contextCompression.mjs:18
return Math.ceil(cjkCount * 0.9 + otherCount / 3.7 + whitespaceCount / 8)
```

主流 BPE tokenizer 对中文的实际 token/字符比大约在 1.2-2.0 之间（取决于分词器），0.9 会**低估中文内容 25%-50%**。如果对话以中文为主，压缩触发会偏晚，导致实际发送时超出窗口限制。

**建议**：将 CJK 系数调高到 `1.4`，或提供可配置的 `tokenEstimationScale` 参数。

#### 4. 两处压缩调用的 `systemPrompt` 传递不一致

```js
// agent.mjs:1022 (preflight) — 没传 systemPrompt
const preflightCompression = await maybeCompressMessagesForContext({
  messages, settings, hooks, stage: 'preflight',
})

// agent.mjs:1219 (runtime) — 传了 systemPrompt
const runtimeCompression = await maybeCompressMessagesForContext({
  messages, settings: effectiveRunSettings, systemPrompt: lastSystemPrompt,
  hooks, stage: `pass-${pass + 1}`,
})
```

Preflight 阶段没有传 `systemPrompt`，导致 `shouldCompressMessages` 中 `systemPromptTokens = 0`，预算计算会**高估可用空间**约 8K-12K tokens。

**建议**：Preflight 也传入 systemPrompt 估算值（此时 systemPrompt 可能还没构建完成，但可以先用一个粗估值如 `estimateSystemPromptTokens()` ）。

#### 5. 运行时 transcript 压缩与 messages 压缩是两套独立系统

`compactOpenAiRuntimeTranscript` 和 `compactGeminiRuntimeTranscript` 在实现层面与 `compactMessagesWithProvider` 分开，但当前预算计算已经统一复用 `buildContextCompressionBudget`，并非两套完全独立的预算源。

**复核补充**：这条更适合作为后续架构收敛建议，而不是当前 bug。

#### 6. 独立压缩模型配置

`resolveCompactionSettings` 当前会优先检查 `analysisProviderProfileId + analysisModel`，只有未配置或模型不可用时才 fallback 到主模型设置。

**复核补充**：这条已具备，不是当前缺失项。

### 🟡 测试覆盖补充

已覆盖：
- ✅ Token 估算
- ✅ 预算构建
- ✅ 触发判断
- ✅ 分批逻辑
- ✅ 超大消息拆分
- ✅ 摘要消息构建

缺失：
- ❌ `compactMessagesWithProvider` 的集成测试（mock provider）
- ❌ 多 batch 合并流程
- ❌ `splitOversizedMessageForBatch` 中 chunk 重建的内容一致性
- ❌ `resolveCompactionSettings` 和 `resolveCompactionOutputTokens` 的行为
- ❌ `splitTextIntoTokenChunks` 对超长文本（100KB+）的收敛性能

### Review 总结

| 维度 | 评价 |
|------|------|
| **架构设计** | ✅ 正确，两层拦截（preflight + runtime）+ provider 级 transcript 压缩 |
| **Token 估算** | ⚠️ CJK 系数偏保守，可能低估 25%-50% |
| **近期消息保护** | ❌ 无 token 上限，近期大文件输出会绕过压缩 |
| **分批压缩** | ⚠️ 缺乏跨 batch 上下文传递（chain-of-summary） |
| **systemPrompt 一致性** | ⚠️ Preflight 缺少 systemPrompt 导致预算高估 |
| **双压缩系统** | ✅ transcript 与 messages 共用 `buildContextCompressionBudget` 预算源 |
| **测试覆盖** | ⚠️ 核心模块有测试，集成路径仍可继续补强 |
| **前端集成** | ✅ 有手动压缩入口 + 自动 preflight 压缩 |

**最高优先级修复**：
1. 给近期消息加 token 上限，防止近期大输出绕过压缩
2. 分批压缩改为 chain-of-summary 模式
3. Preflight 阶段补传 systemPrompt 估算

---

---

## 十一、前端上下文显示严重低估问题（2026-05-08）

### 问题现象

使用 Agent 执行任务后，UI 圆环和进度条显示上下文仅 ~10K，但模型实际消耗的 token 远超此数。用户担心：**显示上下文用了很少，但实际上已经满了，模型出现幻觉都不知道。**

经代码审查，这个担心是真实存在的。

### 根因：前端估算只统计了消息纯文本，遗漏了 5 大类实际消耗

#### 前端估算的计算范围

`estimateTextTokens`（`src/components/ChatView.tsx` L181-197）只统计了用户可见消息的纯文本字符：

```typescript
// CJK × 1.4 + 英文 / 3.7 + 空白 / 8
function estimateTextTokens(text: string): number {
  let cjkCount = 0
  let otherCount = 0
  let whitespaceCount = 0
  // ... 字符遍历 ...
  return Math.ceil(cjkCount * 1.4 + otherCount / 3.7 + whitespaceCount / 8)
}
```

`estimateSessionContextTokens`（L157-172）遍历 `messages` 数组，只对以下内容做估算：
- `message.content` 纯文本
- `parts[].text` 文本（图片 `dataUrl` 只算固定 1200 token）

#### 实际发给模型的内容（通过 `buildAgentRuntimeMessages`，`src/lib/agent.ts` L415-418）

| 组成部分 | 是否被前端估算计入 | 实际估算大小 | 说明 |
|---------|:---:|------|------|
| 用户消息文本 | ✅ | ~10K | `message.content` + `parts[].text` |
| **System Prompt** | ❌ | 10-30K | 开发者指令、能力摘要、Agent 循环指导、skills 注入 |
| **工具定义 Schema** | ❌ | 5-20K | 所有注册工具（exec_command、apply_patch、browse 等）的 JSON Schema 描述 |
| **Agent 多轮工具循环** | ❌ | 每轮 5-30K | 每次 tool_call（含参数 JSON）+ tool_result（含 shell 输出/文件内容）的完整历史 |
| **图片 base64 dataUrl** | 估算只算固定 1200 | 实际 10-50K+ | 大图的 dataUrl 可能 100KB+ 字符 |
| **研究模式 / Web 搜索结果** | ❌ | 视情况 | 搜索结果、网页抓取内容注入到消息中 |

**关键差距在 Agent 多轮工具循环**：Agent 在一个"任务"内部执行多轮 tool call（exec_command 读文件、shell 操作等），每一轮都把之前的完整上下文重新发给模型。前端看不到这些中间轮次，但模型的上下文窗口里全部塞满了。

#### 实际数据流示例：Agent 扫描项目代码

```
第1轮: system_prompt(~15K) + tools_schema(~10K) + user_msg(~2K) + tool_call_1(~1K) → ~28K
第2轮: 上面全部(~28K) + tool_result_1(~8K) + tool_call_2(~1K) → ~37K
第3轮: 上面全部(~37K) + tool_result_2(~8K) + tool_call_3(~1K) → ~46K
...
第10轮: → ~110K+
```

但前端 `estimateSessionContextTokens` 只看到最终写入 `message.content` 的结果文本，约 10K。

### `promptEnvelopeTokens` 的补救不够

`src/components/ChatView.tsx` L4154-4160 中有一个补救机制：

```typescript
const promptEnvelopeTokens = latestRouteDecision?.contextEstimate?.promptEnvelopeTokens || 0
const currentPromptContextTokens = sessionContextTokens + promptEnvelopeTokens
```

`promptEnvelopeTokens` 包含了 system prompt + tool schema 的估算。但存在三个问题：

1. **只在任务启动时计算一次**，不会随对话增长而更新——对话过程中 agent 多轮工具循环产生的增量完全不反映
2. **完全不包含 agent 多轮工具循环中的中间消息**——而这是最大的增量来源
3. **如果 `routeDecision` 不存在**（非 Aura 路由模式、或查看历史消息时），fallback 为 0

所以最终显示可能是 "10K + System/工具 15K = 25K"，但实际 API 调用时已经是 80-150K。

### 与 Codex 的上下文计量方式对比

Codex（codex-rs）的 token 计数和 Aura 有两个根本区别：

#### Codex 用模型返回的真实 usage，不是前端字符估算

Codex 的 `conversation.rs` 直接使用模型 API 响应中的 `usage.input_tokens` 字段。这是模型 tokenizer 精确计算的结果，包含了 system prompt、tools、所有消息的完整 token 计数。每次 API 调用后都会更新当前上下文使用量。

Aura 虽然也存了 `usage`（`src-tauri/src/main.rs` L2705 中 `currentVariant.inputTokens`），但前端的上下文显示（圆环/进度条）**没有使用这个值**，而是用 `estimateTextTokens` 做字符级粗估。

#### Codex 有 pre-flight token 预检，能在发送前就知道是否超限

Codex 的 `token_count.rs` 用 `tiktoken-rs`（Rust 版 BPE tokenizer）在构造 API 请求前精确计算 token 数。如果发现超限，会先触发 truncation 再发送。Aura 没有这层保护。

### 这意味着什么：幻觉风险

| 风险 | 说明 |
|------|------|
| **上下文膨胀不可见** | 模型实际上下文可能 100K+，但 UI 显示 10-20K |
| **幻觉和遗忘** | 上下文接近模型窗口极限时，模型 API 服务端会自动丢弃早期内容（截断策略由 API 决定），Agent 会丢失之前的指令和上下文 |
| **压缩机制永不触发** | `DEFAULT_CONTEXT_COMPRESSION_THRESHOLD_TOKENS = 256000`（`src/lib/agent.ts` L1049），但前端估算值远低于此阈值，导致运行态的 `maybeCompressMessagesForContext` 几乎永远判断为"不需要压缩" |
| **用户无法感知** | 圆环/进度条给用户的安全感是"上下文还很充裕"，实际上可能已经接近极限 |

### 建议修复方案

#### P0：用模型返回的 `usage.input_tokens` 替换前端字符估算

数据流中已经有这个值了——每次 API 调用的 `usage` 被存进了 message variant（`src-tauri/src/main.rs` L2705: `currentVariant.inputTokens`）。只需前端读取并使用即可：

```typescript
// 当前（低估）
const sessionRawContextTokens = estimateSessionContextTokens(messages)

// 改为（真实值）
const sessionRawContextTokens = latestMessageVariant?.inputTokens || estimateSessionContextTokens(messages)
```

这样圆环和进度条显示的就是模型实际消耗的 input tokens，包含 system prompt、tools、完整对话历史。

#### P1：在 Rust 侧维护实时 `current_context_tokens` 计数器

在 `pollAll` 返回的 `AgentTaskSnapshot` 中新增 `contextTokens` 字段，每次 API 调用后用返回的 `usage.input_tokens` 更新。前端直接从 snapshot 读取，不再做前端估算。

```rust
// src-tauri/src/main.rs — AgentTaskSnapshot 新增字段
pub struct AgentTaskSnapshot {
    // ... existing fields ...
    pub context_tokens: Option<usize>,  // 新增：当前实际上下文 token 数
}
```

#### P2：上下文快照驱动压缩触发

一旦有了真实的 `contextTokens`，运行态的压缩检查就可以基于真实值触发：

```typescript
// agent.mjs
const currentContextTokens = agentTask?.contextTokens || estimateSessionContextTokens(messages)
if (currentContextTokens > compressionThreshold - reservedTokens) {
  // 触发压缩
}
```

### 问题严重性评估

| 维度 | 评估 |
|------|------|
| **影响范围** | 所有长会话和多工具调用场景 |
| **用户感知** | 低——UI 显示正常但实际已超限 |
| **数据安全** | 高——可能导致 Agent 行为不可预测、幻觉、遗忘 |
| **压缩有效性** | 压缩机制因估算不准而形同虚设 |
| **修复复杂度** | P0 方案改动量小（前端读已有字段），P1 方案需要 Rust 侧改动 |

---

*文档生成时间：2026-05-05*
*最后更新：2026-05-08*
*关联文档：[analysis-vs-codex.md](./analysis-vs-codex.md)、[analysis-token-consumption.md](./analysis-token-consumption.md)*
