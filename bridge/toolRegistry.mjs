function shouldDeferEntry(tool, layer) {
  return layer === 'plugin' || layer === 'mcp'
}

function shouldDiscoverEntry(tool, layer) {
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

  if (tool.name === 'run_shell') {
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
      tool.name === 'aura_import_skill' ||
      tool.name === 'aura_import_plugin' ||
      tool.name === 'aura_upsert_mcp_server' ||
      tool.name === 'aura_remove_mcp_server'
      ? 'admin'
      : 'read'
  }

  return 'read'
}

function buildEntry(tool, layer) {
  const namespace =
    tool.source === 'mcp'
      ? 'mcp'
      : tool.source === 'plugin'
        ? 'plugin'
        : layer === 'advanced'
          ? 'advanced'
          : 'builtin'

  return {
    name: tool.name,
    namespace,
    source: tool.source,
    layer,
    privilege:
      tool.source === 'builtin'
        ? inferBuiltinPrivilege(tool)
        : tool.approvalCategory
          ? 'write'
          : 'read',
    visibility: shouldDeferEntry(tool, layer) ? 'deferred' : 'direct',
    discoverability: shouldDiscoverEntry(tool, layer) ? 'discoverable' : 'direct',
    supportsParallel: tool.liveUpdates !== true,
    tool,
  }
}

export function createToolRegistry({
  builtinTools = [],
  advancedTools = [],
  pluginTools = [],
  mcpTools = [],
} = {}) {
  const entries = [
    ...builtinTools.map(tool => buildEntry(tool, 'builtin')),
    ...advancedTools.map(tool => buildEntry(tool, 'advanced')),
    ...pluginTools.map(tool => buildEntry(tool, 'plugin')),
    ...mcpTools.map(tool => buildEntry(tool, 'mcp')),
  ]

  return {
    entries,
    directEntries: entries.filter(entry => entry.visibility === 'direct'),
    deferredEntries: entries.filter(entry => entry.visibility === 'deferred'),
    discoverableEntries: entries.filter(entry => entry.discoverability === 'discoverable'),
    byName: new Map(entries.map(entry => [entry.name, entry])),
  }
}
