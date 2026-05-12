# 长任务上下文爆炸：根因分析与 Codex 架构对比

> 日期：2026-05-12
> 背景：基于 `msvvp9xe` 任务实测和 codex-main 源码对比，分析长任务上下文爆炸的根本原因。

---

## 1. 问题现象

任务 `msvvp9xe-260512004600-o1n4ofzn`（模型 mimo-v2.5-pro）在执行"根据文档小标题生成数据实体表"时：

- 16:46:43 → 16:47:59：**76 秒连续 streaming，无工具调用**
- 模型在单步内生成了完整的实体表设计方案（17 个子标题对应的全部字段设计）
- 整个任务仅 20 次工具调用，大部分时间花在模型纯文本输出上
- 未触发压缩，未触发 spillover

---

## 2. 之前尝试的改动及失败原因

### 2.1 `max_tokens: 3000`（中间步骤输出限制）

**为什么无效：**

- `max_tokens` 限制的是总输出 token（含 thinking/reasoning），不是 visible text
- 自定义 provider（mimo）可能不支持或忽略此参数
- 即使生效，3000 tokens 的 visible text 仍然足够写下一个完整的实体表设计

### 2.2 spillover 阈值降到 3000 tokens

**为什么无效：**

- spillover 是**事后检测**：assistant content 已经完整生成并进入 transcript 后，才触发替换
- 在 spillover 生效之前，内容已经占据了上下文空间
- 对 thinking/reasoning 内容完全不拦截（虽然 reasoning 不进入下一轮 transcript，但 visible text 会）

### 2.3 carryover context 截断

**为什么无效：**

- 解决的是"任务启动时历史 memory 过大导致立刻压缩"的问题
- 本次任务的核心问题是模型单步输出过大，与 carryover 无关

### 2.4 小结

所有改动都是在**限制模型能生成什么**或**事后补救**，而不是**限制什么能进入历史**。

---

## 3. Codex 架构对比

### 3.1 核心差异：截断时机

```
Codex:      工具输出 → truncate_middle(按模型策略) → 写入 history → 送入下一轮
Desk-Agent: 工具输出 → 原样写入 transcript → 送入下一轮 → 事后 spillover
```

| 维度       | Codex                          | Desk-Agent                           |
| ---------- | ------------------------------ | ------------------------------------ |
| 截断时机   | recording time（进入历史前）   | post-hoc（内容已进入 transcript 后） |
| 截断对象   | FunctionCallOutput（工具输出） | assistant content（可见文本）        |
| 截断算法   | middle-truncation（保留头尾）  | head+tail truncation（spillover）    |
| max_tokens | 不设置，模型自由生成           | 设置但可能被 provider 忽略           |
| 设计哲学   | 限制什么能进入历史             | 限制模型能生成什么                   |

### 3.2 Codex 的五层防护机制

#### 第一层：工具输出截断（核心）

`codex-rs/core/src/context_manager/history.rs` — `process_item` 函数：

- 每个 FunctionCallOutput 在进入历史向量前就被截断
- 使用模型特定的 TruncationPolicy（Bytes 或 Tokens）
- 截断后的内容物理上不可能超过预算
- **两层截断**：格式化时截断一次，录入历史时再截断一次（1.2x 容差）

#### 第二层：Plan Tool 强制分步

`codex-rs/tools/src/plan_tool.rs`：

- "At most one step can be in_progress at a time"——强制顺序执行
- 系统提示："Do not make single-step plans"
- 系统提示："When you made a plan, update it after having performed one of the sub-tasks"

#### 第三层：Agent 委派

`codex-rs/tools/src/agent_tool.rs`：

- spawn_agent 描述中包含详细的委派指导
- 子任务必须"concrete, well-defined, and self-contained"
- "decompose work so each delegated task has a disjoint write set"

#### 第四层：工具描述编码行为规范

- apply_patch 按文件和 hunk 操作，天然增量式
- shell 工具要求设置 workdir
- 工具描述本身就是行为指令

#### 第五层：系统提示约束

- "Balance conciseness to not overwhelm the user"
- "When you make big or complex changes, state the solution first"
- 没有"不要输出长内容"的指令——因为架构本身就不允许长内容留存

### 3.3 Codex 的关键设计决策

1. **不限制模型输出**：没有 max_tokens，模型可以自由生成
2. **限制什么能进入历史**：工具输出在 recording time 截断
3. **模型自适应**：模型发现大输出会被截断，自然转向增量式工作
4. **简单 agent loop**：无 max_iterations，无复杂分层，loop 直到模型不再请求工具

---

## 4. 根因分析

### 4.1 问题不是"模型输出太长"，而是"长输出能进入历史"

Desk-Agent 当前架构：

```
模型生成 10K visible text
    → 完整写入 transcript
    → 下一轮 prompt 包含这 10K text
    → 上下文膨胀
    → 触发压缩
    → 压缩后丢失上下文
    → 模型重复工作
```

Codex 架构：

```
模型生成 10K visible text
    → 截断到 2K → 写入 history
    → 下一轮 prompt 只包含 2K
    → 上下文可控
    → 模型学会"写大东西没用"
    → 自然转向增量式
```

