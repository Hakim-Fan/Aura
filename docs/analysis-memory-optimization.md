# 桌面 Agent 内存占用分析与优化方案

> 分析日期：2026-05-08
>
> 现象：运行半天后进程内存占用达 ~3GB，违背 Tauri "轻量"的初衷。

---

## 一、结论先行

3GB 内存并不是由 3GB "有用文本"造成的，而是 **同一批数据被多处持有、长时间不释放** 的叠加效应。核心原因有 6 条，按严重程度排序如下。

---

## 二、六条根因

### 2.1 Rust 侧任务快照没有释放路径（真实泄漏）

**定位**：`src-tauri/src/main.rs`

- `AgentTaskStore` 用一个 `HashMap<String, AgentTaskSnapshot>` 长期持有每个任务的快照（L101）。
- 新任务通过 `tasks.insert(...)` 写入（L2401）。
- 前端轮询时 `get_agent_task` 会把整个 snapshot `clone()` 一份返回（L3088）。
- **全文没有找到任何 `tasks.remove(...)` 调用**。任务即使完成/失败/中止，Rust 进程里的 `message / reasoning / phaseOutputs / toolEvents / taskTree` 依然常驻内存。

> 这是最直接的内存泄漏，跑的任务越多，Rust 侧内存只会单向增长。

### 2.2 前端同一份运行时数据被重复存储多份

**定位**：`src/MainWindowApp.tsx`、`src/types.ts`

轮询每 250ms 一次（L1793），每次拿到完整 snapshot 后，数据被写入至少 5 个位置：

| 存储位置 | 写入点 | 说明 |
|---------|--------|------|
| `agentTasksBySession` | L1591 | 运行态快照的直接持有者 |
| `message.events` / `message.steps` | L1600, L1020 | 消息 variant 内嵌完整 events 和 taskTree |
| `message.reasoning` / `message.phaseOutputs` | L1600 | variant 内嵌推理和阶段输出 |
| `session.toolEvents` / `session.taskTree` | L1651 | session 顶层又存一份 |
| IPC clone | L3088 (Rust) | 每次 `get_agent_task` 调用的 Rust→JS 序列化副本 |

同一份 tool/event 数据在前端同时存在至少 5 份副本。

### 2.3 reasoning 和 phaseOutputs 是持续拼接的完整字符串，没有上限

**定位**：`src-tauri/src/main.rs`

- `append_reasoning_delta`（L2171）：每次把新 delta 直接 `+=` 拼回旧字符串。
- `append_phase_output_delta`（L2222）：同上。

没有截断、没有滑动窗口、没有总字节上限。长时间任务下这两个字符串可以无限增长。

> 工具输出相对好一些，`stringifyOutput` 走 `truncate(12000)`（`bridge/utils.mjs` L3, L88），单个 tool output 有上限。但 reasoning / phase 文本加上大量事件累计，仍然涨得很快。

### 2.4 历史版本保留整套执行痕迹，而不是轻量化

**定位**：`src/MainWindowApp.tsx`

- `archiveReasoningEntries`（L775）、`archivePhaseOutputs`（L787）、`archiveMessageEvents`（L769）、`archiveTaskTreeNodes`（L809）都是 **完整深拷贝旧数据并换个 archive id** 继续保留。
- 真正归档发生在版本切换/重试路径中（L2451）。
- 跑得越久、重试越多，内存不是只保留"当前版本"，而是 **当前版 + 所有历史版的完整 artifacts**，线性增长。

### 2.5 图片附件把 base64 直接留在内存中

**定位**：`src/MainWindowApp.tsx`、`src/lib/storage.ts`

- 添加图片时先把整文件读成 `bytesBase64`，再生成 preview data URL（L444）。
- 发消息时把 preview 作为 `image.dataUrl` 放进 message parts（L303）。
- 虽然持久化时会把 `preview` / `dataUrl` 清掉（`storage.ts` L1778），但在活跃会话的 React state 里它们一直是完整 base64 字符串。
- 经常截图、贴图的场景下，这块很容易冲上去。

### 2.6 整份会话历史被一次性加载并缓存多份

**定位**：`src/MainWindowApp.tsx`、`src/lib/storage.ts`、`src-tauri/src/main.rs`

