import { createToolSearchTool } from './toolDiscovery.mjs'

function buildCapabilityPolicy(routeState) {
  const capabilityTier = routeState?.capabilityTier || 'none'
  const isWorkspaceExecutionTask =
    routeState?.answerMode === 'execute' && routeState?.workspaceRelated === true
  const needsExternalFacts = routeState?.needsExternalFacts === true

  return {
    capabilityTier,
    allowReadonly:
      capabilityTier !== 'none' ||
      routeState?.workspaceRelated === true ||
      needsExternalFacts,
    allowWrite:
      capabilityTier === 'local-write' ||
      capabilityTier === 'browser-interactive' ||
      isWorkspaceExecutionTask,
    allowWeb:
      capabilityTier === 'web-lookup' ||
      capabilityTier === 'browser-interactive' ||
      needsExternalFacts,
    allowBrowser: capabilityTier === 'browser-interactive',
    allowComputer: capabilityTier === 'browser-interactive',
    allowCapabilityAdmin: routeState?.isCapabilityAdminTask === true,
    explicitSystemBrowserRequest: routeState?.explicitSystemBrowserRequest === true,
  }
}

function allowPluginLikeEntry(entry, policy) {
  if (policy.explicitSystemBrowserRequest) {
    return false
  }

  switch (entry.tool?.approvalCategory) {
    case 'file_write':
    case 'shell':
      return policy.allowWrite
    case 'computer_use':
      return policy.allowComputer
    default:
      return true
  }
}

function isAllowedByPolicy(entry, policy) {
  if (!policy.allowReadonly) {
    return false
  }

  if (entry.source === 'plugin' || entry.source === 'mcp') {
    return allowPluginLikeEntry(entry, policy)
  }

  switch (entry.privilege) {
    case 'read':
      return true
    case 'write':
    case 'execute':
      return policy.allowWrite
    case 'web':
      return policy.allowWeb
    case 'browser':
      return policy.allowBrowser
    case 'computer':
      return policy.allowComputer
    case 'admin':
      return policy.allowCapabilityAdmin
    default:
      return false
  }
}

export function createToolRouter(registry, routeState) {
  const policy = buildCapabilityPolicy(routeState)
  const modelVisibleEntries = registry.directEntries.filter(entry =>
    isAllowedByPolicy(entry, policy),
  )
  const deferredEntries = registry.deferredEntries.filter(entry =>
    isAllowedByPolicy(entry, policy),
  )
  const discoverableEntries = registry.discoverableEntries.filter(entry =>
    isAllowedByPolicy(entry, policy),
  )
  const loadedDeferredToolNames = new Set()

  function isSearchableEntry(entry) {
    return Boolean(entry) && !loadedDeferredToolNames.has(entry.name)
  }

  function loadEntries(entries) {
    const loadedTools = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || loadedDeferredToolNames.has(entry.name)) {
        continue
      }
      loadedDeferredToolNames.add(entry.name)
      loadedTools.push(entry.tool)
    }
    return loadedTools
  }

  const toolSearchTool =
    deferredEntries.length > 0
      ? createToolSearchTool({
          searchEntries: deferredEntries,
          isSearchableEntry,
          loadEntries,
        })
      : null

  return {
    policy,
    modelVisibleEntries,
    modelVisibleTools: [
      ...(toolSearchTool ? [toolSearchTool] : []),
      ...modelVisibleEntries.map(entry => entry.tool),
    ],
    deferredTools: deferredEntries.map(entry => entry.tool),
    discoverableTools: discoverableEntries.map(entry => entry.tool),
    discoverableToolCount: discoverableEntries.length,
    resolveTool(name) {
      if (toolSearchTool && name === toolSearchTool.name) {
        return toolSearchTool
      }
      return registry.byName.get(name)?.tool || null
    },
  }
}
