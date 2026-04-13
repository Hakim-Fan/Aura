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

## 方案三：方案一 + 方案二组合

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

## 方案四：按需下载 Node 到 App 私有目录（⭐ 最优推荐）

### 思路
App 不打包任何 Node/Bun sidecar。首次启动时检测系统 Node，如果没有则自动下载 Node 到 App 私有目录，不污染用户系统环境。

### 架构流程

```
App 分发包：~59MB（不含 Node）
        ↓
   首次启动
        ↓
  检测系统 Node ──── 找到 → 直接使用（零下载）
        │
      找不到
        ↓
  弹窗："需要下载 Node.js 运行时 (~25MB)"
        ↓
   用户确认 → 后台下载 tar.gz (~25MB)
        ↓
  解压 node 二进制到 App 私有目录
   ~/Library/Application Support/com.hyfun.aura/runtime/node
        ↓
     启动完成，后续启动无感
```

### 效果

| 指标 | 当前 | 优化后 |
|------|------|--------|
| **App 分发体积** | 146MB | **~59MB** (-60%) |
| 首次启动额外下载 | 0 | ~25MB（仅无 Node 用户） |
| 功能完整性 | 100% | 100% |
| 用户系统影响 | 打包 87MB 二进制 | 零影响（App 私有目录） |

### 改动范围

#### Rust 后端 (`src-tauri/src/main.rs`)

**1. 新增 Tauri Command：`check_node_runtime`**
```rust
/// 检测可用的 Node 运行时。返回三种状态之一：
/// - "system": 系统 Node 可用
/// - "private": App 私有目录已有 Node
/// - "missing": 需要下载
#[tauri::command]
fn check_node_runtime(app: tauri::AppHandle) -> String {
    // 1. 检测系统 Node（which node / where node）
    // 2. 检测 App 私有目录 node
    // 3. 都没有则返回 "missing"
}
```

**2. 新增 Tauri Command：`download_node_runtime`**
```rust
/// 下载 Node.js 到 App 私有目录。
/// 前端通过 Tauri event 接收下载进度。
#[tauri::command]
async fn download_node_runtime(app: tauri::AppHandle) -> Result<String, String> {
    // 1. 确定目标路径: app_data_dir/runtime/node
    // 2. 确定下载 URL（根据 platform + arch）
    // 3. 下载 .tar.gz 到临时目录（通过 event 推送进度）
    // 4. 解压，只提取 bin/node
    // 5. 设置执行权限 chmod +x
    // 6. 返回 node 路径
}
```

**3. 修改 `build_node_command`**
```rust
fn build_node_command<R: Runtime>(...) -> Result<Command, String> {
    // 查找优先级：
    // 1. 系统 Node（PATH 中的 node）
    // 2. App 私有目录 Node（~/Library/Application Support/.../runtime/node）
    // 3. Sidecar Node（如果仍然打包了的话，作为最终兜底）
    // 4. 都没有 → 返回错误
}
```

**4. 修改 `tauri.conf.json`**
```json
{
  "bundle": {
    // 移除 externalBin，不再打包 Node sidecar
    // "externalBin": ["binaries/node"],  ← 删除
  }
}
```

#### 前端

**5. 新建 `RuntimeSetup.tsx` 组件**
```
┌─────────────────────────────────────────┐
│                                         │
│   🔍 正在检测运行环境...                  │
│                                         │
│   ┌───────────────────────────────────┐ │
│   │  ████████████████░░░░  75%        │ │
│   └───────────────────────────────────┘ │
│                                         │
│   正在下载 Node.js 运行时 (18/25 MB)     │
│                                         │
└─────────────────────────────────────────┘
```

- 在 App 主入口处，先调用 `check_node_runtime`
- 如果返回 `"missing"`，显示下载引导 UI
- 监听 Tauri event 显示下载进度
- 完成后自动进入主界面

### 下载源

| 平台 | 架构 | URL | 压缩包大小 |
|------|------|-----|-----------|
| macOS | x64 | `https://nodejs.org/dist/v20.19.0/node-v20.19.0-darwin-x64.tar.gz` | ~25MB |
| macOS | arm64 | `https://nodejs.org/dist/v20.19.0/node-v20.19.0-darwin-arm64.tar.gz` | ~25MB |
| Windows | x64 | `https://nodejs.org/dist/v20.19.0/node-v20.19.0-win-x64.zip` | ~30MB |
| Linux | x64 | `https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-x64.tar.gz` | ~25MB |

### 关键实现细节

1. **版本锁定**：在 Rust 代码中硬编码 Node 版本号（如 `v20.19.0`），确保与 esbuild target 和 Bridge 脚本兼容
2. **校验完整性**：下载后校验 SHA256，避免损坏或篡改
3. **断点续传**：如果下载中断，下次启动时自动续传或重新下载
4. **权限设置**：解压后对 node 二进制执行 `chmod +x`（macOS/Linux）
5. **版本升级**：后续 App 更新时可以比较版本号，按需下载新版 Node
6. **卸载清理**：Node 安装在 `~/Library/Application Support/com.hyfun.aura/runtime/` 下，用户删除 App 时可一并清除

### 优缺点
- ✅ **App 分发体积最小**（59MB，减少 60%）
- ✅ **零系统污染**（安装在 App 私有目录）
- ✅ **100% 功能兼容**（使用官方 Node.js）
- ✅ 有系统 Node 的用户完全无感（不触发下载）
- ✅ 支持后续自动升级 Node 版本
- ⚠️ 改动量中等（约 150-200 行 Rust + 1 个前端组件）
- ⚠️ 首次启动需要网络下载（无 Node 用户）
- ⚠️ 需要处理下载失败的边界情况（网络不可用、磁盘空间不足等）

---

## 推荐路径

```
┌─────────────────────────────────────────────────────────────┐
│  短期（立即可做）                                             │
│  → 方案一：优先系统 Node，保留现有 sidecar 兜底               │
│    改动量：~20 行 Rust                                       │
│    效果：有 Node 的用户体验不变，体积不变                      │
├─────────────────────────────────────────────────────────────┤
│  中期（推荐重点投入）                                         │
│  → 方案四：按需下载 Node 到 App 私有目录                      │
│    改动量：~200 行 Rust + 1 前端组件                          │
│    效果：App 59MB，首次无 Node 时自动下载 25MB                 │
├─────────────────────────────────────────────────────────────┤
│  可选                                                        │
│  → 方案二：Bun 替换（如 Node 下载方案不可行时的备选）          │
│    风险：playwright 兼容性                                    │
└─────────────────────────────────────────────────────────────┘
```

## 相关文件

- [build-bridge.mjs](file:///Users/fanhuaze/Documents/YunWork/tencentYun/desk-agent/scripts/build-bridge.mjs) - Bridge 打包脚本（external 包配置）
- [main.rs](file:///Users/fanhuaze/Documents/YunWork/tencentYun/desk-agent/src-tauri/src/main.rs) - `build_node_command` 函数（sidecar 启动逻辑）
- [tauri.conf.json](file:///Users/fanhuaze/Documents/YunWork/tencentYun/desk-agent/src-tauri/tauri.conf.json) - externalBin 配置
- [HomeView.tsx](file:///Users/fanhuaze/Documents/YunWork/tencentYun/desk-agent/src/views/HomeView.tsx) - 主界面入口（RuntimeSetup 组件挂载点）