| 缓存层 | 位置 | 说明 |
|--------|------|------|
| 前端 React state | `MainWindowApp.tsx` L1240 | 启动时从缓存全量加载到 `sessions` |
| storage `cachedSessions` | `storage.ts` L1851 | 存储层自己的内存缓存 |
| storage `persistedSessionSnapshots` | `storage.ts` L2075, L2078 | 持久化快照缓存 |
| Rust 加载 | `main.rs` L3392 | 加载时把每条消息的所有 `message_versions` 整包读出 |

同一份会话数据至少在 3–4 层各持一份副本，长会话本身就会抬高"静态基线内存"。

---

## 三、数据流全景图

```
┌─────────────────────────────────────────────────────────┐
│  Rust 进程                                               │
│                                                          │
│  AgentTaskStore (HashMap)                                │
│  ┌──────────────────────────────────────┐                │
│  │ task_id → AgentTaskSnapshot          │  ← 永不释放    │
│  │   .message (String)                  │                │
│  │   .reasoning (String, 无上限)         │                │
│  │   .phase_outputs (String, 无上限)     │                │
│  │   .tool_events (Vec, 持续增长)        │                │
│  │   .task_tree (Vec, 持续增长)          │                │
│  └──────────────────────────────────────┘                │
│            │                                             │
│            │ get_agent_task() → snapshot.clone()         │
│            ▼                                             │
│  IPC 序列化 (第 1 份副本)                                 │
└─────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────┐
│  前端 (React)                                            │
│                                                          │
│  agentTasksBySession  (第 2 份)                           │
│       │                                                  │
│       ├─→ message[].events        (第 3 份)              │
│       ├─→ message[].steps         (第 3 份)              │
│       ├─→ message[].reasoning     (第 3 份)              │
│       ├─→ message[].phaseOutputs  (第 3 份)              │
│       │                                                  │
│       └─→ session.toolEvents      (第 4 份)              │
│           session.taskTree         (第 4 份)              │
│                                                          │
│  ── 同时 ──                                              │
│                                                          │
│  storage.cachedSessions           (第 5 份)              │
│  storage.persistedSessionSnapshots (第 6 份)             │
│  images[].dataUrl (base64)        (图片常驻)              │
└─────────────────────────────────────────────────────────┘
```

---

## 四、优化方案（按优先级排序）

### P0-1：修复 Rust 任务 Store 的释放

**收益**：直接消除 Rust 侧的内存泄漏。

```rust
// main.rs — 新增释放命令
#[tauri::command]
fn release_agent_task(task_id: String, state: State<AppState>) -> Result<(), String> {
    state.agent_task_store.tasks.remove(&task_id);
    Ok(())
}
```

前端在任务状态变为 `completed` / `failed` / `cancelled` 后主动调用 `release_agent_task(taskId)`。

### P0-2：运行态不触发 sessions 全量持久化

**收益**：消除 250ms 轮询期间 `JSON.stringify` 全量序列化的内存峰值。

```typescript
// 方案 A：运行中跳过持久化
useEffect(() => {
  if (!storageReady || isRunning) return  // 运行中跳过
  saveSessions(sessions)
}, [sessions, storageReady, isRunning])

// 方案 B：节流，最多每 5 秒持久化一次
```

### P1-1：将 250ms 全量轮询改为增量/事件驱动

**收益**：从根本上减少 IPC 数据量和前端对象分配频率。

- **短期**：将轮询间隔从 250ms 调整为 1000ms。
- **长期**：改用 Tauri Event 推送模式，后端在任务有进展时 `emit` 增量事件，前端 `listen` 接收。

```typescript
// 长期方案示意
const unlisten = await listen('agent:progress', (event) => {
  const delta = event.payload  // 只传变更部分
  setAgentTasksBySession(current => merge(current, delta))
})
```

### P1-2：运行态只保留一份详细 artifacts

**收益**：消除前端 5 份副本的问题。

- 运行态只在 `agentTasksBySession` 里保留详细 `toolEvents` / `reasoning` / `steps`。
- `message` 和 `session` 层级只放摘要或轻量引用。
- 任务完成时一次性折叠进消息版本。

### P1-3：限制字符串型大对象

**收益**：防止 reasoning / phaseOutputs 无限增长。

参考现有的 `truncate` 逻辑（`bridge/utils.mjs` `TOOL_OUTPUT_MAX_CHARS = 12000`），给 reasoning 和 phaseOutputs 加总字节上限：

