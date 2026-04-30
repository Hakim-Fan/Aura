# Agent 代码与文件编辑能力优化方案

> 状态：优化方案 v1，本轮已落地 P0/P1 关键止血项，并补充 Phase 2/3 的基础能力
> 日期：2026-04-30  
> 背景：连续日志暴露出 `apply_patch` 上下文失配、`edit_file` 精确文本失配、`replace_line_range` 参数错误后过早 finalizing 等问题。本文在现有 Aura 编辑链路基础上，对照本仓库内 `codex-main` 的编辑实现，给出分阶段优化方案。

---

## 0. 当前实现进度

截至本轮开发，已经完成：

1. `replace_line_range` 的参数预校验、行号前缀拒绝和结构化 repairHint。
2. `apply_patch` 的多级上下文匹配：exact、忽略行尾空白、trim、常见 Unicode 标点/空白归一化。
3. `read_file` 的 `raw/display/edit_context` 模式。
4. 新增 `read_block`，支持按 `anchorLine` 或 `anchorText` 读取缩进代码块，并返回 `startLine/endLine/text/numberedText/sha256`。
5. 编辑工具写后证据统一补充 `beforeSha256/afterSha256/changed/diffStat`。
6. `apply_patch` 在写入前产生 `preview` 进度事件，包含 affected paths 和文件级 diffStat。
7. `apply_patch` 兼容 `patch/input/command/content` 字段，降低不同调用路径的参数错配概率。
8. 修复循环已能区分 read-only inspection、invalid input 和实际写入修复尝试，避免参数错误直接耗尽写入预算。
9. 编辑工具已从 `bridge/tools.mjs` 拆分为 Tool Spec / Handler / Runtime 模块。
10. `search_code` 已返回可直接传给 `read_file mode=edit_context` 的 `suggestedRange/suggestedRanges`。
11. `apply_patch` 已支持 raw/freeform patch 参数容错，并在 OpenAI 兼容流式工具参数生成过程中输出 patch progress。
12. UI 已支持展示 `apply_patch` preview 的可视化 diff、streaming 阶段 affected paths、按文件折叠、大 diff 展开和审批前 diff 预览。
13. 新增 `verify_artifact`，DOCX/PPTX/XLSX 已能接入 artifact evidence 和 completion gate 的基础验收链路。

后续可继续深化的架构项：

1. 将 DOCX / PPT / Excel 从“产物存在与容器验证”继续升级到领域级内容读写 runtime。
2. 将 patch preview diff 继续升级为更完整的审阅工作台，例如逐文件审批、文件内跳转、搜索和更完整的大文件 diff 获取。
3. 在更多 Provider 协议下复用 `apply_patch` 参数流式解析；如果 Provider 支持真正 freeform tool channel，再把 schema 层从兼容容错升级为原生 freeform。
4. 将所有编辑入口进一步收束到统一 editing transaction，统一审批、预览、写入和验收事件。

---

## 1. 当前结论

这次问题不是“模型不够聪明”这么简单，而是编辑能力链路还没有形成足够强的运行时约束。

最近几类失败分别说明了不同层次的问题：

1. `Patch context did not match`：当前 `apply_patch` 定位过于严格，只做逐行完全匹配，遇到上下文漂移就失败。
2. `oldText was not found`：`edit_file` 依赖完整 exact text，模型稍微复制错、缩进错或文件已变动就失败。
3. `Line range 941-107`：`replace_line_range` 是有用 fallback，但参数 schema 没有表达 `startLine <= endLine` 这种跨字段约束，模型传反后工具只能拒绝。
4. `phase=finalizing` 过早出现：工具失败后的修复循环仍然太粗，读文件、错误参数、写入修复尝试没有被区分成不同恢复阶段。
5. `completionState=not_executed` 或 `failed_after_execution` 与用户预期不一致：执行证据和失败恢复状态还没有精确表达“失败已被后续修复覆盖”或“失败尚未进入真正写入阶段”。

所以优化方向不是继续堆更多编辑工具，而是把编辑链路升级成：

> 强读取上下文 + 强 patch 定位 + 参数预校验 + 分层修复状态机 + 确定性验收。

---

## 2. 当前 Aura 编辑链路 Review

### 2.1 已经做对的部分

当前 Aura 已经具备一些正确基础：

