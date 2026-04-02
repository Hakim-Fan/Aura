export const builtinSkills = [
  {
    id: 'repair-planner',
    name: 'Repair Planner',
    description: '先整理代码修复路径，再动手落地实现。',
  },
  {
    id: 'repo-reviewer',
    name: 'Repo Reviewer',
    description: '从行为回归、风险点和测试覆盖角度审视改动。',
  },
  {
    id: 'desktop-operator',
    name: 'Desktop Operator',
    description: '偏向桌面工作台、权限边界和本地优先的实现策略。',
  },
]

export const builtinPlugins = [
  {
    id: 'workspace-inspector',
    name: 'Workspace Inspector',
    description: '让 Agent 可以快速获取工作区快照。',
  },
  {
    id: 'git-helper',
    name: 'Git Helper',
    description: '为 Agent 提供只读 Git 状态能力。',
  },
]

export const advancedCapabilities = [
  {
    title: '文件与命令',
    status: '已接入',
    detail: '读写文件、代码搜索、Shell 执行都由桌面运行时直接提供。',
  },
  {
    title: 'Multi-Agent',
    status: '已接入',
    detail: '支持把一个复杂任务拆给子 Agent 执行，再把结果回收给主 Agent。',
  },
  {
    title: 'Computer Use',
    status: '已接入',
    detail: '桌面运行时可列举应用、切换应用、录屏截图、输入文本和发送快捷键。',
  },
  {
    title: 'Chrome Automation',
    status: '已接入',
    detail: '可直接打开 URL、读取当前标签页信息并对活动页执行 JavaScript。',
  },
  {
    title: 'Skills',
    status: '已接入',
    detail: '本地 Markdown 技能会拼接进系统提示，适合固定工作流。',
  },
  {
    title: 'MCP',
    status: '已接入',
    detail: '支持配置 stdio MCP server，并把 MCP 工具暴露给模型。',
  },
  {
    title: 'Plugins',
    status: '已接入',
    detail: '本地 JS 插件可注册附加工具，不依赖终端 UI。',
  },
]
