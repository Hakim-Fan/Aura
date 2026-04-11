# 浏览器自动化 V1/V2 详细设计

## 1. 设计背景

当前项目中的浏览器能力依赖前台 Google Chrome：

- `chrome_open_url` 会激活系统 Chrome 并打开页面
- `chrome_get_active_tab` 依赖前台标签页
- `chrome_run_javascript` 依赖前台 Chrome 窗口上下文

这会直接带来两个问题：

1. Agent 会频繁打断用户当前桌面操作。
2. 浏览器状态直接绑定到用户正在使用的系统 Chrome，会话边界不清晰，也难以稳定复用。

本设计的目标是：

1. 用独立浏览器运行时替代当前“操作前台 Chrome”的默认方案。
2. 让常用网站可长期复用登录态。
3. 在遇到必须人工参与的阻塞时，支持用户可见接管。
4. 提供完整的浏览器设置页，统一管理搜索引擎、运行时、登录缓存导入和会话数据。

本项目尚未上线，因此本设计**不考虑兼容旧逻辑**。旧的前台 Chrome 自动化能力、旧配置项、旧路由策略都可以在实施时直接删除。
但以下能力例外：

- `enableChromeAutomation`

该能力不再作为默认网页执行路径，但应保留为“系统前台 Chrome 交互备用模式”，用于浏览器运行时不可用或用户明确要求直接操作系统 Chrome 的场景。

## 2. 版本范围

### V1 范围

1. 新增独立浏览器运行时，默认使用无头模式执行网页任务。
2. 持久化 Aura 专用浏览器 Profile。
3. 提供用户可见接管能力。
4. 新增独立的“浏览器”设置页。
5. 支持浏览器运行环境检测。
6. 支持 Aura 托管浏览器一键安装、一键卸载。
7. 支持用户手动指定独立 Chrome 可执行文件。
8. 支持搜索引擎与浏览器搜索相关设置。
9. 支持 Aura 专用浏览器 Profile 的清理和重置。
10. 保留系统前台 Chrome 自动化作为备用能力，但不再作为默认方案。

### V2 范围

1. 支持从用户本机 Google Chrome 导入指定站点的 Cookie / Session。
2. 支持导入来源 Profile 选择。
3. 支持导入站点管理、刷新、删除。
4. 所有导入数据只写入 Aura 专用 Profile，不修改来源 Chrome Profile。

### 不在本期范围

1. 多浏览器支持
2. Firefox / Safari / Edge 支持
3. 复用用户当前正在使用的真实 Chrome Profile
4. 导入密码、书签、扩展、历史记录、完整 HTTP 缓存
5. 完整 Chrome Profile 克隆
6. 与系统 Chrome 持续后台同步

## 3. 关键决策

### 3.1 默认浏览器执行方案

默认网页任务执行方案采用：

- `playwright-core`
- 独立浏览器运行时
- Aura 专用 Profile
- 无头执行为默认模式

这样做的原因：

1. 不打断用户
2. 不需要默认把完整浏览器二进制直接打进应用包
3. 适合当前 Node bridge 架构
4. 可以稳定提供导航、DOM、JS、截图、等待等网页自动化能力

### 3.1.1 系统前台 Chrome 自动化的定位

`enableChromeAutomation` 继续保留，但其定位调整为：

1. 备用能力
2. 救援模式
3. 用户显式要求时的系统 Chrome 交互能力

它不再承担默认网页执行职责。

适用场景：

1. 当前环境没有可用浏览器运行时，且用户暂不安装托管浏览器
2. 用户明确要求“直接在我的系统 Chrome 中操作”
3. 某些必须依赖系统前台 Chrome 状态的特殊场景

不适用场景：

1. 普通网页浏览与抓取
2. 普通搜索任务
3. 一般 DOM 读取或自动化流程

### 3.2 浏览器可执行文件来源

浏览器运行时来源支持三种模式：

1. `system-chrome`
   使用用户本机已安装的 Chrome

2. `managed-chrome`
   使用 Aura 下载、安装、托管、卸载的独立 Chrome 实例

3. `custom-executable`
   使用用户手动指定的独立 Chrome 可执行文件

推荐优先顺序：

1. 若系统 Chrome 可用，允许用户直接选用
2. 若用户希望与系统浏览器彻底隔离，优先选 `managed-chrome`
3. 若用户自行安装了独立 Chrome，可选 `custom-executable`

### 3.3 Profile 与浏览器可执行文件分离