### 4.2 为什么 prompt 指令（软约束）不起作用

Desk-Agent 的系统提示中已经有长任务协议：

```
For long tasks, treat context as a working window rather than durable storage.
Process one bounded chunk at a time.
Do not write full intermediate tables, large drafts, long logs, or raw reasoning into assistant content.
```

但这些指令是**软约束**。模型在以下情况下会忽略：

1. 任务本身需要大量设计思考（如 17 个实体表的字段设计）
2. 模型认为"一次性设计完再写代码"更高效
3. 没有物理约束阻止模型输出长内容
4. 自定义模型（mimo）对指令遵循能力可能弱于 OpenAI 模型

### 4.3 Spillover 为什么是错误的架构

Spillover 的设计假设是"检测到长输出后替换为摘要"。但这有三个致命问题：

1. **时机错误**：内容已经生成并进入 transcript 后才检测
2. **不覆盖 thinking**：只检测 visible text，不检测 reasoning
3. **依赖 provider 行为**：如果 provider 不返回 usage 信息，token 估算不准确

---

## 5. 已实施方案（2026-05-12）

### 5.1 核心改动：Transcript 级 Assistant Content + Tool Output 动态截断

在 provider loop 中，assistant message 和 tool output push 到 transcript **之前**，做 middle-truncation。

**设计哲学：** 不限制模型能生成什么，而是限制什么能进入历史。模型仍然可以自由生成长内容（UI 展示完整内容），但进入 transcript 的内容会被截断到动态预算内。

**截断预算：** 纯百分比驱动，随模型上下文窗口自动缩放，无硬上限。

```
assistantContentMaxTokens = max(1000, min(
  conversationBudget * 0.08,   // 单步 assistant 内容不超过会话预算的 8%
  contextWindowTokens * 0.03   // 且不超过上下文窗口的 3%
))

toolOutputMaxTokens = max(500, min(
  conversationBudget * 0.05,   // 单个工具输出不超过会话预算的 5%
  contextWindowTokens * 0.02   // 且不超过上下文窗口的 2%
))
```

不同模型的表现：
| 模型 | 上下文窗口 | assistant 上限 | tool output 上限 |
|------|-----------|---------------|-----------------|
| 32K 本地模型 | 32K | 1.6K tokens | 960 tokens |
| 128K 模型 | 128K | 3.8K tokens | 2.6K tokens |
| 256K 模型 | 256K | 7.7K tokens | 5.1K tokens |
| 1M 模型 | 1M | 30K tokens | 20K tokens |
| 2M 模型 | 2M | 60K tokens | 40K tokens |

比例系数可通过 settings 自定义：`assistantContentBudgetRatio`、`assistantContentWindowRatio`、`toolOutputBudgetRatio`、`toolOutputWindowRatio`。

**涉及文件：**

| 文件                            | 改动                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `bridge/contextCompression.mjs` | 新增 `calculateTranscriptBudget()` 导出函数，动态计算截断预算                        |
| `bridge/providers.mjs`          | 新增 `truncateAssistantContentForTranscript()` + `truncateToolOutputForTranscript()` |
| `bridge/providers.mjs`          | OpenAI 路径：assistant content 和 tool output push 到 transcript 前截断              |
| `bridge/providers.mjs`          | Google 路径：assistant content 和 tool output push 到 transcript 前截断              |

**截断算法：** middle-truncation（保留头尾 60%+30%，中间用 `...[truncated: X -> ~Y tokens]...` 替代）

**关键设计点：**

- 完整内容仍然保存在 `conversationMessages`（UI 展示用），只是 `transcript`（模型上下文）被截断
- spillover 机制保留作为兜底（阈值 6000 tokens），但不再是主要防护
- 不设置 `max_tokens` 限制模型输出，让模型自由生成

### 5.2 已移除的改动

- ~~`LONG_TASK_INTERMEDIATE_MAX_OUTPUT_TOKENS`~~：已删除，不限制模型输出

### 5.3 保留的改动

- **carryover context 截断**：仍然有价值，防止任务启动时 carryover 过大
- **completed write actions 注入**：仍然有价值，防止压缩后重复写入
- **spillover 机制**：保留作为兜底，但不再是主要防护

---

## 6. 对比总结

```
改动前：工具输出 → 原样写入 transcript → 送入下一轮 → 事后 spillover
改动后：工具输出 → 动态截断 → 写入 transcript → 送入下一轮
         assistant → 动态截断 → 写入 transcript → 完整内容送 UI
```

| 维度       | 改动前                     | 改动后                               |
| ---------- | -------------------------- | ------------------------------------ |
| 截断时机   | post-hoc（spillover）      | recording time（进入 transcript 前） |
| 截断策略   | 固定阈值 6000 tokens       | 动态百分比，随上下文窗口缩放         |
| 截断对象   | 仅 assistant content       | assistant content + tool output      |
| max_tokens | 设置但可能被 provider 忽略 | 不设置，模型自由生成                 |
| 设计哲学   | 限制模型能生成什么         | 限制什么能进入历史                   |

---

## 7. 一句话总结

**不是限制模型能生成什么，而是限制什么能进入历史。** 截断预算随上下文窗口自动缩放，无硬编码上限。
