# Agent 任务执行分支对比

本文对比三个 Aura Agent 执行方案的内在逻辑，并用同一个任务示例说明它们的执行流程差异：

> 分析工作区中的产品/需求文档，然后实现一份 PRD，并把 PRD 落盘到本地文件。

这里的重点不是 UI 或 Provider 差异，而是 Agent 在收到任务后如何决定：

- 要不要规划
- 要不要调用工具
- 什么时候写文件
- 什么证据算完成
- 为什么可能陷入“长时间思考但不落盘”

## 1. 三条路线概览

### 1.1 重编排 / 长任务方案

这条路线的核心是把 Agent 执行做成一个产品化任务编排系统。

典型链路：

```text
用户任务
  -> 任务分类
  -> 能力选择
  -> 规划 / step runtime / task tree
  -> Provider turn
  -> 工具执行
  -> evidence policy
  -> completion gate
  -> route escalation
  -> checkpoint / recovery
  -> finalization
```

它的目标是处理复杂任务、长任务、恢复、中断、权限、证据和可观测性。

优点：

- 适合桌面产品级 Agent。
- 有任务树、阶段状态、checkpoint、恢复、证据检查。
- 能支撑 MCP、插件、浏览器、桌面自动化、多 Agent 等能力。

问题：

- 默认路径太重。
- 模型容易先进入“规划/验证/恢复/收口”的心智，而不是马上产生文件副作用。
- 对 PRD、报告、文档这类产物任务，容易迟迟不触发 `write_file` / `apply_patch`。

一句话：它像一个完整任务管理器，但当前阶段容易“先管理任务，再执行任务”。

### 1.2 Kilo ask / plan / code 方案

这条路线的核心是把 Agent 当前状态显式分成三种模式：

```text
ask  -> 回答问题，不做文件变更
plan -> 只产出计划，不执行
code -> 执行本地修改、写文件、运行命令、验证结果
```

典型链路：

```text
用户任务
  -> 判断 ask / plan / code
  -> 按模式过滤工具
  -> code 模式要求直接执行
  -> Provider turn
  -> 有工具调用就执行
  -> evidence / completion 检查
```

优点：

- 模式边界更清楚。
- 能减少“用户要执行，Agent 却只给建议”的问题。
- `code` 模式下可以明确要求“规划、todo、读取文件都不算完成”。

问题：

- 如果只是 prompt 约束，仍然不能强制模型调用写入工具。
- 如果 `tool_choice` 仍是 `auto`，模型仍可输出长 reasoning 或长文本而不落盘。
- 对“生成 PRD / 产出文档 / 整理成报告”这类说法，模式识别如果没进 `code`，就可能退回回答型行为。

一句话：它解决了“当前应该问、计划还是执行”的边界，但还需要运行时硬约束来保证执行。

### 1.3 Claude hook / todo / checkpoint 方案

这条路线的核心是借鉴 Claude Code 式的协作运行时。

典型链路：

```text
用户任务
  -> default-agent 单主循环
  -> 多步任务鼓励 todo_write
  -> Provider turn
  -> 工具调用前后触发 hook
  -> 工具事件进入 evidence / audit
  -> checkpoint / recovery
  -> completion gate
```

它不是强制拆成 ask / plan / code，而是保留一个主 Agent，由模型自己决定回答、计划、工具调用或停下。

优点：

- 很适合成熟 Agent 平台底座。
- `PreToolUse` / `PostToolUse` / permission / audit 这类 hook 是产品化 Agent 的关键能力。
- `todo_write` 对长任务可视化很友好。
- checkpoint 和 recovery 能处理工具执行、中断、长输出等真实场景。

问题：

- `todo_write` 会给模型一个“先规划”的自然出口。
- hook 只能拦截已经发生的工具调用，不能让一个没有工具调用的模型输出自动变成落盘动作。
- 如果仍然依赖 prompt 要求“产物要写文件”，模型依旧可能长时间构思，不触发 `write_file`。

一句话：它最像成熟 Agent 平台底座，但容易把执行任务变成“计划、记录、观察”的协作流程。

## 2. 同一任务下的三种执行流程

任务：

```text
请分析 workspace/docs 下的产品资料，然后实现一份 PRD，保存到 docs/new-feature-prd.md。
```

### 2.1 重编排 / 长任务方案如何执行

可能流程：

```text
1. classify：识别为复杂、多步、工作区相关、需要产物。
2. route：选择本地读写能力，可能开启长任务路径。
3. planning：生成步骤，例如读取资料、提炼目标、设计 PRD 结构、写文件、验证。
4. step runtime：逐步推进任务树。
5. provider turn：模型开始执行当前步骤。
6. tool call：读取 docs 下的资料。
7. evidence：记录读文件证据。
8. 下一步：模型可能继续分析、总结、规划。
9. 写入：如果模型最终调用 `write_file`，PRD 才会落盘。
10. verify：读取或验证 PRD 文件。
11. finalization：总结结果。
```

容易空转的位置：

```text
planning / step runtime / finalization / completion gate
```

尤其当模型认为“PRD 内容需要先完整想清楚”时，它可能反复在 reasoning 中组织结构，而不是先写一个文件骨架。

### 2.2 Kilo ask / plan / code 方案如何执行

理想流程：

