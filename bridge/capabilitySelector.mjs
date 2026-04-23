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

function containsUrlLikeText(text) {
  return /(?:https?:\/\/|www\.)\S+/iu.test(String(text || ''))
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

function inferLocalTaskSignals(text) {
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
      '股票',
      '财报',
      '公告',
      '利好',
      '利空',
      '研报',
      '港股',
      '美股',
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

function inferTaskSignalsFromClassification(classification, text) {
  if (!classification || typeof classification !== 'object') {
    return inferLocalTaskSignals(text)
  }

  return {
    isEditingTask:
      classification.answerMode === 'execute' && classification.workspaceRelated === true,
    isReviewTask:
      classification.answerMode === 'diagnose' && classification.workspaceRelated === true,
    isStructureTask: hasAny(text, ['structure', 'tree', 'snapshot', '目录', '结构']),
    isGitTask: hasAny(text, ['git', 'commit', 'branch', 'diff', 'status', '提交', '分支']),
    isDesktopTask:
      classification.webInteractionRequired === true ||
      classification.systemBrowserRequested === true,
    isBrowserTask:
      classification.webInteractionRequired === true ||
      classification.systemBrowserRequested === true,
    isResearchTask: classification.needsExternalFacts === true,
    isComplexTask:
      classification.taskComplexity === 'high' ||
      classification.planDepth === 'multi_step' ||
      classification.planDepth === 'long_horizon',
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
  if (skill.id === 'web-research' && context.signals.isResearchTask) {
    score += 5
  }

  return score
}

function buildToolSelectionKeys(tool) {
  return unique([
    tool.name,
    ...(Array.isArray(tool.aliases) ? tool.aliases : []),
  ]).map(entry => normalizeIdentifier(entry))
}

function buildAllowedToolKeySet(selectedSkills) {
  return new Set(
    selectedSkills.flatMap(skill =>
      (Array.isArray(skill.allowedTools) ? skill.allowedTools : []).map(entry =>
        normalizeIdentifier(entry),
      ),
    ),
  )
}

const CORE_WORKSPACE_TOOLS = new Set([
  'list_files',
  'glob_files',
  'read_file',
  'search_code',
  'todo_write',
])

const LOCAL_EXECUTION_TOOLS = new Set([
  'apply_patch',
  'write_file',
  'edit_file',
  'multi_edit_file',
  'run_shell',
])

const WEB_RETRIEVAL_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'web_research',
])

const DISCOVERY_TOOLS = new Set([
  'tool_search',
])

function scoreToolOrdering(tool, context, allowedToolKeys, originalIndex) {
  let score = 0

  if (tool.source === 'builtin') {
    score += 40
  } else if (tool.source === 'plugin' || tool.source === 'mcp') {
    score += 16
  }

  if (CORE_WORKSPACE_TOOLS.has(tool.name)) {
    score += 35
  }

  if (DISCOVERY_TOOLS.has(tool.name)) {
    score += 18
  }

  if (context.routeState?.isCapabilityAdminTask === true && tool.name.startsWith('aura_')) {
    score += 70
  }

  if (context.signals.isEditingTask) {
    if (tool.name === 'apply_patch') {
      score += 90
    } else if (LOCAL_EXECUTION_TOOLS.has(tool.name)) {
      score += 50
    } else if (tool.name === 'read_file' || tool.name === 'search_code' || tool.name === 'glob_files') {
      score += 40
    }
  }

  if (context.signals.isReviewTask) {
    if (tool.name === 'read_file' || tool.name === 'search_code') {
      score += 45
    } else if (tool.name === 'run_shell') {
      score += 18
    }
  }

  if (context.signals.isResearchTask && WEB_RETRIEVAL_TOOLS.has(tool.name)) {
    score += 80

    if (
      context.routeState?.responseStyle === 'research-structured' &&
      tool.name === 'web_research'
    ) {
      score += 24
    } else if (tool.name === 'web_search') {
      score += 10
    }

    if (containsUrlLikeText(context.text) && tool.name === 'web_fetch') {
      score += 22
    }
  }

  if (context.signals.isBrowserTask) {
    if (tool.name === 'system_browser_open') {
      score += 70
    }
    if (tool.name.startsWith('computer_')) {
      score += 60
    }
  }

  if (context.signals.isComplexTask && tool.name === 'spawn_subagent') {
    score += 40
  }

  if (tool.source === 'plugin' || tool.source === 'mcp') {
    const capabilityTerms = unique([
      tool.capabilityId,
      tool.capabilityName,
      tool.name,
      ...(Array.isArray(tool.aliases) ? tool.aliases : []),
    ])
    score += Math.min(24, countMatches(context.text, capabilityTerms) * 2)
  } else {
    const directToolTerms = [tool.name, ...(Array.isArray(tool.aliases) ? tool.aliases : [])]
    score += Math.min(18, countMatches(context.text, directToolTerms) * 2)
  }

  const explicitlyAllowed = buildToolSelectionKeys(tool).some(key => allowedToolKeys.has(key))
  if (explicitlyAllowed) {
    score += 28
  }

  return {
    tool,
    score,
    originalIndex,
  }
}

function rankToolsByRelevance(tools, context, selectedSkills) {
  const allowedToolKeys = buildAllowedToolKeySet(selectedSkills)
  return tools
    .map((tool, index) => scoreToolOrdering(tool, context, allowedToolKeys, index))
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)
    .map(entry => entry.tool)
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
  classification,
  routeState,
}) {
  const text = buildConversationText(messages)
  const context = {
    text,
    signals: inferTaskSignalsFromClassification(classification, text),
    routeState,
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

  const orderedTools = rankToolsByRelevance(tools, context, selectedSkills)

  return {
    selectedSkills,
    selectedTools: orderedTools,
    capabilitySnapshot: buildCapabilitySnapshot({
      workspaceRoot: runtimeCapabilities?.workspaceRoot || '',
      resolvedAt: Date.now(),
      selectedSkills,
      selectedTools: orderedTools,
    }),
  }
}
