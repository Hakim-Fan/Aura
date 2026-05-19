function inferToolPrivilege(tool) {
  if (!tool || typeof tool !== 'object') {
    return 'read'
  }
  if (
    tool.approvalCategory === 'shell' ||
    tool.name === 'run_shell' ||
    tool.name === 'exec_command' ||
    tool.name === 'write_stdin'
  ) {
    return 'execute'
  }
  if (
    tool.name === 'aura_enable_skill' ||
    tool.name === 'aura_enable_plugin' ||
    tool.name === 'aura_install_skill' ||
    tool.name === 'aura_import_skill' ||
    tool.name === 'aura_import_plugin' ||
    tool.name === 'aura_upsert_mcp_server' ||
    tool.name === 'aura_remove_mcp_server'
  ) {
    return 'admin'
  }
  if (
    tool.approvalCategory === 'file_write' ||
    tool.name === 'write_file' ||
    tool.name === 'apply_patch' ||
    tool.name === 'edit_file' ||
    tool.name === 'multi_edit_file' ||
    tool.name === 'replace_line_range'
  ) {
    return 'write'
  }
  if (
    tool.name === 'web_search' ||
    tool.name === 'web_fetch' ||
    tool.name === 'web_research'
  ) {
    return 'web'
  }
  if (
    tool.approvalCategory === 'computer_use' ||
    tool.name?.startsWith?.('computer_')
  ) {
    return 'computer'
  }
  return 'read'
}

function allowedPrivilegesForTier(routeState = {}) {
  const tier = routeState.capabilityTier || 'none'
  const allowWeb = routeState.webRetrievalAvailable !== false
  const allowBrowser =
    routeState.webInteractionRequired === true ||
    routeState.explicitSystemBrowserRequest === true
  const allowAdmin = routeState.isCapabilityAdminTask === true
  const privileges = new Set(['read', 'write', 'execute'])

  if (allowWeb) {
    privileges.add('web')
  }
  if (allowBrowser && tier === 'browser-interactive') {
    privileges.add('computer')
  }
  if (allowAdmin) {
    privileges.add('admin')
  }
  return privileges
}

export function evaluateRuntimeCapabilityContract({
  routeState = {},
  selectedTools = [],
} = {}) {
  if (routeState?.modelDirected === true) {
    return null
  }

  const tier = routeState.capabilityTier || ''
  if (!tier) {
    return null
  }

  const allowedPrivileges = allowedPrivilegesForTier(routeState)
  const violations = selectedTools
    .map(tool => ({
      name: tool?.name || 'unknown',
      privilege: inferToolPrivilege(tool),
    }))
    .filter(entry => !allowedPrivileges.has(entry.privilege))

  if (violations.length === 0) {
    return null
  }

  const violationSummary = violations
    .slice(0, 5)
    .map(entry => `${entry.name}:${entry.privilege}`)
    .join(', ')

  return {
    note:
      `Runtime capability contract blocked tools outside tier "${tier}": ${violationSummary}.`,
    retrySummary: '运行时能力合约发现工具越权，正在重新选择可用能力。',
    violations,
  }
}