1. `apply_patch` 已成为主编辑工具，并且有 parser、verifier、runtime 三层。
2. `write_file / edit_file / multi_edit_file / replace_line_range` 都会写后 verification。
3. `read_file` 已支持 `startLine/endLine`，避免模型为了看局部内容调用 `awk/sed`。
4. shell 写源码行为已被拦截，降低了 Python/Node 脚本写文件的随机失败。
5. `agentEvidence` 和 completion gate 已经开始根据工具证据控制最终回答。
6. 日志已经能清楚暴露每一步工具、输入、错误分类和 task completion state。

这些改动是正确方向，但还不够接近 Codex 的稳定性。

### 2.2 主要短板

当前短板集中在五处：

1. **Patch 匹配太脆**  
   `bridge/editing/applyPatchVerifier.mjs` 里的 `findSequenceStart` 只做 exact match。Codex 的 `seek_sequence` 会依次尝试 exact、忽略行尾空白、trim、常见 Unicode 标点归一化。我们的 patch 很容易因为缩进、空白、复制差异失败。

2. **读文件输出格式不利于回写**  
   当前 `read_file` 范围读取输出 `849:...`。这对人可读，但模型容易把行号前缀混进 `content`，或者把多个范围的行号弄混。Codex 使用 `L2: ...` 这类明显前缀，并把 read slice/indentation block 作为专门能力。

3. **Fallback 工具没有强参数防线**  
   `replace_line_range` 能兜住 patch/context 失败，但 `startLine/endLine` 传反后只能报错。这个错误应在 tool input validation 阶段就变成更明确的“参数非法，不算一次写入修复尝试”。

4. **修复状态机粒度不够**  
   当前只知道“有未恢复工具错误”，但没有区分：
   - 上下文读取
   - 参数非法
   - patch 语法错
   - patch 上下文错
   - 写入失败
   - 写入成功但验证失败

   这会让 agent 要么过早 finalizing，要么在错误恢复中消耗不该消耗的预算。

5. **缺少编辑前后 diff 级反馈**  
   Codex 在 `apply_patch` 参数流式生成时就能解析出变更，并在工具事件里形成文件级 diff/progress。Aura 当前更多是工具完成后返回 verification，模型和 UI 都缺少“这次补丁实际会改哪里”的中间反馈。

---

## 3. codex-main 值得学习的地方

本节基于本仓库内 `codex-main` 的实现观察。

### 3.1 Patch 是核心编辑协议，不是普通工具

`codex-main/codex-rs/apply-patch` 把 patch 做成独立 crate，包含：

1. patch parser
2. heredoc / shell invocation 解析
3. streaming parse
4. hunk 转换
5. workspace filesystem apply
6. affected path summary

启发：

> Aura 也应该把 `apply_patch` 从普通工具升级成“编辑协议核心”，而不是和 `edit_file`、`replace_line_range` 平级竞争。

### 3.2 Patch 定位是渐进式匹配

Codex 的 `seek_sequence` 不是只做 exact match，而是多级匹配：

1. 完全匹配
2. 忽略行尾空白
3. 忽略首尾空白
4. 归一化常见 Unicode 标点和空格

启发：

> Aura 应优先增强 patch verifier 的 fuzzy context matching，而不是把失败推给 `replace_line_range`。

### 3.3 读取工具是面向模型编辑的

`codex-main` 的 read file handler 支持 offset/limit，并且测试覆盖：

1. 超出文件长度时报明确错误
2. 非 UTF-8 行可读
3. CRLF 可处理
4. 长行截断
5. indentation block 模式

启发：

> Aura 的 `read_file` 需要从“读文本”升级成“给模型稳定编辑上下文”，包括 block/anchor 读取、行号前缀规范、可复制原文模式。

### 3.4 工具 handler 和 runtime 边界清楚

Codex 的工具链有明确分层：

1. tool spec
2. handler
3. pre-tool payload
4. approval / sandbox
5. runtime
6. post-tool payload
7. event/diff 输出

启发：

> Aura 现在 `bridge/tools.mjs` 仍然承载太多职责。编辑类工具应拆出统一 `EditingToolHandler` 和 `EditingRuntime`。

### 3.5 Shell 可以拦截 apply_patch，但不鼓励 shell 写源码

