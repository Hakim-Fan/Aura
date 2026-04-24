import { createToolSearchTool } from './toolDiscovery.mjs'

function buildCapabilityPolicy(routeState) {
  const capabilityTier = routeState?.capabilityTier || 'none'
  const answerMode = routeState?.answerMode || 'advise'
  const workspaceRelated = routeState?.workspaceRelated === true
  const webInteractionRequired = routeState?.webInteractionRequired === true
  const explicitSystemBrowserRequest =
    routeState?.explicitSystemBrowserRequest === true
  const isCapabilityAdminTask = routeState?.isCapabilityAdminTask === true

  return {
    capabilityTier,
    answerMode,
    allowReadonly: true,
    allowWrite:
      (answerMode === 'execute' && workspaceRelated) || isCapabilityAdminTask,
    allowWeb: routeState?.webRetrievalAvailable !== false,
    allowBrowser: webInteractionRequired || explicitSystemBrowserRequest,
    allowComputer: webInteractionRequired || explicitSystemBrowserRequest,
    allowCapabilityAdmin: isCapabilityAdminTask,
    explicitSystemBrowserRequest,
  }
}

function allowPluginLikeEntry(entry, policy) {
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
  const discoverableOnlyEntries = registry.discoverableOnlyEntries.filter(entry =>
    isAllowedByPolicy(entry, policy),
  )
  const searchCatalogEntries = Array.from(
    new Map(
      [
        ...modelVisibleEntries,
        ...deferredEntries,
        ...discoverableOnlyEntries,
      ].map(entry => [entry.key, entry]),
    ).values(),
  )
  const loadedDeferredToolKeys = new Set()

  function isSearchableEntry(entry) {
    return Boolean(entry)
  }

  function canLoadEntry(entry) {
    return Boolean(entry) && entry.availability === 'loadable'
  }

  function loadEntries(entries) {
    const loadedTools = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !canLoadEntry(entry) || loadedDeferredToolKeys.has(entry.key)) {
        continue
      }
      loadedDeferredToolKeys.add(entry.key)
      loadedTools.push(entry.tool)
    }
    return loadedTools
  }

  const toolSearchTool =
    searchCatalogEntries.length > 0
      ? createToolSearchTool({
          searchEntries: searchCatalogEntries,
          isSearchableEntry,
          canLoadEntry,
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
    discoverableOnlyTools: discoverableOnlyEntries.map(entry => entry.tool),
    discoverableToolCount: discoverableEntries.length,
    discoverableOnlyToolCount: discoverableOnlyEntries.length,
    resolveTool(name) {
      if (toolSearchTool && name === toolSearchTool.name) {
        return toolSearchTool
      }
      return registry.getEntry(name)?.tool || null
    },
  }
}
