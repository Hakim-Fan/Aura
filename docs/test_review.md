Now I have the full picture. Let me trace through the sequence.

---

## 分析：文档处理任务的循环读文件问题

### 事件时间线

| 时间     | messageId                 | 事件                                            | 关键数据                                       |
| -------- | ------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| 15:07:16 | 4h7d3yrr                  | 上一任务结束，写入 snapshot                     | nextAction: 读 docx 文件生成表结构             |
| 15:07:16 | k8i1pbmk                  | **10 条 work memory** 注入为 Historical context | 包含 11 条 todo + 3 个已完成子任务 + 24 条证据 |
| 15:08:53 | 1hbnduyx                  | 当前任务进入 step 1                             | conversation=1,503, prompt=5,092               |
| 15:08:53 | 50e6b9b4                  | 模型请求完成                                    | 从 prompt=5,092 到此步骤结束                   |
| 15:09:13 | lsmm4s44                  | 工具执行：read_file                             | 路径=docs/xxx.md                               |
| 15:09:13 | **mgoxzwf3**              | **⚠️ 触发压缩**                                 | 67,300 > 64,000，evict 6,754 tokens，3 条消息  |
| 15:09:13 | ccn3wdk1                  | 压缩摘要写入                                    | summary=1,315 tokens，step=2/50                |
| 15:09:13 | 9dzk5clj                  | 压缩后的模型请求                                | **conversation=554**，prompt=7,299             |
| 15:09:42 | **260511150942-9l7pgrxr** | **⚠️ 再次决定读 docx**                          | "先看一下目标文件的内容"                       |

---

### 问题诊断

**这次"循环读文件"的原因不是工具证据不可见，而是压缩发生在错误的时机：**

#### 根因：carryover work memory 过大，任务刚启动就触发压缩

```
15:08:53  task started, step 1/50
15:09:13  step 1 just executed read_file
          → 67,300 > 64,000 → COMPRESS
```

10 条 work memory（11 条 todo + 3 个已完成子任务上下文 + 24 条工具证据 snapshot）注入后，prompt 已经 60K+ tokens。第一次 LLM 调用（step 1）的结果刚回来，总上下文就超过 64K 阈值，立刻触发压缩。

压缩后：

- conversation 从 ~67K 缩减到 **554 tokens**（只剩最近一条消息 + 压缩摘要）
- prompt 从 5,092 增长到 7,299（因为 snapshot 重建时包含了更多证据）
- LLM 看到的历史上下文极度稀薄

#### 具体后果

1. **Step 1 的 read_file 结果被压掉了** — LLM 在 step 2 只看到压缩摘要 + work memory snapshot，不记得刚读了什么
2. **snapshot 指令是过时的** — `nextAction` 是 15:07:16 从上一个任务继承的"读 docx 文件"，但当前任务可能已经读过相关文件了
3. **LLM 落回 snapshot 指令** — step 2（15:09:42）的决定"先看一下目标文件的内容"本质上是在执行 snapshot 里的旧指令，而非延续 step 1 刚完成的工作

---

### 涉及的代码问题

**问题 1：压缩阈值没有为 carryover work memory 预留空间**

`bridge/contextCompression.mjs` 中：

```js
// compactionSizeThreshold = 64,000
```

但 `calculateContextBudget` 算出来的 `totalSize` 包含了 carryover work memory（10 条，可能 40K+ tokens）。carryover 是不可压缩的"死重"，一旦注入就永远占据空间。如果它本身就接近或超过阈值，第一次 LLM 调用后几乎必然触发压缩。

**建议**：要么把 work memory 从压缩阈值计算中分离出来（只对 conversation 做阈值判断），要么在注入 work memory 前做截断（最多保留最近 N 条），要么提高压缩阈值。

**问题 2：压缩后 snapshot guidance 成为孤儿指令**

压缩后 LLM 的唯一上下文是：

- 压缩摘要（当前子任务的精华，~1300 tokens）
- work memory snapshot（上一任务的 nextAction）

这两个来源的信息可能矛盾。snapshot 说"读 docx"，但当前子任务可能已经读过了。LLM 没有机制区分"已做过"和"snapshot 建议做"，所以会选择执行 snapshot 指令。

**建议**：在压缩后的 system prompt 中，显式标记哪些 snapshot 指令已在当前任务中完成。或者在 `recordToolEvidenceCheckpoint` 里也维护一个"当前任务已完成的动作"列表，压缩后注入。

**问题 3：`autoToolEvidence` 在压缩时也被清除了**

```js
// maybeCompressMessagesForContext → 调用方没有显式保留 context.autoToolEvidence
```

`autoToolEvidence` 存在 `context` 对象上，压缩本身不会清除它。但问题在于压缩后的 LLM 看不到之前的 tool_result 内容（已被压掉），而 `appendRuntimeToolEvidenceToSystemPrompt` 只记录了"读过哪些路径"的元数据，没有记录读到了什么内容。所以 LLM 知道"读过 docs/xxx.md"但不知道内容是什么——仍然可能重读。

**建议**：在 tool evidence 中保留文件的前 N 行摘要（比如第一段/前 500 字符），这样即使压缩掉了完整内容，LLM 还能看到"我读过这个文件，内容以 xxx 开头"，减少重读冲动。

---

### 总结

| #   | 问题                                                          | 严重度   | 说明                                                                     |
| --- | ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| 1   | carryover work memory 过大导致任务启动即压缩                  | **High** | 10 条 memory ~40K+ tokens，加上 system prompt 和 conversation 轻松超 64K |
| 2   | 压缩后 snapshot 指令成为过时指令                              | **High** | LLM 看不到当前任务已做过什么，只能执行旧 snapshot                        |
| 3   | tool evidence 只记录元数据不记录内容                          | Medium   | 知道"读过"但不知道"读到什么"，仍可能重读                                 |
| 4   | 压缩阈值未区分 carryover（不可压缩）和 conversation（可压缩） | Medium   | carryover 作为死重应该独立计算                                           |

**核心建议**：work memory carryover 做截断（比如最多注入最近 5 条，或按 token 预算分配），并且在压缩后向 LLM 注入一个"当前任务已完成动作"的摘要，防止重复执行。
