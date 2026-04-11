# 浏览器自动化 V1/V2 实施任务清单

本文档是 [浏览器自动化详细设计](/Users/fanhuaze/Documents/YunWork/desk-agent/docs/browser-automation-design.md) 的实施拆解版。

目标：

1. 按可连续施工的顺序拆解 V1/V2
2. 每项任务尽量对应明确代码落点
3. 作为后续逐步实现与验收的主清单

## 0. 总体执行顺序

执行顺序固定为：

1. 设置与数据结构
2. 浏览器环境检测
3. 浏览器运行时
4. 托管浏览器安装/卸载
5. 可见接管
6. Chrome 登录缓存导入
7. 验证、收尾、清理旧逻辑

原则：

1. 不做旧逻辑兼容适配
2. 旧的前台 Chrome 自动化只保留为备用模式，不再承担默认路径
3. 每完成一个阶段，都需要同步更新验证项

## 1. Phase 1：设置与状态结构

### 1.1 设置页签与基础类型

任务：

1. 在 [src/views/SettingsView.tsx](/Users/fanhuaze/Documents/YunWork/desk-agent/src/views/SettingsView.tsx) 中新增 `browser` 页签
2. 在 [src/lib/windows.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/lib/windows.ts) 中允许 `?tab=browser`
3. 在 [src/types.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/types.ts) 中新增浏览器相关类型：
   - `BrowserRuntimeSource`
   - `BrowserSearchEngine`
   - `BrowserTakeoverMode`
   - `BrowserSearchPreferences`
   - `BrowserBehaviorPreferences`
   - `BrowserRuntimeSettings`
   - `ChromeImportSource`
   - `ImportedChromeSite`
   - `BrowserRuntimeStatusRecord`
4. 扩展 `AgentSettings` 结构

完成标准：

1. 类型定义完整可编译
2. 设置窗口可切到 `browser` 页

### 1.2 默认设置与存储归一化

任务：

1. 在 [src/lib/storage.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/lib/storage.ts) 中补充浏览器默认配置
2. 增加浏览器配置的 normalize / parse / serialize 逻辑
3. 确保持久化 settings 时包含：
   - `browser`
   - `chromeImportSources`
   - `importedChromeSites`
   - `browserRuntimeStatus`
4. 为缺失字段提供安全默认值

完成标准：

1. 老 settings 结构可被新逻辑安全读取
2. 新设置可持久化并恢复

### 1.3 浏览器设置页 UI 外壳

任务：

1. 在 [src/SettingsWindowApp.tsx](/Users/fanhuaze/Documents/YunWork/desk-agent/src/SettingsWindowApp.tsx) 中新增 `renderBrowser()`
2. 浏览器页先搭建以下模块空壳：
   - 浏览器运行时
   - 浏览器安装与环境检测
   - 搜索偏好
   - 浏览器行为偏好
   - Aura 浏览器 Profile
   - 系统 Chrome 备用模式
   - Chrome 登录缓存导入
   - 已导入站点管理
   - 用户接管 / 可见浏览器
3. 完成保存/加载接线

完成标准：

1. 浏览器页签可正常打开
2. 所有模块有基本布局与状态绑定

## 2. Phase 2：浏览器环境检测

### 2.1 Tauri / bridge 能力打底

任务：

1. 设计浏览器环境检测调用接口
2. 在 Tauri 与 bridge 间增加浏览器检测调用链
3. 定义检测结果结构

推荐检测结果：

1. 系统 Chrome 是否存在
2. 系统 Chrome 路径
3. Aura 托管浏览器是否存在
4. 托管浏览器路径
5. 自定义路径是否有效
6. 检测时间

### 2.2 系统 Chrome 检测

任务：

1. 优先实现 macOS 下系统 Chrome 可执行文件探测
2. 为后续托管浏览器和自定义路径复用同一套状态结构
3. 在设置页中展示“已检测到 / 未检测到”

完成标准：

1. 设置页点击“重新检测环境”能得到明确结果

### 2.3 自定义可执行文件选择与校验

任务：

