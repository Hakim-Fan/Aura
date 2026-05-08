# 内存优化 V1 代码 Review

> **审查日期**：2026-05-08
> **审查范围**：10 文件，+858 / -215 行
> **审查结论**：覆盖分析文档中 6 条根因中的 5 条，是一个高质量的优化版本。有 1 个建议合并前修复，其余可后续迭代。

---

## 目录

1. [需要处理的 Finding](#需要处理的-finding)
   - [Finding 1 — readImageDataUrl 无大小限制（合并前修复）](#finding-1--readimagedataurl-无大小限制合并前修复)
   - [Finding 2 — append_snapshot_delta 高频分配压力](#finding-2--append_snapshot_delta-高频分配压力)
   - [Finding 3 — 任务完成后工具面板短暂空白](#finding-3--任务完成后工具面板短暂空白)
   - [Finding 4 — hashSignaturePayload 碰撞风险（低）](#finding-4--hashsignaturepayload-碰撞风险低)
   - [Finding 5 — 运行中跳过持久化的崩溃风险](#finding-5--运行中跳过持久化的崩溃风险)
   - [Finding 6 — releaseAgentTask 静默吞错](#finding-6--releaseagenttask-静默吞错)
   - [Finding 7 — appendInputToAgentTask 的 fallback 绕过剥离](#finding-7--appendinputtoagenttask-的-fallback-绕过剥离)
2. [无问题的部分](#无问题的部分)
3. [优化覆盖总结](#优化覆盖总结)

---

## 需要处理的 Finding

### Finding 1 — readImageDataUrl 无大小限制（合并前修复）

**严重程度**：🔴 高 — 可能反向引入 OOM 风险

**位置**：`src-tauri/src/main.rs` L4053-4055

```rust
fn read_image_data_url(file_path: String) -> Result<Option<String>, String> {
    read_image_data_url_internal(&file_path, None)  // max_bytes = None
}
```

**问题**：`readImagePreview` 有 8MB 限制，但新命令 `readImageDataUrl` 传了 `None`，意味着任意大小的图片都会被完整读入内存并转为 base64（膨胀约 33%）。一张 50MB 的 PNG 会直接分配 ~67MB 内存。这个函数在 `buildAgentRuntimeMessage` 里被调用，会通过 IPC 把整个 data URL 传给 Rust 再传给 Node bridge。

**建议**：加一个合理上限（比如 50MB），超过后拒绝或压缩后再编码：

```rust
fn read_image_data_url(file_path: String) -> Result<Option<String>, String> {
    read_image_data_url_internal(&file_path, Some(50 * 1024 * 1024))
}
```

---

### Finding 2 — append_snapshot_delta 高频分配压力

**严重程度**：🟡 中 — 影响运行时性能

**位置**：`src-tauri/src/main.rs` L2218-2227

```rust
fn append_snapshot_delta(current: &str, delta: &str, max_chars: usize) -> String {
    let mut combined = String::with_capacity(current.len() + delta.len());
    combined.push_str(current);
    combined.push_str(delta);
    truncate_snapshot_text(&combined, max_chars)
}
```

**问题**：每收到一个 reasoning delta（可能每秒几十次），都会：

1. 分配一个 `current + delta` 大小的新 String
2. 遍历整个字符串做 `chars().count()`（`truncate_snapshot_text` 内部）
3. 再分配截断后的结果

当 reasoning 已经接近 100K 上限时，每次 delta 都在分配和遍历 ~100K 字符。

**建议**：改为先检查是否接近上限，只在超限时才做截断：

```rust
fn append_snapshot_delta(current: &mut String, delta: &str, max_chars: usize) {
    current.push_str(delta);
    if current.chars().count() > max_chars {
        let truncated = truncate_snapshot_text(current, max_chars);
        *current = truncated;
    }
}
```

这样正常增长阶段零额外分配，只在超限时才付出截断成本。但需要把调用处从返回值模式改为 `&mut String`。

---

### Finding 3 — 任务完成后工具面板短暂空白

**严重程度**：🟡 中 — 影响用户体验

**位置**：`src/MainWindowApp.tsx`

```tsx
// 之前
const displayedToolEvents = agentTask ? agentTask.toolEvents : activeSession?.toolEvents || []
const displayedTaskTree = agentTask ? agentTask.taskTree : activeSession?.taskTree || []

// 之后
const displayedToolEvents = agentTask?.toolEvents || []
const displayedTaskTree = agentTask?.taskTree || []
```

同时 session 级别的 `toolEvents` / `taskTree` 写入也被移除了（L1734、L1804、L3350）。

**问题**：任务完成后的数据流：

1. pollAll 拿到最终 snapshot（有 toolEvents/taskTree）
2. 完成后处理写入 message.events/message.steps
3. 下一轮 `runningTasksBySession` 移除该 task → 触发 `releaseAgentTask`
4. Rust 侧 snapshot 被删除
5. `agentTask` 变为 undefined → `displayedToolEvents = []`

在步骤 2 到步骤 5 之间，如果渲染发生，toolEvents 和 taskTree 会**短暂变空**。虽然 message 级别的 events/steps 已经保存，但运行态的详细工具面板会闪一下空白。

**建议**：在 `releaseAgentTask` 调用前，确保 `agentTasksBySession` 里的最终 snapshot 数据已经写入 message。或者在 `releaseAgentTask` 之后不要立即清除 `agentTasksBySession` 里的数据，而是延迟一帧。

---

### Finding 4 — hashSignaturePayload 碰撞风险（低）

**严重程度**：🟢 低 — 理论风险，实践中几乎不会触发

**位置**：`src/lib/storage.ts` L1948-1955

```typescript
function hashSignaturePayload(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`
}
```

**问题**：FNV-1a 32-bit 的碰撞概率在 ~65K 个不同输入时约为 50%（生日攻击）。有 `length:` 前缀缓解，但如果两个不同版本恰好相同长度且 FNV 碰撞，`syncPersistedSession` 会认为版本没变化而跳过持久化。

**建议**：实际风险很低（需要同时满足长度相同 + FNV 碰撞），当前方案在实践中应该足够。如果想更安全，可以用 `crypto.subtle.digest('SHA-256', ...)`。

---

### Finding 5 — 运行中跳过持久化的崩溃风险

**严重程度**：🟡 中 — 需要确认行为预期

**位置**：`src/MainWindowApp.tsx`

```tsx
useEffect(() => {
  if (!storageReady) return
  if (hasActiveRunningTasks) return  // 新增：运行中跳过持久化
  saveSessions(sessions)
}, [hasActiveRunningTasks, sessions, storageReady])
```

**问题**：如果应用在任务运行期间崩溃或被强制退出，从上次持久化到崩溃之间的所有消息和工具事件都会丢失。这是一个合理的 trade-off，但需要确认：

- 用户是否知道这个行为？
- 是否需要在任务完成后立即触发一次持久化？

**建议**：在任务完成/失败时，确保 `saveSessions` 被立即调用一次。当前代码依赖 `hasActiveRunningTasks` 变为 false 时 effect 重新触发，这应该是有效的，但值得验证。

---

### Finding 6 — releaseAgentTask 静默吞错

**严重程度**：🟢 低 — 调试不便

**位置**：`src/MainWindowApp.tsx`

```tsx
void releaseAgentTask(taskId).catch(() => {
  // Best-effort cleanup
})
```

**问题**：如果 `release_agent_task` 因为 Rust 侧锁竞争或其他原因失败，用户和开发者都不会知道。虽然这是 best-effort，但如果 release 持续失败，Rust 侧的 snapshot 就永远不会被释放。

**建议**：至少在开发模式下 log 一下错误：

```tsx
void releaseAgentTask(taskId).catch(error => {
  console.warn('[memory] Failed to release agent task:', taskId, error)
})
```

---

### Finding 7 — appendInputToAgentTask 的 fallback 绕过剥离

**严重程度**：🟢 低 — 当前代码路径不会触发

**位置**：`src-tauri/src/main.rs` L3269-3274

```rust
"parts": input
    .get("snapshotParts")
    .or_else(|| input.get("parts"))  // fallback to parts with dataUrl
    .cloned()
    .unwrap_or(serde_json::Value::Array(Vec::new())),
```

**问题**：如果前端因为某种原因没有传 `snapshotParts`（比如代码路径变更），fallback 到 `parts`（包含完整 dataUrl），Rust snapshot 就会持有 base64 数据。当前前端代码确实传了 `snapshotParts`，但这个 fallback 是一个静默的退化路径。

**建议**：可以考虑在 fallback 时也做一次 dataUrl 剥离，或者去掉 fallback 直接要求 `snapshotParts`。

---

## 无问题的部分

| 改动 | 评估 | 说明 |
|------|:----:|------|
| 轮询间隔 250ms → 1000ms | ✅ | 安全，不影响功能，IPC 压力降 4x |
| archive 函数加截断限制 | ✅ | 限制值合理，不影响历史回溯 |
| `stripInlineImageDataFromParts` / `stripAttachmentPreviews` | ✅ | 正确剥离图片数据 |
| `AttachmentThumbnail` 懒加载 | ✅ | 有 cancelled flag 防竞态 |
| `persistedSessionSnapshots` 改用签名 | ✅ | 大幅降低持久化层内存 |
| Usage tracking 贯穿 compaction + finalize | ✅ | 修复了累计 token 不准的问题 |
| `normalizeUsage` / `normalizeOpenAiUsage` / `normalizeGoogleUsage` | ✅ | 统一了不同 provider 的 usage 格式 |
| `ipc.mjs` 中 `emitAppendedInputs` 剥离图片 | ✅ | 防止 bridge 侧持有 base64 |
| `ClipText` / `TruncateReasoning` / `TruncatePhaseOutputs` | ✅ | 独立工具函数，可复用 |
| node bridge `finalize.json` / `append-snapshot-delta.json` 截断 | ✅ | 与 Rust 侧截断一致 |

---

## 优化覆盖总结

| 优化项 | 分析文档对应 | 状态 | 预期收益 |
|--------|:----------:|:----:|---------|
| P0: Rust 任务 store 释放 | 根因 1 | ✅ 已修 | 核心泄漏修复 |
| P0: 轮询频率降低 | 根因 2 | ✅ 已修 | IPC 压力降 4x |
| P0: 运行态跳过持久化 | 根因 3 | ✅ 已修 | 减少序列化开销 |
| P1: reasoning/phaseOutputs 截断 | 根因 3 | ✅ 已修 | 100K 字符上限 |
| P1: 归档 artifacts 截断 | 根因 4 | ✅ 已修 | 历史版本轻量化 |
| P1: 图片 base64 懒加载 | 根因 5 | ✅ 已修 | 大幅降低图片内存 |
| P1: 持久化快照轻量化 | 根因 6 | ✅ 已修 | 存储层内存降低 |
| P2: 历史会话按需加载 | 根因 6 | ❌ 未做 | 下一版 |

### 合并前必须处理

- **Finding 1**：`readImageDataUrl` 加大小上限

### 建议合并前处理

- **Finding 6**：`releaseAgentTask` 加 console.warn

### 可后续迭代

- Finding 2、3、4、5、7

---

## 关联文档

- [内存占用分析与优化方案](./analysis-memory-optimization.md)
