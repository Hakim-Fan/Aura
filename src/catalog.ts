export const builtinSkills = [
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
]

export const builtinPlugins: Array<{
  id: string
  name: string
  description: string
}> = []