必须明确区分两个概念：

1. 浏览器可执行文件
   是 Playwright 启动的浏览器程序

2. Aura 专用 Profile
   是 Aura 自己维护的 user data dir / 登录态容器

不管用户选择哪种浏览器来源：

- 系统 Chrome
- Aura 托管浏览器
- 自定义独立 Chrome

都统一搭配 Aura 专用 Profile 使用。

这样可以保证：

1. 登录态和用户真实系统浏览器隔离
2. 接管窗口与无头会话属于同一个 Aura 浏览器上下文
3. 登录复用逻辑可控

### 3.4 登录态复用策略

不直接复用用户正在使用的系统 Chrome Profile。

统一采用以下策略：

1. Aura 维护自己的持久化浏览器 Profile
2. 用户可在 Aura 浏览器里登录一次，后续持续复用
3. V2 允许从系统 Chrome 导入指定站点的 Cookie / Session 到 Aura Profile

### 3.5 “导入登录缓存”的技术边界

用户文案可以说“导入 Chrome 登录缓存”，但技术实现严格收敛为：

1. Cookie
2. Session Cookie
3. 必要时少量站点级登录态元数据

不包含：

1. 密码库
2. 书签
3. 扩展
4. 浏览历史
5. 完整 HTTP 缓存
6. 整个 Profile 克隆

### 3.6 用户接管策略

当自动化遇到“需要用户参与才能继续”的阻塞时，Aura 必须支持可见接管。

以下仅为典型示例，不构成穷尽列表：

1. 验证码
2. 2FA
3. 登录确认
4. 授权确认
5. 权限弹窗
6. 人机校验
7. 需要扫码或输入一次性验证码

触发接管不能只靠固定枚举，必须采用分层判定：

1. 显式规则
   页面内容或结构命中已知阻塞特征

2. 浏览器执行信号
   页面长期停滞、交互后无推进、出现 challenge iframe、出现验证码输入结构等

3. Agent 判断
   Agent 判断当前流程在无头模式下无法继续，必须由用户接管

## 4. 用户体验

### 4.1 正常流程

1. Agent 收到网页任务
2. Aura 使用无头浏览器执行
3. 不抢占用户桌面焦点
4. 结果返回聊天窗口

### 4.2 首次登录流程

1. Agent 打开目标站点
2. 发现站点要求登录
3. Aura 暂停自动化
4. 聊天窗口提示“需要你接管浏览器完成登录或验证”
5. Aura 打开可见浏览器窗口
6. 用户完成登录
7. 用户点击“继续执行”
8. Agent 在同一 Aura 会话上继续执行

### 4.3 导入登录态流程

1. 用户进入“设置 > 浏览器”
2. 选择本机 Chrome Profile
3. 选择一个或多个站点域名
4. Aura 将这些域名的 Cookie / Session 导入 Aura Profile
5. 后续 Aura 访问这些站点时复用登录态

### 4.4 浏览器设置页信息架构

新增一个顶级设置页签：

- `browser`

浏览器设置页包含以下模块：

1. 浏览器运行时
2. 浏览器安装与环境检测
3. 搜索偏好
4. 浏览器行为偏好
5. Aura 浏览器 Profile
6. 系统 Chrome 备用模式
7. Chrome 登录缓存导入
8. 已导入站点管理
9. 用户接管 / 可见浏览器
10. 安全与数据控制

## 5. 设置设计

### 5.1 页签设计

目标设置页签：

- `general`
- `providers`
- `browser`
- `mcp`
- `skills`
- `plugins`

### 5.2 新增设置字段

建议在 `AgentSettings` 中新增以下结构：