```typescript
const MAX_REASONING_BYTES = 100_000  // 100KB 上限
const MAX_PHASE_OUTPUT_BYTES = 100_000

function appendReasoningDelta(current: string, delta: string): string {
  const combined = current + delta
  if (combined.length > MAX_REASONING_BYTES) {
    // 保留前 70% + 截断提示 + 后 20%
    const head = combined.slice(0, MAX_REASONING_BYTES * 0.7)
    const tail = combined.slice(-MAX_REASONING_BYTES * 0.2)
    return head + '\n...(truncated)...\n' + tail
  }
  return combined
}
```

### P2-1：图片预览改为懒加载

**收益**：减少活跃会话中的 base64 常驻内存。

- 消息进入历史后不再持有 base64。
- 只保留文件路径，打开预览时再从磁盘读取。

### P2-2：历史会话按需加载

**收益**：降低静态基线内存。

- 不把所有 session 的 messages 常驻前端内存。
- 只保留摘要列表，切换到 session 时从 SQLite 按需加载。
- Rust 侧加载 session 时不要整包读出所有 `message_versions`（L3392）。

### P2-3：历史版本轻量化

**收益**：版本数线性增长时内存不再线性增长。

- `archiveMessageEvents` / `archiveTaskTreeNodes` 改为只保留摘要或引用 id，不完整深拷贝。
- 历史版本的详细数据从 SQLite 按需读取。

---

## 五、预期收益估算

| 优化项 | 预期内存降幅 | 实施难度 | 实施周期 |
|--------|:----------:|:-------:|:-------:|
| P0-1 Rust Store 释放 | 高（消除 Rust 侧泄漏） | 低 | 0.5 天 |
| P0-2 运行态跳过持久化 | 中（消除序列化峰值） | 低 | 0.5 天 |
| P1-1 事件驱动 / 降频轮询 | 高（减少 IPC 和 GC 压力） | 中 | 2-3 天 |
| P1-2 运行态单份 artifacts | 中（消除前端多副本） | 中 | 1-2 天 |
| P1-3 限制字符串上限 | 中（防止无限增长） | 低 | 0.5 天 |
| P2-1 图片懒加载 | 低-中（视使用习惯） | 低 | 1 天 |
| P2-2 历史会话按需加载 | 中（降低基线） | 中 | 2-3 天 |
| P2-3 历史版本轻量化 | 低-中 | 中 | 1-2 天 |

**建议优先实施 P0-1 + P0-2 + P1-3**，合计 1.5 天工作量，即可显著改善内存占用。

---

## 六、相关文件索引

| 文件 | 关键行号 | 内容 |
|------|---------|------|
| `src-tauri/src/main.rs` | L101 | AgentTaskStore 定义 |
| `src-tauri/src/main.rs` | L2171 | `append_reasoning_delta`（无上限拼接） |
| `src-tauri/src/main.rs` | L2222 | `append_phase_output_delta`（无上限拼接） |
| `src-tauri/src/main.rs` | L2401 | `tasks.insert(...)` |
| `src-tauri/src/main.rs` | L3088 | `get_agent_task` → `snapshot.clone()` |
| `src-tauri/src/main.rs` | L3392 | session 加载时整包读出 message_versions |
| `src/MainWindowApp.tsx` | L250-310 | `buildMessageParts`（图片 base64 写入 parts） |
| `src/MainWindowApp.tsx` | L444 | 图片 bytesBase64 + preview 生成 |
| `src/MainWindowApp.tsx` | L769 | `archiveMessageEvents`（深拷贝） |
| `src/MainWindowApp.tsx` | L809 | `archiveTaskTreeNodes`（深拷贝） |
| `src/MainWindowApp.tsx` | L1020 | `applySnapshotToSessionAndVariant` |
| `src/MainWindowApp.tsx` | L1240 | 启动时全量加载 sessions |
| `src/MainWindowApp.tsx` | L1591-1653 | 运行态数据写入多份副本 |
| `src/MainWindowApp.tsx` | L1737-1741 | 任务完成后清理 agentTasksBySession |
| `src/MainWindowApp.tsx` | L1793 | 250ms 轮询间隔 |
| `src/types.ts` | L383-412 | ChatMessage 类型定义 |
| `src/types.ts` | L612 | Session 类型（含 toolEvents/taskTree） |
| `src/lib/storage.ts` | L1778 | 持久化时清理图片 preview |
| `src/lib/storage.ts` | L1851 | `cachedSessions` |
| `src/lib/storage.ts` | L2075-2078 | `persistedSessionSnapshots` |
| `bridge/utils.mjs` | L3, L88 | `TOOL_OUTPUT_MAX_CHARS = 12000` |
