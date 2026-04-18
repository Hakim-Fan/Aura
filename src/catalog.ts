export const builtinSkills = [
  {
    id: 'aura-browser-operator',
    name: 'Aura Browser Operator',
    description: '在网页任务中优先用 Aura browser_* 工具，并按观察-操作-验证闭环推进。',
  },
  {
    id: 'repair-planner',
    name: 'Repair Planner',
    description: '先收敛问题和最小修复路径，再动手修改并验证。',
  },
  {
    id: 'repo-reviewer',
    name: 'Repo Reviewer',
    description: '用 findings-first 方式审查回归风险、缺陷和验证缺口。',
  },
  {
    id: 'desktop-operator',
    name: 'Desktop Operator',
    description: '只在确实需要 UI 或浏览器交互时才使用桌面能力。',
  },
  {
    id: 'web-research',
    name: 'Web Research',
    description: '研究、新闻、文档、行情和事实查询时，优先用 web_search 找来源，再用 web_fetch 读正文。',
  },
]

export const builtinPlugins: Array<{
  id: string
  name: string
  description: string
}> = []