```ts
type BrowserSearchEngine =
  | 'google'
  | 'bing'
  | 'duckduckgo'
  | 'baidu'
  | 'custom'

type BrowserTakeoverMode = 'ask' | 'auto-visible-on-blocker'

type BrowserRuntimeSource =
  | 'system-chrome'
  | 'managed-chrome'
  | 'custom-executable'

type BrowserSearchPreferences = {
  engine: BrowserSearchEngine
  customTemplate?: string
  region?: string
  language?: string
  safeSearch?: 'off' | 'moderate' | 'strict'
}

type BrowserBehaviorPreferences = {
  acceptLanguage?: string
  timezone?: string
  locale?: string
  colorScheme?: 'light' | 'dark' | 'system'
  userAgentMode?: 'default' | 'desktop'
}

type BrowserRuntimeSettings = {
  enabled: boolean
  source: BrowserRuntimeSource
  executablePath?: string
  managedExecutablePath?: string
  headlessByDefault: boolean
  takeoverMode: BrowserTakeoverMode
  persistAuraProfile: boolean
  auraProfilePath?: string
  search: BrowserSearchPreferences
  behavior: BrowserBehaviorPreferences
}

type ChromeImportSource = {
  id: string
  profileName: string
  profilePath: string
  isDefault: boolean
}

type ImportedChromeSite = {
  id: string
  domain: string
  sourceProfileId: string
  importedAt: number
  lastRefreshedAt?: number
  cookieCount: number
  notes?: string
}

type BrowserRuntimeStatusRecord = {
  systemChromeDetected: boolean
  systemChromePath?: string
  managedChromeInstalled: boolean
  managedChromePath?: string
  managedChromeSizeBytes?: number
  customExecutablePath?: string
  customExecutableValid?: boolean
  lastCheckedAt: number
}
```

加入 `AgentSettings`：

```ts
browser: BrowserRuntimeSettings
chromeImportSources: ChromeImportSource[]
importedChromeSites: ImportedChromeSite[]
browserRuntimeStatus?: BrowserRuntimeStatusRecord
```

### 5.3 默认值

推荐默认值：

```ts
browser: {
  enabled: true,
  source: 'system-chrome',
  headlessByDefault: true,
  takeoverMode: 'ask',
  persistAuraProfile: true,
  search: {
    engine: 'google',
    region: 'auto',
    language: 'auto',
    safeSearch: 'moderate',
  },
  behavior: {
    acceptLanguage: 'auto',
    timezone: 'system',
    locale: 'system',
    colorScheme: 'system',
    userAgentMode: 'default',
  },
}
```

### 5.4 浏览器安装与环境检测模块

该模块属于 V1。

展示内容：

1. 系统 Chrome 检测状态
2. Aura 托管浏览器安装状态
3. 自定义可执行文件路径状态
4. 当前生效浏览器来源
5. 当前浏览器运行环境的估算磁盘占用

操作项：

1. 重新检测环境
2. 一键安装 Aura 托管浏览器
3. 卸载 Aura 托管浏览器
4. 选择自定义可执行文件
5. 切换当前浏览器来源

规则：

1. 目标来源不可用时，不允许保存
2. 选择 `managed-chrome` 时，如未安装则先引导安装
3. 选择 `custom-executable` 时，必须先通过路径校验

### 5.5 搜索偏好模块

支持：

1. 选择搜索引擎：Google / Bing / DuckDuckGo / 百度 / 自定义
2. 配置自定义搜索模板
3. 配置 `region`
4. 配置 `language`
5. 配置 `safeSearch`

自定义模板要求：

1. 必须包含 `{query}`
2. 必须是 `http` 或 `https`

### 5.6 浏览器行为偏好模块

这个模块用于管理“会影响搜索结果或网页表现的常用浏览器设置”。

支持：

1. `acceptLanguage`
2. `timezone`
3. `locale`
4. `colorScheme`
5. `userAgentMode`

用途：

1. 影响搜索结果地域和语言偏好
2. 减少“用户看到的搜索结果”和“Aura 抓取到的搜索结果”差异
3. 统一 Aura 浏览器的行为环境

### 5.7 Aura 浏览器 Profile 模块

展示内容：

1. Profile 存储路径
2. 是否启用持久化
3. 当前会话状态

操作项：

1. 打开 Profile 文件夹
2. 清空 Aura 浏览器 Profile
3. 重置全部站点会话

### 5.8 系统 Chrome 备用模式模块

该模块用于承载 `enableChromeAutomation`，但不再沿用现有“普通审批开关”的呈现方式。

它应被明确设计成“备用模式”而不是“默认浏览器能力”。

展示内容：

1. 是否允许系统前台 Chrome 自动化
2. 当前定位说明：仅用于备用或用户显式要求
3. 风险提示：会抢焦点、会打断用户、依赖前台 Chrome 状态

操作项：

1. 开启 / 关闭备用模式
2. 设置是否允许在浏览器运行时不可用时自动降级
3. 查看适用说明

推荐文案：

- “系统 Chrome 备用模式”
- “仅在无头浏览器不可用，或你明确要求操作系统 Chrome 时使用”
- “启用后，Agent 可能会切换到你的前台 Chrome 窗口并打断当前操作”

### 5.9 Chrome 登录缓存导入模块

