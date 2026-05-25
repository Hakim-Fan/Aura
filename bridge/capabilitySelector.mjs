function buildSemanticSignals({ classification, routeState }) {
  const answerMode = routeState?.answerMode || classification?.answerMode || 'advise'
  const workspaceRelated =
    routeState?.workspaceRelated === true || classification?.workspaceRelated === true
  const needsExternalFacts =
    routeState?.needsExternalFacts === true || classification?.needsExternalFacts === true
  const browserInteraction =
    routeState?.webInteractionRequired === true ||
    routeState?.explicitSystemBrowserRequest === true ||
    classification?.webInteractionRequired === true ||
    classification?.systemBrowserRequested === true
  const isComplexTask =
    classification?.taskComplexity === 'high' ||
    classification?.planDepth === 'multi_step' ||
    classification?.planDepth === 'long_horizon'

  return {
    isEditingTask: answerMode === 'execute' && workspaceRelated,
    isReviewTask: answerMode === 'diagnose' && workspaceRelated,
    isDesktopTask: browserInteraction,
    isBrowserTask: browserInteraction,
    isResearchTask: needsExternalFacts,
    isComplexTask,
  }
}

const CORE_WORKSPACE_TOOLS = new Set([
  'list_files',
  'glob_files',
  'read_file',
  'search_code',
  'todo_write',
  'read_artifact_slice',
  'summarize_artifact',
])

const LOCAL_EXECUTION_TOOLS = new Set([
  'apply_patch',
  'write_file',
  'edit_file',
  'multi_edit_file',
  'exec_command',
  'write_stdin',
  'run_shell',
])

const LONG_SESSION_EXECUTION_TOOLS = new Set([
  'exec_command',
  'write_stdin',
])

const EXACT_REPLACEMENT_FALLBACK_TOOLS = new Set([
  'edit_file',
  'multi_edit_file',
])

const SHORT_SHELL_TOOLS = new Set([
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

function scoreToolOrdering(tool, context, originalIndex) {
  let score = 0
  const isWorkspaceExecute =
    context.routeState?.answerMode === 'execute' &&
    context.routeState?.workspaceRelated === true
  const isWorkspaceDiagnose =
    context.routeState?.answerMode === 'diagnose' &&
    context.routeState?.workspaceRelated === true
  const isExternalLookup = context.routeState?.needsExternalFacts === true
  const isBrowserInteraction =
    context.routeState?.webInteractionRequired === true ||
    context.routeState?.explicitSystemBrowserRequest === true

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
    score += 150
    if (tool.name === 'aura_install_skill' || tool.name === 'aura_import_skill') {
      score += 35
    }
    if (tool.name === 'aura_enable_skill') {
      score += 12
    }
  }

  if (isWorkspaceExecute) {
    if (tool.name === 'apply_patch') {
      score += 110
    } else if (tool.name === 'write_file') {
      score += 42
    } else if (LONG_SESSION_EXECUTION_TOOLS.has(tool.name)) {
      score += 76
    } else if (EXACT_REPLACEMENT_FALLBACK_TOOLS.has(tool.name)) {
      score += 22
    } else if (SHORT_SHELL_TOOLS.has(tool.name)) {
      score += 10
    } else if (LOCAL_EXECUTION_TOOLS.has(tool.name)) {
      score += 38
    } else if (
      tool.name === 'read_file' ||
      tool.name === 'search_code' ||
      tool.name === 'glob_files'
    ) {
      score += 45
    }
  } else if (context.signals.isEditingTask) {
    if (tool.name === 'apply_patch') {
      score += 90
    } else if (tool.name === 'write_file') {
      score += 34
    } else if (LONG_SESSION_EXECUTION_TOOLS.has(tool.name)) {
      score += 60
    } else if (EXACT_REPLACEMENT_FALLBACK_TOOLS.has(tool.name)) {
      score += 18
    } else if (SHORT_SHELL_TOOLS.has(tool.name)) {
      score += 8
    } else if (LOCAL_EXECUTION_TOOLS.has(tool.name)) {
      score += 30
    } else if (tool.name === 'read_file' || tool.name === 'search_code' || tool.name === 'glob_files') {
      score += 40
    }
  }

  if (isWorkspaceDiagnose) {
    if (tool.name === 'read_file' || tool.name === 'search_code') {
      score += 55
    } else if (tool.name === 'glob_files' || tool.name === 'list_files') {
      score += 30
    } else if (tool.name === 'exec_command' || tool.name === 'write_stdin') {
      score += 24
    } else if (tool.name === 'run_shell') {
      score += 14
    }
  } else if (context.signals.isReviewTask) {
    if (tool.name === 'read_file' || tool.name === 'search_code') {
      score += 45
    } else if (tool.name === 'exec_command' || tool.name === 'write_stdin') {
      score += 22
    } else if (tool.name === 'run_shell') {
      score += 16
    }
  }

  if (isExternalLookup && WEB_RETRIEVAL_TOOLS.has(tool.name)) {
    score += 95

    if (
      context.routeState?.responseStyle === 'research-structured' &&
      tool.name === 'web_research'
    ) {
      score += 28
    } else if (tool.name === 'web_search') {
      score += 8
    }
  } else if (context.signals.isResearchTask && WEB_RETRIEVAL_TOOLS.has(tool.name)) {
    score += 80

    if (
      context.routeState?.responseStyle === 'research-structured' &&
      tool.name === 'web_research'
    ) {
      score += 24
    } else if (tool.name === 'web_search') {
      score += 10
    }
  }

  if (isBrowserInteraction) {
    if (tool.name === 'system_browser_open') {
      score += 95
    }
    if (tool.name.startsWith('computer_')) {
      score += 75
    }
  } else if (context.signals.isBrowserTask) {
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

  return {
    tool,
    score,
    originalIndex,
  }
}

function rankToolsByRelevance(tools, context) {
  return tools
    .map((tool, index) => scoreToolOrdering(tool, context, index))
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
  const context = {
    signals: buildSemanticSignals({ classification, routeState }),
    routeState,
  }

  const selectedSkills = Array.isArray(skillEntries)
    ? skillEntries.filter(skill => skill && typeof skill === 'object')
    : []

  const orderedTools = rankToolsByRelevance(tools, context)

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
