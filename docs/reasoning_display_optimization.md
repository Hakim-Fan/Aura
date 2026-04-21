# Agent 执行详情展示优化方案 (Execution Detail Display Optimization)

## 1. 背景与现状 (Context)
当前 Aura Assistant 在聊天页面里，会把 Agent 的执行过程按时间线展开显示，包括：
- reasoning
- phase outputs
- tool / shell / web 等执行事件
- approval 等待确认节点

现有方案的优点是信息完整、便于调试；但默认 UI 仍然偏“开发者视角”：
- 执行过程以多张卡片连续铺开，视觉重量较大。
- 普通步骤和关键步骤在视觉上差异不够明显。
- 当 reasoning 或工具输出很长时，用户会被大量中间过程打断，难以把注意力放在“当前进展”和“最终结果”上。

本次优化的核心不是减少记录，而是减少默认展示密度。

## 2. 设计原则 (Principles)
- **记录不变**：reasoning、phase outputs、events、steps 仍然完整记录，不能因为简化展示而丢数据。
- **纯渲染开关**：设置项只控制 UI 如何展示，不改变底层数据采集、存储和恢复逻辑。
- **历史消息同步生效**：用户切换开关后，历史消息也按照新的展示模式重新渲染，这是符合预期的。
- **审批优先**：凡是需要用户确认的步骤，始终保持清晰、完整、可操作的展示。
- **默认轻量**：默认关闭详细模式，让普通任务的执行流更接近“状态条 + 最新进展”，而不是“大卡片日志墙”。

## 3. 优化目标 (Objectives)
- **简洁性**：默认只显示用户真正需要关心的执行状态和最新进展。
- **掌控感**：用户仍然可以一键切换到完整执行视图，查看全部细节。
- **一致性**：不同模型返回的 reasoning 内容都按统一规则进行简化，不依赖特定 Markdown 结构。
- **视觉减负**：简化模式下不再沿用当前的大卡片时间线风格，而是改为更轻、更紧凑的过程展示。

## 4. 核心设计方案 (Core Design)

### 4.1 设置项：显示详细执行信息 (Show Detailed Execution Details)
在系统设置中新增 `显示详细执行信息` 开关。
- **默认状态**：关闭 (OFF)
- **作用范围**：纯渲染控制
- **切换行为**：切换后聊天页当前和历史消息都按新模式渲染
- **数据层影响**：无。reasoning / events / phase outputs / steps 仍完整保留

建议字段名：

```ts
showDetailedExecutionDetails: boolean
```

相比 `showDetailedReasoning`，这个名称更准确，因为简化/详细模式影响的不只是 reasoning，还包括事件、阶段输出和审批以外的执行流展示。

### 4.2 简化显示模式 (Detailed Toggle OFF)
当开关关闭时，聊天页的执行详情采用“紧凑执行摘要”模式。

#### 保留完整显示的内容
- `approval` 且 `awaiting_approval` 的步骤继续完整显示
- 审批文案、输入内容、允许 / 拒绝按钮保持现状
- 错误态事件可保留较高可见性，但样式应弱于审批卡片

#### 被简化的内容
- reasoning 不再逐张大卡片展开
- 普通 tool / shell / web 事件不再默认以独立大卡片连续铺开
- phase output 不再单独占据大块区域
- task tree 默认不在简化模式中展开

#### 新的展示形态
将原本的“大卡片时间线”改成一块更轻量的 `ExecutionDigest` 区域，建议形态如下：

1. 顶部一行状态摘要
- 例如：`执行中 · 3 个工具 · 最新进展`
- 使用更弱的边框、更小的内边距和更低的背景对比度

2. 中间显示最新进展文本
- 只展示最近一个有效 reasoning / phase output / event summary 的末尾 2-4 行
- 如果内容很长，只保留尾部文本，而不是首段文本
- 文本统一降级为纯文本，不渲染 Markdown 结构

3. 底部可选显示轻量统计
- 例如：`已检索 2 次 · 已调用 1 个工具`
- 用 chip / inline meta 的方式显示，而不是额外卡片

