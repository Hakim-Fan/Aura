function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`#>*_[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeIdentifier(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '')
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function splitIntoKeywords(value) {
  const normalized = normalizeText(value)
  if (!normalized) {
    return []
  }

  const phrases = normalized
    .split(/[\n,.;:!?/|]+/u)
    .map(entry => entry.trim())
    .filter(entry => entry.length >= 2)

  const words = normalized
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map(entry => entry.trim())
    .filter(entry => entry.length >= 2)

  return unique([...phrases, ...words]).slice(0, 48)
}

function countMatches(text, keywords) {
  let score = 0

  for (const keyword of keywords) {
    if (!keyword || keyword.length < 2) {
      continue
    }
    if (text.includes(keyword)) {
      score += keyword.length >= 8 ? 3 : 1
    }
  }

  return score
}

function hasAny(text, patterns) {
  return patterns.some(pattern => text.includes(pattern))
}

function buildConversationText(messages) {
  return normalizeText(
    messages
      .slice(-8)
      .map(message => {
        const parts = Array.isArray(message.parts)
          ? message.parts
              .map(part => {
                if (part.type === 'text') {
                  return part.text || ''
                }
                if (part.type === 'image' || part.type === 'file') {
                  return [part.name, part.path].filter(Boolean).join(' ')
                }
                return ''
              })
              .join('\n')
          : ''

        return [message.content, parts].filter(Boolean).join('\n')
      })
      .join('\n'),
  )
}

function inferTaskSignals(text) {
  return {
    isEditingTask: hasAny(text, [
      'fix',
      'bug',
      'error',
      'implement',
      'feature',
      'refactor',
      'rewrite',
      'update',
      'optimize',
      'repair',
      '修改',
      '改造',
      '实现',
      '修复',
      '重构',
      '优化',
      '新增',
      '补',
    ]),
    isReviewTask: hasAny(text, [
      'review',
      'regression',
      'verify',
      'validation',
      'test',
      'check',
      '审查',
      '检查',
      '验证',
      '回归',
      '测试',
    ]),
    isStructureTask: hasAny(text, [
      'workspace',
      'repo',
      'repository',
      'structure',
      'tree',
      'snapshot',
      '目录',
      '结构',
      '项目',
      '工作区',
      '仓库',
    ]),
    isGitTask: hasAny(text, [
      'git',
      'commit',
      'branch',
      'diff',
      'status',
      'rebase',
      'merge',
      '提交',
      '分支',
      '变更',
    ]),
    isDesktopTask: hasAny(text, [
      'desktop',
      'window',
      'screen',
      'screenshot',
      'click',
      'type into',
      '打开应用',
      '桌面',
      '窗口',
      '截图',
      '点击',
      '输入',
      'mac',
      'app',
    ]),
    isBrowserTask: hasAny(text, [
      'chrome',
      'browser',
      'tab',
      'page',
      'website',
      'url',
      '网页',
      '浏览器',
      '标签页',
      '页面',
      '网址',
    ]),
    isResearchTask: hasAny(text, [
      'search',
      'lookup',
      'find',
      'query',
      'latest',
      'current',
      'today',
      'news',
      'price',
      'stock',
      'quote',
      'documentation',
      'docs',
      '查询',
      '搜索',
      '查一下',
      '查找',
      '最新',
      '当前',
      '今天',
      '新闻',
      '价格',
      '股价',
      '行情',
      '资料',
      '文档',
    ]),
    isComplexTask: hasAny(text, [
      'complex',
      'parallel',
      'delegate',
      'subagent',
      'multi-step',
      '复杂',
      '并行',
      '委派',
      '子 agent',
      '多步骤',
    ]),
  }
}

function buildSkillSearchTerms(skill) {
  return unique([
    skill.id,
    skill.name,
    skill.summary,
    ...(skill.keywords || []),
  ])
}

function scoreSkill(skill, context) {
  let score = countMatches(context.text, buildSkillSearchTerms(skill))

  if (context.text.includes(normalizeText(skill.id))) {
    score += 6
  }
  if (context.text.includes(normalizeText(skill.name))) {
    score += 6
  }

  if (skill.id === 'repair-planner' && context.signals.isEditingTask) {
    score += 5
  }
  if (skill.id === 'repo-reviewer' && (context.signals.isReviewTask || context.signals.isEditingTask)) {
    score += 4
  }
  if (skill.id === 'desktop-operator' && context.signals.isDesktopTask) {
    score += 5
  }

  return score
}

function describeBuiltinGroup(tool) {
  if (tool.name === 'spawn_subagent') {
    return {
      id: 'advanced:multi-agent',
      kind: 'advanced',
      name: 'Multi-Agent Delegation',
      description: tool.description,
      keywords: ['subagent', 'delegate', 'parallel', 'worker'],
      defaultSelected: false,
    }
  }

  if (tool.name.startsWith('computer_')) {
    return {
      id: 'advanced:computer-use',
      kind: 'advanced',
      name: 'Computer Use',
      description: tool.description,
      keywords: ['desktop', 'screen', 'window', 'click', 'type', 'app'],
      defaultSelected: false,
    }
  }

  if (tool.name.startsWith('browser_')) {
    return {
      id: 'advanced:browser-runtime',
      kind: 'advanced',
      name: 'Aura Browser Runtime',
      description: tool.description,
      keywords: ['browser', 'page', 'website', 'url', 'dom', 'screenshot', 'search', '网页', '浏览器'],
      defaultSelected: false,
    }
  }

  if (tool.name.startsWith('chrome_')) {
    return {
      id: 'advanced:chrome-automation',
      kind: 'advanced',
      name: 'Chrome Automation',
      description: tool.description,
      keywords: ['chrome', 'browser', 'tab', 'page', 'url', 'website'],
      defaultSelected: false,
    }
  }

  return {
    id: 'builtin:core',
    kind: 'builtin',
    name: 'Core Workspace Tools',
    description: 'Essential workspace inspection, editing, and shell execution tools.',
    keywords: ['workspace', 'files', 'read', 'write', 'shell', 'search'],
    defaultSelected: true,
  }
}

function getToolGroup(tool) {
  if (tool.source === 'plugin') {
    return {
      id: `plugin:${tool.capabilityId || tool.name}`,
      kind: 'plugin',
      name: tool.capabilityName || tool.capabilityId || tool.name,
      description: tool.capabilityDescription || tool.description || '',
      keywords: unique([
        tool.capabilityId,
        tool.capabilityName,
        tool.capabilityDescription,
        tool.name,
        tool.description,
      ]),
      defaultSelected: false,
    }
  }

  if (tool.source === 'mcp') {
    return {
      id: `mcp:${tool.capabilityId || tool.name}`,
      kind: 'mcp',
      name: tool.capabilityName || tool.capabilityId || tool.name,
      description: tool.capabilityDescription || tool.description || '',
      keywords: unique([
        tool.capabilityId,
        tool.capabilityName,
        tool.capabilityDescription,
        tool.name,
        tool.description,
      ]),
      defaultSelected: false,
    }
  }

  return describeBuiltinGroup(tool)
}

function buildToolGroups(tools) {
  const groups = new Map()

  for (const tool of tools) {
    const group = getToolGroup(tool)
    const current =
      groups.get(group.id) || {
        ...group,
        tools: [],
      }
    current.tools.push(tool)
    current.description =
      current.description ||
      tool.capabilityDescription ||
      tool.description ||
      current.description
    current.keywords = unique([
      ...(current.keywords || []),
      tool.name,
      tool.description,
      tool.capabilityName,
      tool.capabilityDescription,
    ])
    groups.set(group.id, current)
  }

  return Array.from(groups.values())
}

function scoreToolGroup(group, context) {
  if (group.defaultSelected) {
    return 100
  }

  let score = countMatches(context.text, group.keywords || [])
  const normalizedKeywords = normalizeText((group.keywords || []).join(' '))
  const looksLikeSearchCapability =
    normalizedKeywords.includes('search') ||
    normalizedKeywords.includes('duckduckgo') ||
    normalizedKeywords.includes('web') ||
    normalizedKeywords.includes('browse') ||
    normalizedKeywords.includes('query') ||
    normalizedKeywords.includes('fetch') ||
    normalizedKeywords.includes('news') ||
    normalizedKeywords.includes('price') ||
    normalizedKeywords.includes('文档') ||
    normalizedKeywords.includes('搜索') ||
    normalizedKeywords.includes('查询')

  if (group.kind === 'advanced') {
    if (group.id === 'advanced:multi-agent' && context.signals.isComplexTask) {
      score += 5
    }
    if (group.id === 'advanced:computer-use' && context.signals.isDesktopTask) {
      score += 6
    }
    if (
      group.id === 'advanced:browser-runtime' &&
      (context.signals.isBrowserTask || context.signals.isResearchTask)
    ) {
      score += 8
    }
    if (group.id === 'advanced:chrome-automation' && context.signals.isBrowserTask) {
      score += 4
    }
  }

  if (group.kind === 'mcp' && context.signals.isResearchTask && looksLikeSearchCapability) {
    score += 10
  }

  if (group.kind === 'plugin' && group.id.includes('workspace-inspector') && context.signals.isStructureTask) {
    score += 4
  }
  if (group.kind === 'plugin' && group.id.includes('git-helper') && context.signals.isGitTask) {
    score += 6
  }

  return score
}

function buildToolSelectionKeys(tool) {
  return unique([
    tool.name,
    ...(Array.isArray(tool.aliases) ? tool.aliases : []),
  ]).map(entry => normalizeIdentifier(entry))
}

function pickAllowedTools(selectedSkills, tools) {
  const wanted = new Set(
    selectedSkills.flatMap(skill =>
      (Array.isArray(skill.allowedTools) ? skill.allowedTools : []).map(entry =>
        normalizeIdentifier(entry),
      ),
    ),
  )

  if (wanted.size === 0) {
    return []
  }

  return tools.filter(tool =>
    buildToolSelectionKeys(tool).some(key => wanted.has(key)),
  )
}

function buildCapabilitySnapshot({ workspaceRoot, resolvedAt, selectedSkills, selectedTools }) {
  const plugins = []
  const mcpServers = []
  const seenPlugins = new Set()
  const seenMcpServers = new Set()

  for (const tool of selectedTools) {
    if (tool.source === 'plugin' && tool.capabilityId && !seenPlugins.has(tool.capabilityId)) {
      seenPlugins.add(tool.capabilityId)
      plugins.push({
        id: tool.capabilityId,
        name: tool.capabilityName || tool.capabilityId,
      })
    }

    if (tool.source === 'mcp' && tool.capabilityId && !seenMcpServers.has(tool.capabilityId)) {
      seenMcpServers.add(tool.capabilityId)
      mcpServers.push({
        id: tool.capabilityId,
        name: tool.capabilityName || tool.capabilityId,
      })
    }
  }

  return {
    workspaceRoot,
    resolvedAt,
    skills: selectedSkills.map(skill => ({
      id: skill.id,
      name: skill.name,
    })),
    plugins,
    mcpServers,
  }
}

export function selectTurnCapabilities({
  messages,
  runtimeCapabilities,
  skillEntries,
  tools,
}) {
  const text = buildConversationText(messages)
  const context = {
    text,
    signals: inferTaskSignals(text),
  }

  const selectedSkills = skillEntries
    .map(skill => ({
      skill,
      score: scoreSkill(skill, context),
    }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(entry => entry.skill)

  const selectedGroupIds = new Set()
  const groups = buildToolGroups(tools)

  for (const group of groups) {
    const score = scoreToolGroup(group, context)
    if (group.defaultSelected || score > 0) {
      selectedGroupIds.add(group.id)
    }
  }

  const selectedTools = tools.filter(tool => selectedGroupIds.has(getToolGroup(tool).id))
  const allowedTools = pickAllowedTools(selectedSkills, tools)
  const mergedTools = unique([...selectedTools, ...allowedTools])

  return {
    selectedSkills,
    selectedTools: mergedTools,
    capabilitySnapshot: buildCapabilitySnapshot({
      workspaceRoot: runtimeCapabilities?.workspaceRoot || '',
      resolvedAt: Date.now(),
      selectedSkills,
      selectedTools: mergedTools,
    }),
  }
}
