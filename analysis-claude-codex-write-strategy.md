# Claude Code vs Codex 文件写入策略分析

## 用户问题

> Codex 和 Claude 这俩在工作区目录下生成文件时，是放到 tmp 目录下吗？

## 结论

**两者都不用 tmp 目录。** 文件直接写到用户工作区的目标路径。Aura 的 `.aura/tmp/` 约定是自己特有的设计。

---

## Claude Code：原子写入，目标路径原地落盘

**核心调用链：**
`FileWriteTool.ts` → `writeTextContent()` (file-utils.ts) → `writeFileSyncAndFlush_DEPRECATED()` (file.ts)

### 写入机制

```typescript
// file.ts:362-430 — 核心写入函数
// 1. 在目标同目录下创建临时文件
const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`

// 2. 写入临时文件
fsWriteFileSync(tempPath, content, { encoding, flush: true })

// 3. 原子 rename 到目标路径
fs.renameSync(tempPath, targetPath)

// 4. 清理：如果 rename 失败，删除临时文件并回退到直接写入
```

### 关键设计

- **临时文件是短暂存在的**（如 `foo.ts.tmp.12345.1716795600000`），rename 后立即消失
- 写入失败时自动清理临时文件，回退到非原子直接写入
- 目标文件是 symlink 时，穿透 symlink 写到真实目标
- 保留原文件权限（`chmodSync`）
- prompt 明确要求模型**优先用 Edit 工具（只传 diff）**，Write 只用于新建或完全重写

### 路径解析

```typescript
// file-utils.ts:266-272
const fullFilePath = expandPath(file_path)
// expandPath: "~" → homeDir, 相对路径基于 cwd 解析
```

**源文件位置：**
- `src/tools/FileWriteTool.ts` — Write 工具定义
- `src/tools/FileEditTool.ts` — Edit 工具定义
- `src/utils/file-utils.ts` — writeTextContent, expandPath
- `src/utils/file.ts` — writeFileSyncAndFlush_DEPRECATED

---

## Codex：apply-patch，直接操作工作区文件

**核心调用链：**
`apply-patch` CLI / `StreamingPatchParser` → `parse_and_apply()` → `apply_hunks()` → `apply_hunks_to_files()`

### 写入机制

```rust
// lib.rs:393-408 — AddFile 分支
Hunk::AddFile { contents, .. } => {
    let path_abs = hunk.resolve_path(cwd);  // 相对路径基于 cwd 解析
    write_file_with_missing_parent_retry(fs, &path_abs, contents.into_bytes(), sandbox).await;
}
```

### 关键设计

- **没有任何 tmp 目录**，通过 `ExecutorFileSystem` trait 直接写入目标路径
- 路径解析：`hunk.resolve_path(cwd)` — 相对路径基于 cwd
- 支持流式解析（`StreamingPatchParser`），模型边输出 patch 边解析
- 最终写入一次性完成
- patch 格式是 Codex 自有的（`*** Begin Patch` / `*** Add File` / `*** Update File`）

### 源文件位置

- `apply-patch/src/lib.rs` — 核心逻辑：parse, apply_hunks, apply_hunks_to_files
- `apply-patch/src/invocation.rs` — 命令行入口
- `apply-patch/src/streaming_parser.rs` — 流式解析器
- `apply-patch/src/standalone_executable.rs` — 独立可执行入口

---

## 三者对比

| 维度 | Claude Code | Codex | Aura |
|------|------------|-------|------|
| **写入方式** | Write（全量）+ Edit（diff） | apply-patch（自有格式） | write_file + apply_patch |
| **目标路径** | 直接写工作区原路径 | 直接写工作区原路径 | 项目文件写工作区，过程产物放 `.aura/tmp/` |
| **临时文件** | 同目录 `.tmp.{pid}.{ts}`，rename 后消失 | 无 | `.aura/tmp/` 持久化 |
| **tmp 隔离** | ❌ 不用 | ❌ 不用 | ✅ 用作临时产物隔离 |
| **原子性保障** | ✅ rename 原子操作 | ❌ 直接写入 | ❌ 直接写入 |
| **设计意图** | 原子写入保障数据安全 | 最小化 I/O，直接落盘 | 区分"项目文件"和"过程产物"，保持工作区整洁 |

---

## 分析方法说明

本分析基于以下源码文件的实际代码：

**Claude Code：**
- `claude-code-source-research/src/tools/FileWriteTool.ts`
- `claude-code-source-research/src/tools/FileEditTool.ts`
- `claude-code-source-research/src/utils/file-utils.ts`
- `claude-code-source-research/src/utils/file.ts`

**Codex：**
- `codex-main/codex-rs/apply-patch/src/lib.rs`
- `codex-main/codex-rs/apply-patch/src/invocation.rs`
- `codex-main/codex-rs/apply-patch/src/streaming_parser.rs`
- `codex-main/codex-rs/apply-patch/src/standalone_executable.rs`