#### 视觉风格要求
- 不再使用当前这种一张接一张的 `rounded-xl + border + bg` 大卡片堆叠方式
- 简化模式应更接近“内联状态块 / 小尺寸摘要条 / 轻量日志条”
- 每条消息里简化后的执行区块视觉重量应明显低于最终回答正文
- 控制高度，避免执行区块喧宾夺主

### 4.3 详细显示模式 (Detailed Toggle ON)
当开关打开时，继续保留当前的完整执行时间线展示：
- reasoning phase cards
- tool / shell / web event cards
- phase output cards
- task tree
- 审批卡片

也就是说，详细模式基本沿用当前实现；本次改动重点放在“简化模式新增一种更轻量的渲染分支”。

## 5. 文本简化策略 (Content Reduction Strategy)

### 5.1 基本规则
- 所有原始文本继续完整保留
- 简化模式仅对展示内容做提炼
- 优先展示“最新片段”，不展示“最早片段”

### 5.2 最新片段提取规则
实现一个轻量级的 `buildExecutionDigestPreview()`：

1. 在以下来源中，按时间顺序取最后一个有效内容：
- latest reasoning content
- latest phase output content
- latest event summary / output snippet

2. 统一转为纯文本：
- 去掉 Markdown 标记
- 折叠多余空行
- 代码块替换为 `[代码段]`

3. 取尾部预览：
- 优先取最后 2-4 行
- 如果没有明确换行，则取末尾约 120-180 个字符
- 超出部分在前侧省略，例如 `...正在整理搜索结果并生成最终回答`

### 5.3 审批与错误例外
- 审批事件不参与摘要合并，保持独立显示
- 错误事件如果影响用户判断，可以在摘要区之外补一个轻量错误条

## 6. 技术实现建议 (Implementation Notes)

### 6.1 数据层
不修改消息记录结构，不裁剪历史数据，不改变持久化格式。

只需要在 `AgentSettings` 中新增一个展示开关：

```ts
export type AgentSettings = {
  // ...existing fields
  showDetailedExecutionDetails: boolean
}
```

同时更新：
- `src/lib/storage.ts` 默认值
- `src/lib/storage.ts` normalize 逻辑
- Settings 页面开关项

### 6.2 ChatView 渲染层分支
现有 `executionTimeline` 仍然可以保留，因为详细模式还需要它。

渲染时改为：

```tsx
if (settings.showDetailedExecutionDetails) {
  return <DetailedExecutionTimeline ... />
}

return (
  <>
    <ExecutionDigest ... />
    <ApprovalEvents ... />
  </>
)
```

其中：
- `DetailedExecutionTimeline` 复用当前时间线渲染
- `ExecutionDigest` 负责展示简化后的执行摘要
- `ApprovalEvents` 单独过滤并渲染等待确认的步骤

### 6.3 组件建议
- `ExecutionDigest`: 简化模式总入口
- `ExecutionDigestPreview`: 渲染最新几行文本
- `ExecutionDigestMeta`: 渲染工具数、步骤数、状态等轻量信息
- `ApprovalEventCard`: 继续复用现有审批卡片样式或轻微调整

## 7. 实施计划 (Implementation Roadmap)
1. 在 `AgentSettings` 中新增 `showDetailedExecutionDetails`
2. 在 Settings 页面加入“显示详细执行信息”开关，默认关闭
3. 在 `ChatView` 中新增简化模式渲染分支
4. 把审批事件从普通执行流中单独抽出，确保始终完整显示
5. 实现 `buildExecutionDigestPreview()`，展示最新几行而不是首段摘要
6. 调整简化模式视觉样式，移除大卡片堆叠感

## 8. 结论 (Summary)
这次优化的本质是：

**完整记录执行过程，但默认只以轻量方式展示；当用户需要时，再切换到完整执行视图。**

这样可以同时满足两类用户：
- 普通用户看到的是清晰、克制、不打扰主回答的执行反馈
- 开发者或高级用户仍能查看完整 reasoning 和执行细节

---
> **Status**: Revised Proposal
> **Author**: Antigravity (Architect)
> **Date**: 2026-04-21
