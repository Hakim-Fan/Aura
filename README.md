# Aura

Aura 是一个桌面优先、工作区感知、本地优先的通用 Agent 应用。

它不是把一个聊天框套进桌面壳里，而是把真正能做事的 Agent 运行时、Provider 配置、MCP、技能、插件、浏览器自动化、桌面操作和本地持久化完整地做进了一款桌面软件。

如果你想要的是：

- 能配置自己的 `OpenAI / Google / Custom API`
- 能自动调用 `MCP / Skills / Plugins`
- 能在本地项目里读写文件、运行命令、分析仓库
- 能做浏览器自动化、桌面操作、多 Agent 委派
- 能把所有数据留在本机，而不是依赖云端产品逻辑

那 Aura 就是为这个方向设计的。

## 为什么 Aura 值得用

### 1. 真正的桌面 Agent，不是终端壳

Aura 用 `Tauri + React` 做桌面应用，用 `Rust + Node` 承载运行时，目标从一开始就不是 CLI，而是一个可以长期日用的桌面 Agent 工作台。

### 2. 本地优先，能力完整

Aura 当前已经具备这些核心能力：

- 多 Provider Profile
  支持 `OpenAI`、`Google Gemini` 和 `OpenAI-compatible Custom Provider`
- 模型连通性检测与模型抓取
  可直接验证 `API Key / Base URL / Model`
- 工作区感知会话
  每个会话都有自己的工作目录与会话产物目录
- 本地代码与文件工具
  读写文件、代码搜索、目录树读取、Shell 执行
- MCP Server 接入
  支持 `stdio MCP`
- Skills / Plugins 机制
  可组合本地能力，不把工具都硬编码进主程序
- 多 Agent 委派
  支持主 Agent 拆任务给子 Agent
- 浏览器自动化
  支持 Aura 专属浏览器运行时、托管浏览器、系统 Chrome 备用模式、站点登录态导入
- 桌面自动化
  支持 macOS 下的应用切换、输入、快捷键、截图等 Computer Use 能力
- 权限审批与执行轨迹
  高风险动作支持审批与事件记录
- 本地持久化
  设置、会话、消息版本、能力覆盖规则都保存在本地

### 3. 比很多“套壳 AI 工具”更强的地方

Aura 的优势不是“界面换皮”，而是运行时架构更完整：

- 不绑定单一模型厂商
- 不绑定单一工具协议
- 不依赖云端托管 Agent 才能工作
- 不把本地项目能力外包给远程沙箱
- MCP、技能、插件、浏览器、桌面能力都在同一运行时里协同
- 可以围绕真实工作区做持续任务，而不是只做一次性回答

### 4. 比很多同类工具更适合工程场景

Aura 特别适合这些场景：

- 本地代码仓库分析与修改
- 复杂项目排障与修复
- MCP 驱动的数据/系统操作
- 需要浏览器登录态与自动化的网站任务
- 需要本地桌面协作的半自动流程
- 需要自主可控 Provider 与 API 成本的团队或个人

## 核心能力一览

### Agent Runtime

- 多轮对话
- 后台任务执行
- 多 Agent 委派
- 追加输入继续运行
- 中断 / 取消 / 审批
- Provider 故障恢复与重试

### 工作区能力

- 工作目录绑定
- 会话级产物目录
- 文件树与文本预览
- 文件导入与附件写入
- 本地路径打开
- 工作区删除与清理

### 扩展能力

- `MCP`
- `Skills`
- `Plugins`
- 项目级能力开关覆盖
- 全局启停与工作区级覆盖并存

### 浏览器能力

- Aura 浏览器运行时
- `system-chrome / managed-chrome / custom-executable`
- 搜索偏好与浏览器行为偏好
- Chrome 登录态按站点导入
- 可见接管与恢复
- 浏览器 Profile 管理

### 桌面能力

- Computer Use
- Chrome Automation 备用模式
- macOS 原生桌面操作桥接

## 技术亮点

Aura 不是单层应用，而是分成了 5 层：

1. `React UI`
   负责桌面工作台、设置窗口、会话页、资产管理页
2. `前端应用编排层`
   负责状态、持久化同步、窗口管理、会话生命周期
3. `Rust / Tauri 原生层`
   负责窗口、SQLite、本地文件、OS 能力、任务桥接
4. `Node Agent Runtime`
   负责模型调用、工具编排、MCP、技能、插件、多 Agent
5. `本地能力与数据层`
   负责工作区、Aura Home、浏览器 Profile、配置与会话存储

## 当前平台支持

Aura 的桌面基础框架是跨平台的，但当前最佳支持平台是 `macOS`。

现阶段能力分布大致如下：

- 跨平台通用：
  Provider、MCP、会话、设置、文件树、消息持久化、基础本地工具、Shell/命令执行、Aura skill 安装
- macOS 增强：
  Computer Use、系统 Chrome 备用自动化、Chrome 登录态导入、部分浏览器运行时管理

Windows / Linux 上不会挂载 macOS-only 的 `computer_*` 桌面自动化工具；基础 Agent 能力仍应使用宿主系统 shell 正常运行，例如在 Windows 上通过 PowerShell/cmd 辅助安装软件、配置 Node、运行项目命令。

Aura 内置 `aura_install_skill`，可以从本地路径、粘贴的 `SKILL.md`、raw URL、GitHub 来源、npm 包或第三方文档里的 `npx` 安装命令解析并安装 skill。安装 Aura skill 时不会直接执行 Claude / Codex / 第三方 npx installer；这些命令只作为来源线索。

## 适合谁

- 希望拥有可控本地 Agent 的开发者
- 想把自己的 API Key / Base URL 接进桌面 Agent 的用户
- 需要 MCP、插件、技能体系的高级用户
- 需要浏览器自动化与桌面自动化协同的团队
- 不想被封闭商业产品锁死的个人和团队

## 路线方向

当前版本已经完成第一阶段 MVP。后续优先方向包括：

- 更成熟的聊天工作台与 Composer 交互
- 更细粒度的权限与审批策略
- 更强的模型路由与失败恢复
- 更完整的插件/技能资产管理体验
- 更强的浏览器与桌面协作能力

## 贡献

欢迎通过 Issue / PR 参与：

- Bug 修复
- 新 Provider
- 新 MCP 集成
- 新技能 / 插件
- 浏览器与桌面能力增强
- UI / 交互优化