1. 在浏览器设置页增加“选择自定义浏览器”
2. 选择后执行路径有效性校验
3. 将结果写入 `browserRuntimeStatus`
4. 支持切换当前来源到 `custom-executable`

完成标准：

1. 无效路径不能被保存为当前来源
2. 有效路径可被保存并恢复

### 2.4 运行时来源切换

任务：

1. 支持在设置页选择：
   - `system-chrome`
   - `managed-chrome`
   - `custom-executable`
2. 增加来源不可用时的禁用态与引导说明
3. 如果目标来源不可用，禁止保存

完成标准：

1. 来源切换逻辑清晰
2. 设置页不会进入无效配置状态

## 3. Phase 3：浏览器运行时

### 3.1 Browser Runtime Resolver

任务：

1. 在 bridge 侧新增浏览器来源解析器
2. 根据 settings 决定最终 executable path
3. 支持三种来源：
   - 系统 Chrome
   - Aura 托管浏览器
   - 用户指定可执行文件

完成标准：

1. 浏览器启动前能稳定解析最终路径

### 3.2 Browser Session Manager

任务：

1. 新增浏览器会话管理器
2. 统一管理：
   - browser 启动
   - page / context
   - Aura Profile
   - headless / visible 模式
   - 当前 URL / title / blocker 状态
3. 设计会话生命周期

完成标准：

1. 能在 Aura Profile 下创建并复用浏览器会话

### 3.3 基础 `browser_*` 工具

任务：

1. 实现 `browser_open`
2. 实现 `browser_search`
3. 实现 `browser_get_page`
4. 实现 `browser_run_javascript`
5. 实现 `browser_screenshot`
6. 视实现成本决定是否同时补：
   - `browser_click`
   - `browser_type`
   - `browser_wait_for`

落点：

1. [bridge/advancedTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/advancedTools.mjs) 或新增独立浏览器 bridge 模块
2. capability selector
3. agent system prompt capability exposure

完成标准：

1. 浏览器任务默认走 `browser_*`
2. 不再默认走前台 Chrome

### 3.4 搜索引擎与行为偏好接入

任务：

1. 将设置页中的搜索引擎配置接入 `browser_search`
2. 将语言/地区/时区等偏好接入浏览器上下文创建

完成标准：

1. 搜索结果与设置偏好一致
2. 浏览器上下文使用 Aura 自定义行为参数

## 4. Phase 4：托管浏览器安装 / 卸载

### 4.1 托管浏览器安装器

任务：

1. 设计托管浏览器安装目录：
   - `~/.aura/browser/runtimes/chrome/`
2. 实现下载与安装流程
3. 安装后自动写入 settings
4. 记录安装大小与路径

完成标准：

1. 用户可以一键安装 Aura 托管浏览器
2. 安装后可直接切换为当前运行时来源

### 4.2 托管浏览器卸载

任务：

1. 在设置页中增加卸载入口
2. 实现完整删除托管浏览器目录
3. 当当前来源为 `managed-chrome` 且卸载后，设置必须回退到安全状态

完成标准：

1. 托管浏览器可以单独卸载
2. 卸载后状态展示正确

### 4.3 Aura 数据重置时清理浏览器目录

任务：

1. 将 Aura 托管浏览器目录纳入“重置 Aura 数据”清理范围
2. 将 Aura 浏览器 Profile 一并纳入清理
3. 更新文案，明确“删除 app 本体”与“重置 Aura 数据”的区别

完成标准：

1. 重置流程会清理浏览器运行时与 Profile

## 5. Phase 5：系统 Chrome 备用模式

### 5.1 `enableChromeAutomation` 重定位

任务：

1. 保留 `enableChromeAutomation`
2. 将其从“默认浏览器能力”重定位为“系统 Chrome 备用模式”
3. 从通用审批区移出，在浏览器设置页中单独展示

完成标准：

1. 用户能明确理解这是备用模式而不是默认方案

### 5.2 备用模式配置 UI

任务：

1. 增加启用/关闭开关
2. 增加说明文案
3. 可选增加“运行时不可用时允许自动降级”设置

完成标准：