Codex 支持从 shell 里识别 `apply_patch`，但最终仍走受控 patch runtime。

启发：

> Aura 现在拦截 shell patch 是对的；下一步应让所有编辑入口都汇入同一个 editing transaction，而不是每个工具各自写文件。

---

## 4. 优化目标

### 4.1 用户体验目标

1. 用户让 agent 修改代码，应该稳定完成，而不是反复 patch/context mismatch。
2. 失败后 agent 应继续修复，不应读了一次文件就 finalizing。
3. 参数传错时，工具应给出可执行修正建议，并且不消耗关键写入修复预算。
4. agent 不应使用 shell 脚本改源码。
5. 修改完成后，系统能确定文件确实变了、变更范围是什么、验证是否通过。

### 4.2 工程目标

1. `apply_patch` 成为唯一首选代码编辑协议。
2. `replace_line_range` 仅作为 narrow fallback，不成为主路径。
3. 所有编辑工具共享参数校验、路径校验、写前预览、写后验证。
4. 工具错误分类能驱动恢复策略，而不是只影响日志展示。
5. completion state 基于恢复后的最终状态，而不是简单统计是否出现过错误。

---

## 5. 分阶段方案

## Phase 0：立即止血

目标：先解决当前日志里的 `Line range 941-107` 和过早 finalizing。

建议改动：

1. **`replace_line_range` 参数预校验**
   - 在工具执行前验证 `startLine`、`endLine` 必须是正整数。
   - `endLine < startLine` 时直接返回 `invalid_input`，提示“你把 startLine/endLine 传反了，请重新读取范围后再调用”。
   - 这类错误不计入写入修复尝试次数。

2. **修复预算按错误类型拆分**
   - `read_file/search_code/glob_files` 不消耗写入修复预算。
   - `invalid_input` 不消耗写入修复预算，但消耗总修复轮次。
   - `patch_context_mismatch/text_context_mismatch` 消耗上下文修复预算。
   - 真正写入失败才消耗写入修复预算。

3. **错误回传更结构化**
   - 对 `Line range 941-107` 返回：
     - `category=invalid_input`
     - `code=INVALID_LINE_RANGE`
     - `repairHint.useTool=read_file`
     - `repairHint.nextTool=replace_line_range`
   - 不要只给自然语言 suggestedAction。

4. **finalizing 前检查未恢复错误**
   - 只要存在未恢复的编辑错误，且修复预算还没用完，就不能 finalizing。
   - 如果预算用完，最终回答必须明确“没有完成”，并展示最后一次可操作错误。

验收标准：

1. `startLine=941,endLine=107` 不再进入文件写入逻辑。
2. 该错误后 agent 仍会继续读取正确范围或重新生成 patch。
3. 日志里不会紧跟 `phase=finalizing`，除非修复预算确实耗尽。

---

## Phase 1：增强 `apply_patch` 匹配能力

目标：减少进入 fallback 的次数。

建议改动：

1. **移植 Codex 风格 `seekSequence`**
   - exact match
   - rstrip match
   - trim match
   - Unicode 标点/空白归一化 match

2. **支持 hunk header 多级定位**
   - 当前 patch parser 已支持 `@@ header`，但 verifier 应更充分使用 header。
   - 当 hunk header 存在时，先定位 header，再在 header 后找 oldLines。

3. **失败时返回最近候选**
   - 如果找不到 exact context，返回最相似的 3 个候选位置。
   - 给模型的信息应是结构化的：
     - expected old lines
     - nearest line numbers
     - mismatch reason

4. **patch preview**
   - 在真正写入前生成 affected files 和 unified diff。
   - UI 可以显示 patch 预览，模型也能收到更清晰的工具输出。

验收标准：

1. 空白差异、行尾空格、中文/英文标点差异不再导致 patch 失败。
2. `Patch context did not match` 数量明显下降。
3. 大部分代码修改重新回到 `apply_patch` 主路径。

---

## Phase 2：升级读取上下文能力

目标：让模型拿到适合编辑的上下文，而不是裸文本片段。

建议新增/增强：

1. **`read_file` 输出模式**
   - `mode=display`：带行号，给用户和模型定位。
   - `mode=raw`：不带行号，适合复制到 `expectedText`。
   - `mode=edit_context`：同时返回 `{ startLine, endLine, text, numberedText, sha256 }`。

