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

*文档生成时间：2026-05-05*
*关联文档：[analysis-vs-codex.md](./analysis-vs-codex.md)、[analysis-token-consumption.md](./analysis-token-consumption.md)*
