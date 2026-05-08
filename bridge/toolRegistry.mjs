function normalizeKeyPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

function shouldDeferEntry(tool, layer) {
  if (tool?.deferLoading === true) {
    return true
  }

  if (tool?.deferLoading === false) {
    return false
  }

  return layer === 'plugin' || layer === 'mcp'
}

function shouldDiscoverEntry(tool, layer) {
  if (tool?.discoverable === true) {
    return true
  }

  if (tool?.discoverable === false) {
    return false
  }

  return shouldDeferEntry(tool, layer)
}

function inferBuiltinPrivilege(tool) {
  if (tool.name.startsWith('computer_')) {
    return 'computer'
  }

  if (tool.name === 'system_browser_open') {
    return 'browser'
  }

  if (
    tool.name === 'write_file' ||
    tool.name === 'apply_patch' ||
    tool.name === 'edit_file' ||
    tool.name === 'multi_edit_file'
  ) {
    return 'write'
  }

  if (
    tool.name === 'run_shell' ||
    tool.name === 'exec_command' ||
    tool.name === 'write_stdin'
  ) {
    return 'execute'
  }

  if (
    tool.name === 'web_search' ||
    tool.name === 'web_fetch' ||
    tool.name === 'web_research'
  ) {
    return 'web'
  }

  if (tool.name.startsWith('aura_')) {
    return tool.name === 'aura_enable_skill' ||
      tool.name === 'aura_enable_plugin' ||
      tool.name === 'aura_install_skill' ||
      tool.name === 'aura_import_skill' ||
      tool.name === 'aura_import_plugin' ||
      tool.name === 'aura_upsert_mcp_server' ||
      tool.name === 'aura_remove_mcp_server'
      ? 'admin'
      : 'read'
  }

  return 'read'
}

function inferEntryVisibility(tool, layer) {
  if (tool?.discoverOnly === true) {
    return 'discoverable'
  }

  return shouldDeferEntry(tool, layer) ? 'deferred' : 'direct'
}

function buildEntry(tool, layer) {
  const key = [
    normalizeKeyPart(tool?.source || layer || 'builtin'),
    normalizeKeyPart(tool?.capabilityId || tool?.capabilityName || layer || ''),
    normalizeKeyPart(tool?.name || ''),
  ]
    .filter(Boolean)
    .join(':')
  const namespace =
    tool.source === 'mcp'
      ? 'mcp'
      : tool.source === 'plugin'
        ? 'plugin'
        : layer === 'advanced'
          ? 'advanced'
          : 'builtin'

  const materializedTool =
    tool && typeof tool === 'object'
      ? {
          ...tool,
          toolKey: tool.toolKey || key,
          callName: tool.callName || tool.name,
        }
      : tool
  const visibility = inferEntryVisibility(materializedTool, layer)

  return {
    key,
    name: tool.name,
    callName: materializedTool?.callName || tool.name,
    namespace,
    source: tool.source,
    layer,
    privilege:
      tool.source === 'builtin'
        ? inferBuiltinPrivilege(tool)
        : tool.approvalCategory
          ? 'write'
          : 'read',
    visibility,
    availability:
      visibility === 'discoverable'
        ? 'activation_required'
        : visibility === 'deferred'
          ? 'loadable'
          : 'mounted',
    discoverability:
      visibility === 'discoverable' || shouldDiscoverEntry(tool, layer)
        ? 'discoverable'
        : 'direct',
    supportsParallel: tool.liveUpdates !== true,
    activationHint:
      typeof materializedTool?.activationHint === 'string'
        ? materializedTool.activationHint
        : '',
    tool: materializedTool,
  }
}

export function createToolRegistry({
  builtinTools = [],
  advancedTools = [],
  pluginTools = [],
  mcpTools = [],
  discoverableTools = [],
} = {}) {
  const inferDiscoverableLayer = tool => (tool?.source === 'mcp' ? 'mcp' : 'plugin')
  const entries = [
    ...builtinTools.map(tool => buildEntry(tool, 'builtin')),
    ...advancedTools.map(tool => buildEntry(tool, 'advanced')),
    ...pluginTools.map(tool => buildEntry(tool, 'plugin')),
    ...mcpTools.map(tool => buildEntry(tool, 'mcp')),
    ...discoverableTools.map(tool => buildEntry(tool, inferDiscoverableLayer(tool))),
  ]
  const byCallName = new Map()
  const byName = new Map()
  const duplicateCallNames = new Set()
  const duplicateNames = new Set()

  for (const entry of entries) {
    const existing = byCallName.get(entry.callName) || []
    existing.push(entry)
    byCallName.set(entry.callName, existing)
    if (existing.length > 1) {
      duplicateCallNames.add(entry.callName)
    }

    const existingByName = byName.get(entry.name) || []
    existingByName.push(entry)
    byName.set(entry.name, existingByName)
    if (existingByName.length > 1) {
      duplicateNames.add(entry.name)
    }
  }

  function getUniqueEntryByCallName(callName) {
    const matches = byCallName.get(callName) || []
    return matches.length === 1 ? matches[0] : null
  }

  function getUniqueEntryByName(name) {
    const matches = byName.get(name) || []
    return matches.length === 1 ? matches[0] : null
  }

  return {
    entries,
    directEntries: entries.filter(entry => entry.visibility === 'direct'),
    deferredEntries: entries.filter(entry => entry.visibility === 'deferred'),
    discoverableEntries: entries.filter(entry => entry.discoverability === 'discoverable'),
    discoverableOnlyEntries: entries.filter(entry => entry.visibility === 'discoverable'),
    byKey: new Map(entries.map(entry => [entry.key, entry])),
    byName,
    byCallName,
    duplicateCallNames,
    duplicateNames,
    getEntry(identifier) {
      if (!identifier) {
        return null
      }
      return (
        this.byKey.get(identifier) ||
        getUniqueEntryByCallName(identifier) ||
        getUniqueEntryByName(identifier) ||
        null
      )
    },
  }
}