2. **`read_block`**
   - 根据 anchor line 和缩进读取完整函数/组件/代码块。
   - 学习 codex-main 的 indentation block 读取。

3. **`search_code` 返回可直接读取的 ranges**
   - search 命中不只返回行文本，还返回建议 `read_file` range。

4. **上下文 token 控制**
   - 对大文件默认返回 head/tail summary + 命中块。
   - 避免模型在大文件里靠猜行号编辑。

验收标准：

1. 模型不再频繁用 `awk/sed` 读取片段。
2. `replace_line_range` 的 `content` 不包含行号前缀。
3. 大文件修改时，模型能稳定围绕函数/组件块编辑。

---

## Phase 3：建立统一 Editing Transaction

目标：所有编辑工具共享同一套预校验、写入、验证和证据输出。

建议设计：

```text
EditingTransaction
  - operation: apply_patch | write_file | edit_file | replace_line_range
  - target files
  - read snapshot
  - preflight validation
  - proposed changes
  - approval payload
  - apply
  - verify
  - diff summary
  - evidence record
```

关键点：

1. `apply_patch`、`replace_line_range`、`edit_file` 不应各自直接写文件。
2. 先生成 proposed changes，再统一进入 apply runtime。
3. 写前记录文件 hash，写后记录 hash。
4. verification 输出必须包含：
   - path
   - beforeSha256
   - afterSha256
   - bytes
   - changed
   - verified
   - diffStat

验收标准：

1. `agentEvidence` 不需要猜测工具语义，直接消费 editing evidence。
2. completion gate 可准确判断“失败已修复”。
3. UI 日志能展示“尝试了什么、实际改了什么、验证是否通过”。

---

## Phase 4：重构错误恢复状态机

目标：让工具错误真正驱动下一步，而不是只记录日志。

建议引入：

```text
EditRecoveryState
  - unresolvedError: boolean
  - lastErrorCategory
  - lastFailedTool
  - affectedPath
  - suggestedNextTool
  - readRepairTurns
  - contextRepairTurns
  - writeRepairAttempts
  - invalidInputAttempts
```

错误策略：

1. `invalid_input`
   - 不算写入失败。
   - 要求模型修正参数。

2. `patch_context_mismatch`
   - 要求重新读取目标区域。
   - 下一步优先重新 `apply_patch`，反复失败后才用 `replace_line_range`。

3. `text_context_mismatch`
   - 要求 `read_file mode=edit_context`。
   - 下一步可用 `replace_line_range`，但必须带 `expectedText` 或 `snapshotHash`。

4. `tool_not_found / missing_dependency`
   - 不要重复同一工具。
   - 进入替代工具路径。

5. `verification_failed`
   - 立即读回文件，比较 expected/actual。

验收标准：

1. 同一失效 patch 不会重复提交超过 1 次。
2. 参数错误不会导致立即 finalizing。
3. 最终失败回答里能说明“最后卡在哪一步”，而不是泛泛说任务失败。

---

## Phase 5：对齐 Codex 的工具架构

目标：让工具行为更像 Codex，而不是靠 prompt 拉扯。

建议改造：

1. **Tool Spec / Handler / Runtime 分离**
   - `bridge/tools.mjs` 只负责注册。
   - 编辑工具迁移到 `bridge/editing/tools/*.mjs`。
   - handler 负责参数解析和 preflight。
   - runtime 负责执行和验证。

2. **freeform `apply_patch`**
   - 当前 JSON `{ patch }` 形式可保留。
   - 增加 freeform patch tool 可降低 JSON escaping 错误。
   - 让模型直接输出 patch 文本，类似 Codex。

3. **apply_patch progress streaming**
   - 模型流式输出 patch 参数时，尝试 parse partial patch。
   - UI 可以提前显示 affected files。

4. **shell apply_patch interception 保持**
   - 但 shell interception 只转发到 apply_patch handler。
   - 不能落回普通 shell 执行。

5. **工具选择收敛**
   - 代码修改任务默认只暴露：
     - `read_file`
     - `search_code`
     - `glob_files`
     - `apply_patch`
     - `exec_command/write_stdin`
   - `edit_file/replace_line_range/write_file` 作为 fallback，可通过错误恢复提示显式引导使用。