该模块属于 V2。

展示内容：

1. 检测到的本机 Chrome Profile 列表
2. 当前选中的导入源 Profile
3. 域名选择 / 手动输入
4. 最近导入时间

操作项：

1. 导入
2. 重新导入
3. 删除导入记录

用户文案必须明确：

1. “仅导入所选站点的登录状态（Cookie / Session）”
2. “不会导入密码、书签、扩展和完整浏览历史”
3. “某些网站仍可能要求再次验证”

### 5.10 已导入站点管理模块

列表展示：

1. 域名
2. 来源 Profile
3. `importedAt`
4. `lastRefreshedAt`
5. `cookieCount`

操作项：

1. 刷新导入
2. 删除导入记录
3. 从 Aura Profile 中清除该站点登录态

### 5.11 用户接管模块

控制项：

1. 遇到阻塞时先询问
2. 遇到阻塞时自动打开可见浏览器
3. 若已有接管窗口，是否复用

状态展示：

1. 浏览器空闲
2. 正在无头执行
3. 等待用户接管
4. 可见窗口处理中

## 6. 架构设计

### 6.1 总体架构

前端：

1. `SettingsWindowApp` 中新增浏览器设置页
2. 聊天窗口中新增接管提示和状态展示

Tauri：

1. 提供本地文件系统访问
2. 发现 macOS 上的本机 Chrome Profile
3. 管理托管浏览器安装目录
4. 在“重置 Aura 数据”时清理浏览器相关目录

Node bridge：

1. 基于 Playwright 的浏览器工具执行器
2. 浏览器会话管理器
3. 浏览器来源解析器
4. 托管浏览器安装器
5. Cookie / Session 导入器
6. 无头 / 可见模式切换编排

### 6.2 运行时组件

#### Browser Session Manager

职责：

1. 解析当前浏览器来源
2. 启动无头或可见浏览器
3. 管理 Aura Profile
4. 创建 / 关闭 context 和 page
5. 持久化浏览器会话状态
6. 跟踪阻塞与接管状态

#### Browser Runtime Resolver

职责：

1. 检测系统 Chrome
2. 检测 Aura 托管浏览器
3. 校验自定义可执行文件
4. 解析当前最终使用的 executable path

#### Managed Browser Installer

职责：

1. 下载 Aura 托管浏览器
2. 安装到 Aura 管理目录
3. 返回安装后的可执行文件路径
4. 卸载 Aura 托管浏览器
5. 上报安装状态与磁盘占用

#### Chrome Import Manager

职责：

1. 发现本机 Chrome Profile
2. 读取指定域名的 Cookie / Session
3. 将这些数据导入 Aura Profile
4. 记录导入元数据

#### Browser Capability Router

职责：

1. 浏览器相关任务统一路由到 `browser_*`
2. 当浏览器运行时不可用且用户允许降级时，才回退到系统前台 Chrome 自动化
3. 当用户明确要求操作系统 Chrome 时，允许直接走前台 Chrome 自动化

## 7. 工具设计

### 7.1 新增工具

新增 built-in tools：

1. `browser_open`
2. `browser_search`
3. `browser_get_page`
4. `browser_run_javascript`
5. `browser_click`
6. `browser_type`
7. `browser_wait_for`
8. `browser_screenshot`
9. `browser_takeover_visible`
10. `browser_resume_after_takeover`

同时保留现有系统前台 Chrome 工具，作为备用能力：

1. `chrome_open_url`
2. `chrome_get_active_tab`
3. `chrome_run_javascript`

### 7.2 工具语义

#### `browser_open`

在 Aura 浏览器会话中打开指定 URL。

#### `browser_search`

使用当前设置的搜索引擎执行搜索，并打开搜索结果页。

#### `browser_get_page`

返回当前页面标题、URL 和清洗后的文本内容。

#### `browser_run_javascript`

在当前页面执行 JavaScript。

#### `browser_click`

执行点击。

#### `browser_type`

输入文本。

#### `browser_wait_for`

等待页面状态、元素或导航完成。

#### `browser_screenshot`

保存截图到工作区。

#### `browser_takeover_visible`

打开当前 Aura 浏览器会话的可见窗口，供用户接管。

#### `browser_resume_after_takeover`

用户接管完成后恢复自动执行。

## 8. 数据模型与目录

### 8.1 持久化记录

推荐结构：

