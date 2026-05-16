const WRITE_TOOL_NAMES = new Set([
  'apply_patch',
  'write_file',
  'edit_file',
  'multi_edit_file',
  'replace_line_range',
])

const SHELL_TOOL_NAMES = new Set([
  'exec_command',
  'run_shell',
  'write_stdin',
])

const WEB_TOOL_NAMES = new Set([
  'web_search',
  'web_fetch',
  'web_research',
])

const ADMIN_TOOL_NAMES = new Set([
  'aura_enable_skill',
  'aura_enable_plugin',
  'aura_install_skill',
  'aura_import_skill',
  'aura_import_plugin',
  'aura_upsert_mcp_server',
  'aura_remove_mcp_server',
])

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function inferToolPermissionScope(tool = {}) {
  const explicitScope = normalizeString(tool.permissionScope)
  if (explicitScope) {
    return explicitScope
  }
  const approvalCategory = normalizeString(tool.approvalCategory)
  const name = normalizeString(tool.name)

  if (approvalCategory === 'computer_use' || name.startsWith('computer_')) {
    return 'computer'
  }
  if (approvalCategory === 'shell' || SHELL_TOOL_NAMES.has(name)) {
    return 'shell'
  }
  if (approvalCategory === 'file_write' || WRITE_TOOL_NAMES.has(name)) {
    return 'workspace_write'
  }
  if (name === 'system_browser_open') {
    return 'browser'
  }
  if (WEB_TOOL_NAMES.has(name)) {
    return 'web'
  }
  if (ADMIN_TOOL_NAMES.has(name)) {
    return 'admin'
  }
  if (tool.source === 'mcp') {
    return approvalCategory ? 'external_mutation' : 'external_read'
  }
  if (tool.source === 'plugin') {
    return approvalCategory ? 'plugin_mutation' : 'plugin_read'
  }
  return 'workspace_read'
}

export function inferToolRiskLevel(tool = {}) {
  const scope = inferToolPermissionScope(tool)

  switch (scope) {
    case 'computer':
      return 'critical'
    case 'shell':
    case 'admin':
    case 'browser':
    case 'external_mutation':
    case 'plugin_mutation':
      return 'high'
    case 'workspace_write':
    case 'web':
      return 'medium'
    default:
      return 'low'
  }
}

export function createToolCatalogEntry(tool = {}, options = {}) {
  const name = normalizeString(tool.name)
  const source = normalizeString(tool.source) || 'builtin'
  const approvalCategory = normalizeString(tool.approvalCategory)
  const permissionScope =
    normalizeString(tool.permissionScope) || inferToolPermissionScope(tool)
  const riskLevel = normalizeString(tool.riskLevel) || inferToolRiskLevel({
    ...tool,
    permissionScope,
  })

  return {
    key: normalizeString(options.key || tool.toolKey) || `${source}:${name}`,
    name,
    canonicalName: normalizeString(tool.canonicalName) || name,
    source,
    layer: normalizeString(options.layer || tool.layer || source),
    description: normalizeString(tool.description),
    approvalCategory: approvalCategory || undefined,
    permissionScope,
    riskLevel,
    internalOnly: tool.internalOnly === true,
    supportsParallel: tool.liveUpdates !== true,
  }
}

export function buildToolCatalog(tools = [], options = {}) {
  const entries = (Array.isArray(tools) ? tools : [])
    .filter(tool => tool && typeof tool === 'object')
    .map(tool => createToolCatalogEntry(tool, options))

  return {
    entries,
    byName: new Map(entries.map(entry => [entry.name, entry])),
    highRiskCount: entries.filter(entry =>
      entry.riskLevel === 'high' || entry.riskLevel === 'critical',
    ).length,
  }
}