验收标准：

1. 正常代码修改 80% 以上走 `apply_patch`。
2. fallback 使用次数下降，但一旦使用能稳定完成。
3. 工具日志更短、更可解释。

---

## 6. 文档、PPT、Excel 的编辑能力建议

代码编辑不应该和文档类编辑混在同一套工具心智里。

### 6.1 文档

建议能力：

1. Markdown：走文本 editing transaction。
2. DOCX：走结构化 document runtime，按 paragraph/table/comment 修改。
3. 输出后渲染或至少提取文本回读验证。

### 6.2 PPT

建议能力：

1. 按 slide/shape/text run/image 进行编辑。
2. 支持 render preview。
3. 验证包括页数、关键文本、图片是否存在、截图是否非空。

### 6.3 Excel

建议能力：

1. 按 workbook/sheet/range/table/formula/chart 修改。
2. 修改后重算公式或至少验证公式文本。
3. 产出 workbook summary 和 changed ranges。

### 6.4 统一原则

1. 文本文件用 patch/editing transaction。
2. 二进制办公文档用领域 runtime。
3. shell 只用于验证、转换和构建，不作为主编辑手段。

---

## 7. 建议实施顺序

### 优先级 P0

1. 修复 `replace_line_range` 参数预校验和错误分类。
2. finalizing 前强检查 unresolved editing error。
3. 让 invalid input 不消耗写入修复次数。

### 优先级 P1

1. 给 `applyPatchVerifier` 引入 Codex 风格 `seekSequence`。
2. 增加 patch mismatch 的结构化候选上下文。
3. 增加 `read_file mode=edit_context/raw/display`。

### 优先级 P2

1. 建立 `EditingTransaction`。
2. 将 `apply_patch/write_file/edit_file/replace_line_range` 接入统一 runtime。
3. completion evidence 改为直接消费 editing transaction 结果。

### 优先级 P3

1. 拆分 `bridge/tools.mjs`。
2. 引入 freeform apply_patch。
3. 引入 apply_patch progress streaming。

---

## 8. 关键验收用例

建议新增以下回归用例：

1. `replace_line_range` 收到 `startLine > endLine`，返回 `INVALID_LINE_RANGE`，不写文件。
2. `replace_line_range` 收到带行号前缀的 content，返回明确错误或自动拒绝。
3. `apply_patch` 在行尾空格不同的情况下仍能应用。
4. `apply_patch` 在缩进多/少但 trim 后一致的情况下能应用或给出候选。
5. 同一个失效 patch 不会重复提交两次。
6. `patch_context_mismatch -> read_file -> replace_line_range success` 后 completionState 是 `executed_verified`。
7. `patch_context_mismatch -> read_file only` 后不能 finalizing 成成功。
8. shell Python 写源码被拦截，并引导到 `apply_patch`。
9. 大文件只读局部上下文时，不使用 `awk/sed`。
10. 文档写入后必须有 read-back/hash verification。

---

## 9. 最小落地方案

如果只做一轮最小改造，建议按这个顺序：

1. 先修 `replace_line_range` 参数预校验。
2. 再移植 `seekSequence` 到 `applyPatchVerifier`。
3. 然后做 `read_file mode=edit_context`。
4. 最后调整修复状态机，让错误类型驱动下一步工具选择。

这四步能直接覆盖最近日志中暴露的问题，并且不会引入过重架构改造。

---

## 10. 最终目标形态

理想状态下，一次代码修改任务应该像这样运行：

```text
search_code / glob_files
-> read_file(mode=edit_context)
-> apply_patch
-> patch preflight with fuzzy matching
-> editing transaction apply
-> read-back/hash/diff verification
-> targeted test/build
-> final answer with verified evidence
```

fallback 路径应该是：

```text
apply_patch context mismatch
-> structured mismatch output
-> read_file(mode=edit_context, suggested range)
-> retry apply_patch
-> replace_line_range only if patch still cannot anchor
-> verify
```

而不应该是：

```text
patch fail
-> read random lines
-> repeat stale patch
-> exact oldText fail
-> bad line range
-> finalizing
```

这就是 Aura 和 Codex 当前体验差距的核心。

剩余后续大项

DOCX / PPT / Excel 从“产物验证”升级到真正领域级读写 runtime。