```ts
type BrowserSessionRecord = {
  id: string
  status: 'idle' | 'running' | 'waiting_for_user' | 'visible_active' | 'failed'
  mode: 'headless' | 'visible'
  startedAt: number
  updatedAt: number
  currentUrl?: string
  currentTitle?: string
  blockerReason?: string
}

type BrowserImportRecord = {
  id: string
  domain: string
  sourceProfilePath: string
  importedAt: number
  lastRefreshedAt?: number
  cookieCount: number
}
```

这些数据应走独立的 settings / SQLite 持久化链路，不进入 chat message version。

### 8.2 Aura 浏览器目录结构

建议位于：

```text
~/.aura/browser/
  runtimes/
    chrome/
  profile/
  sessions/
  screenshots/
  imports/
    imported-sites.json
```

说明：

1. `runtimes/chrome/`：Aura 托管浏览器安装目录
2. `profile/`：Aura 专用浏览器 Profile
3. `sessions/`：运行时会话状态
4. `screenshots/`：浏览器截图输出
5. `imports/`：导入元数据

### 8.3 托管浏览器的安装与清理策略

Aura 托管浏览器必须安装在 Aura 可管理目录中，不得散落到用户其他目录。

要求：

1. 安装目录固定在 `~/.aura/browser/runtimes/chrome/`
2. 卸载托管浏览器时完整删除该目录
3. “重置 Aura 数据”时，同时删除托管浏览器和 Aura Profile

关于“整个 app 卸载后一定自动清理”的边界：

1. 如果用户只是删除 app 本体，app 自己已经无法继续执行，因此不能从应用内部绝对保证把外部运行时一并删除
2. 当前阶段能做到的可实现承诺是：
   - 托管浏览器可单独卸载
   - 重置 Aura 数据时会一并清理
3. 如果未来需要“卸载 app 时一起清理”，必须依赖平台级安装器 / 卸载器能力

因此产品文案必须写成：

1. “Aura 托管浏览器可单独卸载”
2. “重置 Aura 数据时会一并清理”

而不能承诺：

1. “删除 app 本体后一定自动卸载托管浏览器”

## 9. Chrome 登录缓存导入设计

### 9.1 支持来源

仅支持本机 Google Chrome Profile 作为导入来源。

当前阶段优先支持 macOS：

```text
~/Library/Application Support/Google/Chrome
```

支持：

1. `Default`
2. `Profile 1`
3. `Profile 2`
4. 其他命名 Profile

不支持：

1. Chromium 变种
2. Edge
3. Firefox
4. Safari

### 9.2 导入粒度

V2 导入是**站点级**的。

示例域名：

1. `github.com`
2. `notion.so`
3. `chat.openai.com`

Aura 只导入这些站点的 Cookie / Session 到 Aura Profile。

### 9.3 导入流程

1. 发现本机 Chrome Profile
2. 用户选择来源 Profile
3. 用户输入或选择域名
4. 读取来源 Profile 中这些域名的 Cookie / Session
5. 写入 Aura Profile
6. 记录导入元数据

### 9.4 重要约束

1. 导入过程绝不能修改来源 Chrome Profile
2. 导入 Cookie / Session 不保证所有网站都一定维持登录
3. 某些站点还会依赖 local storage、设备指纹或风控策略

因此该功能是“提升成功率的便利能力”，不是“100% 保证登录可用”的承诺。

## 10. 可见接管设计

### 10.1 接管触发条件

以下任一条件成立时触发接管：

1. 页面内容或结构命中已知阻塞特征，例如登录、验证码、2FA、授权确认等
2. 浏览器执行过程中出现明显人工参与信号，例如长时间停滞、交互后未推进、出现一次性验证码输入、challenge iframe 等
3. 自动化失败并标记为“需要人工参与”
4. Agent 判断当前流程在无头模式下无法继续，必须由用户接管

### 10.2 接管流程

1. 浏览器工具报告阻塞
2. 聊天 UI 显示结构化提示
3. 用户点击“打开浏览器接管”
4. Aura 打开同一会话的可见浏览器窗口
5. 用户完成登录 / 验证 / 授权
6. 用户点击“继续执行”
7. Browser Session Manager 在同一 Aura 会话上恢复自动执行

### 10.3 为什么接管必须使用 Aura Profile

原因：

1. 需要保留当前无头会话上下文
2. 需要让用户继续操作同一个 Aura 浏览器会话
3. 不能跳回用户真实系统 Chrome，否则边界会再次混乱

## 11. 实施计划

