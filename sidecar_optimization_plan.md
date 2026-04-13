# Node Sidecar 体积优化方案

> 当前 App 包体积 **146MB**，其中 Node.js sidecar 占 **87MB (60%)**。
> 本文档记录三种可行的优化方案，供后续评估选择。

## 📊 当前体积分布

| 组件 | 大小 | 占比 |
|------|------|------|
| Node.js v20 sidecar | 87MB | 60% |
| playwright-core | 11MB | 7.5% |
| chromium-bidi + deps | 23MB | 16% |
| Bridge 脚本 (ipc.mjs 等) | ~3MB | 2% |
| Rust 主程序 + 前端 | ~10MB | 7% |
| Skills + 其他资源 | ~12MB | 8% |

---

## 方案一：优先使用系统 Node（推荐）

### 思路
Release 模式下不再强制使用 sidecar Node，而是优先检测用户系统已安装的 Node.js。
找不到时再 fallback 到 sidecar（或直接提示用户安装）。

### 改动范围
仅 `src-tauri/src/main.rs` 的 `build_node_command` 函数：

```rust
// 当前逻辑
fn build_node_command<R: Runtime>(...) -> Result<Command, String> {
    let mut command = if cfg!(debug_assertions) {
        Command::new(&resolve_node_binary())   // dev: 系统 Node
    } else {
        app.shell().sidecar("node")            // release: 打包的 sidecar
            .map(Command::from)...
    };
    // ...
}

// 优化后
fn build_node_command<R: Runtime>(...) -> Result<Command, String> {
    let mut command = if let Some(system_node) = find_system_node() {
        Command::new(system_node)              // 优先系统 Node（dev + release 都走这里）
    } else if cfg!(debug_assertions) {
        return Err("Node.js not found".into()) // dev 模式必须有系统 Node
    } else {
        app.shell().sidecar("node")            // release 兜底用 sidecar
            .map(Command::from)...
    };
    // ...
}
```

### 效果

| 场景 | App 体积 | 功能完整性 |
|------|---------|-----------|
| 用户有系统 Node | 59MB（可移除 sidecar） | ✅ 100% |
| 用户无系统 Node（保留 sidecar 兜底） | 146MB | ✅ 100% |
| 用户无 Node 且不打包 sidecar | 59MB | ❌ 无法运行 Bridge |

### 优缺点
- ✅ **改动量最小**（约 20 行 Rust）
- ✅ **零兼容性风险**（系统 Node 在 dev 模式下已完全验证）
- ✅ 可选择性地从 `externalBin` 移除 sidecar 以缩小分发包
- ⚠️ 依赖用户环境，需要处理 Node 版本过低的情况（建议最低 v18）
- ⚠️ 需要友好的安装引导 UI（检测不到 Node 时弹窗提示）

---

## 方案二：Bun 替换 Node Sidecar

### 思路
将 87MB 的 Node 二进制替换为 ~42MB 的 Bun 二进制。

### 改动范围

| 文件 | 改动 |
|------|------|
| `src-tauri/binaries/` | `node-x86_64-apple-darwin` → `bun-x86_64-apple-darwin` |
| `src-tauri/tauri.conf.json` | `"externalBin": ["binaries/bun"]` |
| `src-tauri/src/main.rs` | `.sidecar("node")` → `.sidecar("bun")` |
| Bridge 脚本 | **无需修改** |

### 下载 Bun 二进制
```bash
# macOS x86_64
curl -Lo bun-x86_64-apple-darwin https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-x64.zip
# macOS arm64
curl -Lo bun-aarch64-apple-darwin https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip
```

### 效果

| 指标 | Node | Bun |
|------|------|-----|
| Sidecar 大小 | 87MB | ~42MB |
| App 总体积 | ~146MB | **~101MB** |
| API 兼容性 | 100% | ~98% |

### 兼容性风险清单

| 功能 | 兼容性 | 备注 |
|------|--------|------|
| fetch + SSE | ✅ | Bun 原生支持，性能更好 |
| readline (IPC) | ✅ | |
| child_process | ✅ | |
| createRequire() | ✅ | |
| ESM dynamic import() | ✅ | |
| @modelcontextprotocol/sdk | ✅ | 标准 Node API |
| **playwright-core** | ⚠️ | 非官方支持运行时，需实测 |
| **chromium-bidi** | ⚠️ | 同上 |

### 优缺点
- ✅ 减少 ~45MB 体积
- ✅ Bun 启动速度更快（冷启动比 Node 快 3-5x）
- ✅ Bridge 脚本无需任何修改
- ⚠️ **playwright-core 未被 Bun 官方支持**，可能在浏览器自动化场景出现问题
- ⚠️ 需要为每个目标平台维护对应的 Bun 二进制
- ⚠️ Bun 仍在快速迭代中，API 稳定性不如 Node

---

## 方案三：方案一 + 方案二组合（最优）

### 思路
优先使用系统 Node → 系统没有则用打包的 Bun sidecar 兜底。

### 效果

| 场景 | App 体积 | 运行时 |
|------|---------|--------|
| 有系统 Node | 101MB（含 Bun 兜底） | 系统 Node |
| 无系统 Node | 101MB | Bun sidecar |
| 移除 sidecar 分发 | 59MB | 仅系统 Node |

### 优缺点
- ✅ 最佳体积平衡
- ✅ 大多数用户用 Node（完全兼容），少数用 Bun（基本兼容）
- ⚠️ 需要维护两套运行时的兼容测试

---

## 推荐路径

```
短期（立即可做）→ 方案一：优先系统 Node，保留现有 sidecar 兜底
中期（验证后）  → 方案二：将 sidecar 从 Node 换为 Bun
长期（如需极致）→ 方案三：系统 Node 优先 + Bun sidecar 兜底
```

## 相关文件

- [build-bridge.mjs](file:///Users/fanhuaze/Documents/YunWork/tencentYun/desk-agent/scripts/build-bridge.mjs) - Bridge 打包脚本（external 包配置）
- [main.rs](file:///Users/fanhuaze/Documents/YunWork/tencentYun/desk-agent/src-tauri/src/main.rs) - `build_node_command` 函数（sidecar 启动逻辑）
- [tauri.conf.json](file:///Users/fanhuaze/Documents/YunWork/tencentYun/desk-agent/src-tauri/tauri.conf.json) - externalBin 配置