1. 备用模式在设置页中语义清晰

### 5.3 路由降级逻辑

任务：

1. 只有当浏览器运行时不可用，且用户允许降级时，才回退到系统前台 Chrome 自动化
2. 当用户明确要求“在系统 Chrome 中操作”时，也允许直接使用前台 Chrome 自动化

完成标准：

1. 前台 Chrome 自动化不再承担默认网页执行路径

## 6. Phase 6：可见接管

### 6.1 阻塞检测

任务：

1. 设计阻塞检测结果结构
2. 支持以下三类信号：
   - 显式规则
   - 浏览器执行信号
   - Agent 判断结果
3. 为会话状态增加 blocker 信息

完成标准：

1. 接管触发不依赖写死的少量文案枚举

### 6.2 接管工具

任务：

1. 实现 `browser_takeover_visible`
2. 实现 `browser_resume_after_takeover`
3. 让可见接管始终基于 Aura Profile，而不是系统 Chrome Profile

完成标准：

1. 用户可以从无头会话切换到可见接管并恢复

### 6.3 聊天侧状态与交互

任务：

1. 在主窗口中展示“等待接管”状态
2. 提供“打开浏览器接管”和“继续执行”操作
3. 明确展示 blocker reason

完成标准：

1. 用户能清楚知道为什么要接管，以及接管后如何恢复

## 7. Phase 7：Chrome 登录缓存导入

### 7.1 本机 Chrome Profile 发现

任务：

1. 发现 macOS Chrome 配置目录
2. 枚举 `Default` 和命名 Profile
3. 形成 `ChromeImportSource[]`

完成标准：

1. 设置页中能列出可选来源 Profile

### 7.2 站点级导入

任务：

1. 读取来源 Profile 中指定域名的 Cookie / Session
2. 导入 Aura Profile
3. 记录导入元数据

完成标准：

1. 能按域名导入登录态
2. 不修改来源 Chrome Profile

### 7.3 已导入站点管理

任务：

1. 列出所有已导入站点
2. 支持刷新导入
3. 支持删除导入记录
4. 支持从 Aura Profile 清理对应站点登录态

完成标准：

1. 导入后的站点是可管理、可回收的

## 8. Phase 8：清理旧逻辑与统一路由

### 8.1 清理旧默认路径

任务：

1. 移除旧的“浏览器任务默认路由到前台 Chrome 自动化”的逻辑
2. 移除与默认前台 Chrome 路径强绑定的提示文案

完成标准：

1. 默认网页任务只走 Aura 浏览器运行时

### 8.2 清理冗余配置与 UI

任务：

1. 删除不再适用的旧默认浏览器表述
2. 调整原有审批策略区域，避免误导用户
3. 保留 `enableChromeAutomation`，但仅在浏览器页中管理

完成标准：

1. 设置语义一致
2. 不再存在重复或误导性的开关

## 9. Phase 9：验证与验收

### 9.1 工程验证

任务：

1. TypeScript 类型检查
2. Rust / Tauri 编译检查
3. 基础浏览器运行 smoke test

### 9.2 功能验证

需要手动验证：

1. 浏览器页签可正常保存设置
2. 系统 Chrome 可检测
3. 托管浏览器可安装/卸载
4. 自定义路径可用
5. 默认网页任务走 Aura 浏览器
6. 接管流程可恢复
7. Chrome 登录缓存可按站点导入
8. 导入站点可刷新/删除

### 9.3 文档与收尾

任务：

1. 回填实现状态到设计文档
2. 标记已完成任务
3. 清理阶段性临时代码与说明

## 10. 建议实施节奏

为了尽量“一步到位”完成 V1/V2，建议按以下节奏连续施工：

1. 先完成 Phase 1-2
2. 紧接着完成 Phase 3
3. 然后完成 Phase 4-5
4. 再完成 Phase 6-7
5. 最后完成 Phase 8-9

从代码风险看，推荐当前立即开始的第一个实现批次是：

1. `browser` 设置页签与类型扩展
2. settings / storage 持久化
3. 环境检测状态结构
4. 浏览器页 UI 外壳