### Phase 1：设置与状态结构

1. 新增 `browser` 设置页签
2. 扩展 `AgentSettings`
3. 增加浏览器运行时状态结构
4. 增加浏览器默认配置

### Phase 2：环境检测与来源选择

1. 实现系统 Chrome 检测
2. 实现自定义可执行文件校验
3. 完成设置页中的环境检测 UI
4. 完成来源切换逻辑
5. 完成系统 Chrome 备用模式配置 UI

### Phase 3：浏览器运行时

1. 在 bridge 中新增基于 Playwright 的浏览器会话管理器
2. 实现 `browser_open`
3. 实现 `browser_search`
4. 实现 `browser_get_page`
5. 实现 `browser_run_javascript`
6. 实现 `browser_screenshot`
7. 持久化 Aura 浏览器 Profile

### Phase 4：托管浏览器安装

1. 实现 Aura 托管浏览器下载与安装
2. 安装完成后自动写入 settings
3. 实现托管浏览器卸载
4. 展示磁盘占用与安装路径

### Phase 5：可见接管

1. 实现阻塞检测标记
2. 实现 `browser_takeover_visible`
3. 实现 `browser_resume_after_takeover`
4. 实现聊天侧等待状态与接管操作

### Phase 6：V2 导入能力

1. 发现本机 Chrome Profile
2. 增加导入设置 UI
3. 实现站点级 Cookie / Session 导入
4. 增加导入站点管理能力

## 12. 风险与缓解

### 12.1 技术风险

1. 某些网站登录态不只依赖 Cookie
2. 某些网站即使导入会话也会继续触发风控
3. Playwright 驱动不同 Chrome 版本时可能存在差异
4. 导入逻辑对平台和 Profile 格式敏感
5. 托管浏览器安装会带来额外磁盘占用

### 12.2 产品风险

1. 用户可能误以为“导入缓存”就是“完整导入浏览器状态”
2. 用户可能误以为导入登录态后所有网站都一定可用
3. 聊天状态和浏览器状态不同步会导致接管体验混乱
4. 用户可能误以为删除 app 本体后托管浏览器一定自动清理

### 12.3 缓解方式

1. UI 中始终明确写成“Cookie / Session 导入”
2. 已导入站点必须可见、可刷新、可移除
3. 聊天时间线中明确显示接管状态
4. Aura Profile 与用户真实 Chrome Profile 必须严格隔离
5. 设置页中明确显示托管浏览器安装位置、体积与卸载入口
6. 明确区分“删除 app 本体”和“清理 Aura 数据”

## 13. 验收标准

### V1 验收标准

1. 浏览器类任务默认不再抢占用户焦点
2. Aura 可以在应用重启后保留自己的专用浏览器 Profile
3. 用户可以通过 Aura 可见接管在某站点登录一次，并在后续任务中继续复用
4. 设置页存在独立的 Browser 页面，并能持久化保存
5. 搜索引擎设置会真实影响浏览器搜索行为
6. 设置页能检测系统 Chrome 是否可用
7. 当系统 Chrome 不可用时，用户可以一键安装 Aura 托管浏览器并完成配置
8. 用户可以切换到手动指定的独立 Chrome 可执行文件
9. 用户可以卸载 Aura 托管浏览器
10. 用户可以显式开启或关闭系统 Chrome 备用模式
11. 当浏览器运行时不可用时，系统 Chrome 备用模式可作为降级方案使用

### V2 验收标准

1. Aura 能发现本机 Chrome Profile
2. 用户能把指定域名的登录态导入 Aura Profile
3. 已导入站点能在设置页中查看并独立移除
4. 导入流程不会修改用户来源 Chrome Profile

## 14. 当前定稿结论

当前方案确定为：

1. 移除旧的前台 Chrome 自动化“默认路径”定位
2. 默认浏览器能力改为 Aura 独立浏览器运行时
3. 浏览器来源支持系统 Chrome、Aura 托管浏览器、自定义独立可执行文件
4. 统一使用 Aura 自己的持久化 Profile
5. 保留系统前台 Chrome 自动化作为备用模式
6. 遇到阻塞时使用可见接管
7. V2 只做站点级 Chrome Cookie / Session 导入

当前明确不做：

1. 让系统前台 Chrome 自动化继续承担默认网页执行路径
2. 复用用户真实系统 Chrome Profile
3. 导入密码 / 书签 / 历史 / 扩展 / 完整缓存
4. 扩展到更多浏览器兼容
