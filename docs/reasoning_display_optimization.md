# Agent 思考过程显示优化方案 (Reasoning Display Optimization)

## 1. 背景与现状 (Context)
当前 Aura Assistant 在执行任务时，会将模型的完整思考过程（Reasoning/Thought）显示在界面上。
*   **优点**：透明度高，方便开发者调试和观察模型逻辑。
*   **缺点**：信息密度过大，对于普通用户而言，冗长的思考文本（尤其是包含大量内部推理和 Markdown 标记时）会造成视觉疲劳，干扰对最终答案的关注。

## 2. 优化目标 (Objectives)
*   **简洁性**：默认提供清晰、简洁的执行状态反馈。
*   **掌控感**：保留详细日志查看能力，满足极客和开发者需求。
*   **一致性**：确保在各种模型（OpenAI, Google 等）返回的推理格式下都能保持良好的显示效果。

## 3. 核心设计方案 (Core Design)

### 3.1 全局开关 (Global Toggle)
在系统设置（Settings）中引入 `显示详细思考过程 (Show Detailed Reasoning)` 开关。
*   **默认状态**：关闭 (OFF)。
*   **存储位置**：`AgentSettings` 模型中，持久化于本地配置。

### 3.2 简化显示模式 (Simplified Mode)
当开关关闭时，对推理卡片（Reasoning Cards）进行以下处理：

#### 文本提炼
*   **语义截断**：不再完整渲染 Markdown 树。提取首段文字，并限制在 2-3 行（约 120 字符）。
*   **富文本降级**：将 Markdown 转换为纯文本预览，移除代码块、表格、加粗等样式，降低视觉优先级。

#### 视觉表现
*   **高度限制 (Clamping)**：设置卡片 `max-height`，配合 CSS `mask-image` 实现底部淡出渐变。
*   **状态动词化**：在文本前添加明显的动作标签（如：`分析中`、`检索中`、`生成中`），让用户一眼看清当前阶段。

### 3.3 详细显示模式 (Detailed Mode)
当开关打开时：
*   **完整渲染**：使用 `ReactMarkdown` 渲染所有推理内容。
*   **结构化展示**：保持当前的折叠/展开交互，允许用户深入查看每一步的逻辑。

---

## 4. 技术实现细节 (Technical Implementation)

### 4.1 数据结构扩展
在 `src/types.ts` 中更新 `AgentSettings`：
```typescript
export type AgentSettings = {
  // ... 其他设置
  showDetailedReasoning: boolean; // 新增：控制推理过程的显示精度
}
```

### 4.2 UI 组件重构 (`ReasoningPhaseCard`)
修改渲染逻辑，根据配置决定渲染模式：
```tsx
function ReasoningPhaseCard({ content, isActive, showDetailed }) {
  if (!showDetailed) {
    return (
      <div className="reasoning-card--simplified">
        <StatusIcon isActive={isActive} />
        <p className="line-clamp-2 opacity-80">{extractPlainText(content)}</p>
      </div>
    );
  }
  return <DetailedReasoningView content={content} isActive={isActive} />;
}
```

### 4.3 智能 Markdown 预览算法
实现一个轻量级的 `summarizeReasoning(text)` 函数：
1.  移除 Markdown 链接、图片、加粗等标记。
2.  移除首行之后的冗余换行。
3.  如果存在代码块，替换为 `[代码段]` 占位符。

---

## 5. 实施计划 (Implementation Roadmap)
1.  **Phase 1**: 修改 `types.ts` 并更新 Settings 界面，添加开关。
2.  **Phase 2**: 在 `ChatView` 中接入开关状态。
3.  **Phase 3**: 实现 `ReasoningPhaseCard` 的简化渲染逻辑和 CSS 样式（渐变淡出）。
4.  **Phase 4**: 优化长 Markdown 内容的截断算法，确保预览内容具有可读性。

---
> **Status**: Proposed
> **Author**: Antigravity (Architect)
> **Date**: 2026-04-21