```text
1. 判断任务需要本地文件产物，进入 code 模式。
2. code 模式暴露读写工具，隐藏纯 plan 工具。
3. prompt 明确：用户要 concrete work，不要继续计划。
4. 模型读取 workspace/docs。
5. 模型调用 `write_file` 创建 docs/new-feature-prd.md 骨架。
6. 模型继续用 `apply_patch` / `edit_file` 分块补全。
7. 模型读取文件或运行验证命令确认存在。
8. evidence gate 允许最终回答。
```

容易空转的位置：

```text
tool_choice: auto
```

如果模型第一轮没有工具调用，只输出“我将先分析资料并设计 PRD”，运行时只能追加提醒，而不能天然强制写文件。

关键风险：

```text
生成 PRD / 产出 PRD / 整理成 PRD
```

这些表达如果没有被识别为 `requiresWrite`，可能不会进入 code 模式。

### 2.3 Claude hook / todo / checkpoint 方案如何执行

可能流程：

```text
1. classify：识别为复杂、多步、工作区相关。
2. default-agent 进入单主循环。
3. prompt 鼓励多步任务使用 todo_write。
4. 模型调用 todo_write：读取资料、提炼需求、编写 PRD、验证文件。
5. 模型读取 docs 下资料。
6. hook 记录 PreToolUse / PostToolUse。
7. checkpoint 记录已读资料和中间状态。
8. 模型可能继续更新 todo 或总结分析。
9. 如果模型调用 `write_file`，PRD 落盘。
10. evidence policy 检查写入证据。
11. completion gate 决定能否声明完成。
```

容易空转的位置：

```text
todo_write 后继续分析
checkpoint / work memory 后继续整理
provider reasoning 长时间构思 PRD
```

hook 体系能管住工具调用前后的行为，但管不住“模型一直不调用工具”。

## 3. 三者的核心差异

| 维度 | 重编排 / 长任务 | Kilo ask/plan/code | Claude hook/todo/checkpoint |
|---|---|---|---|
| 主心智 | 任务编排 | 模式分离 | 协作式工具循环 |
| 默认行为 | 先分类、规划、执行、验证 | 先判断问/计划/执行 | 模型自主决定，复杂任务用 todo |
| 对复杂任务 | 强 | 中等 | 强 |
| 对快速落盘 | 弱 | 较强 | 中等偏弱 |
| 对可观测性 | 强 | 中等 | 强 |
| 对权限/审计 | 中等到强 | 中等 | 强 |
| 空转风险 | 高 | 中 | 中高 |
| 最适合定位 | 长任务/恢复/复杂编排 | 执行模式边界 | 成熟 Agent 平台底座 |

## 4. 为什么都会出现“不落盘”

三个方案虽然差异明显，但当前都有一个共同问题：

```text
落盘主要依赖模型自觉调用写入工具，而不是运行时强制。
```

只要 Provider 仍允许：

```text
tool_choice: auto
```

模型就可能选择：

```text
继续 reasoning
继续解释
继续计划
继续总结
```

而不是调用：

```text
write_file
apply_patch
edit_file
exec_command
```

Prompt 可以提高概率，但不能保证行为。

## 5. 更推荐的组合

更符合当前优秀 Agent 架构的组合不是三选一，而是：

```text
Claude hook/todo/checkpoint 作为底座
Kilo ask/plan/code 作为模式外壳
重编排/长任务能力作为 fallback
再加执行型任务的运行时硬约束
```

推荐目标链路：

```text
用户任务
  -> Mode Router: ask / plan / code
  -> code 模式识别产物型任务
  -> Default Tool Loop
  -> Hook / Permission / Audit
  -> Evidence Gate
  -> Checkpoint / Recovery
```

其中最关键的是新增硬规则：

```text
如果是 code 模式 + 产物型任务 + 写入工具可用：
  第一轮必须产生可观察工具进展。

如果模型第一轮没有 tool call：
  不允许 final answer。
  注入强制执行消息。
  必要时强制 tool_choice 到 read_file 或 write_file。

如果目标是 PRD / 报告 / 文档 / HTML / PPT 等大产物：
  优先 write_file 创建最小可检查骨架。
  再用 apply_patch / edit_file 分块补全。
  最后读取或验证文件。
```

## 6. 对 PRD 任务的理想执行闭环

理想情况下，“分析文档后实现 PRD”应该被压成下面这个闭环：

```text
1. read_file / glob_files：找到并读取资料。
2. write_file：创建 docs/new-feature-prd.md 最小骨架。
3. apply_patch / edit_file：补全背景、用户、目标、范围、流程、验收标准。
4. read_file：读回 PRD 文件确认内容存在。
5. final answer：只说明文件路径、完成内容、未验证事项。
```

这个闭环里，`todo_write`、checkpoint、work memory 都可以存在，但不能替代第 2 步的真实落盘。

## 7. 结论

当前三个方案分别解决了不同问题：

- 重编排方案解决复杂任务管理，但默认路径太重。
- Kilo 方案解决模式边界，但需要硬执行约束。
- Claude 方案解决产品级 hook、todo、checkpoint、审计和恢复，但容易给模型更多规划空间。

最符合 Aura 长期方向的是：

```text
以 Claude hook/todo/checkpoint 为平台底座，
合入 Kilo ask/plan/code 的模式边界，
保留重编排能力作为复杂任务 fallback，
并为 code 模式加入“必须产生工具进展 / 必须落盘”的运行时硬约束。
```

否则，无论哪条路线，只要“是否写文件”仍完全交给模型自觉，PRD 这类大产物任务都会有概率陷入长时间思考但不落盘。
