import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolRegistry } from './toolRegistry.mjs'
import { createToolRouter } from './toolRouter.mjs'

function buildTool(name) {
  return {
    source: 'builtin',
    name,
  }
}

test('createToolRouter keeps web retrieval tools visible on local-first turns', () => {
  const registry = createToolRegistry({
    builtinTools: [
      buildTool('read_file'),
      buildTool('web_search'),
      buildTool('web_research'),
      buildTool('web_fetch'),
    ],
  })

  const router = createToolRouter(registry, {
    workspaceRelated: true,
    needsExternalFacts: false,
  })

  const visibleToolNames = router.modelVisibleTools.map(tool => tool.name)

  assert.ok(visibleToolNames.includes('read_file'))
  assert.ok(visibleToolNames.includes('web_search'))
  assert.ok(visibleToolNames.includes('web_research'))
  assert.ok(visibleToolNames.includes('web_fetch'))
})

test('createToolRouter keeps local write tools visible even on advise turns', () => {
  const registry = createToolRegistry({
    builtinTools: [
      buildTool('read_file'),
      buildTool('apply_patch'),
      buildTool('write_file'),
      buildTool('exec_command'),
    ],
  })

  const router = createToolRouter(registry, {
    workspaceRelated: false,
  })

  const visibleToolNames = router.modelVisibleTools.map(tool => tool.name)

  assert.ok(visibleToolNames.includes('apply_patch'))
  assert.ok(visibleToolNames.includes('write_file'))
  assert.ok(visibleToolNames.includes('exec_command'))
})

test('createToolRouter mounts Aura admin tools only for capability admin turns', () => {
  const registry = createToolRegistry({
    builtinTools: [
      buildTool('read_file'),
      buildTool('aura_install_skill'),
    ],
  })

  const ordinaryRouter = createToolRouter(registry, {
    workspaceRelated: false,
    isCapabilityAdminTask: false,
  })
  const adminRouter = createToolRouter(registry, {
    workspaceRelated: false,
    isCapabilityAdminTask: true,
  })

  assert.equal(
    ordinaryRouter.modelVisibleTools.some(tool => tool.name === 'aura_install_skill'),
    false,
  )
  assert.equal(
    adminRouter.modelVisibleTools.some(tool => tool.name === 'aura_install_skill'),
    true,
  )
})

test('createToolRouter hides browser and computer tools by default in model-directed mode', () => {
  const registry = createToolRegistry({
    builtinTools: [
      buildTool('web_search'),
      buildTool('system_browser_open'),
      buildTool('computer_capture_screen'),
    ],
  })

  const router = createToolRouter(registry, {
    modelDirected: true,
    capabilityTier: 'default-agent',
  })
  const visibleToolNames = router.modelVisibleTools.map(tool => tool.name)

  assert.ok(visibleToolNames.includes('web_search'))
  assert.equal(visibleToolNames.includes('system_browser_open'), false)
  assert.equal(visibleToolNames.includes('computer_capture_screen'), false)
})

test('createToolRouter mounts browser and computer tools for browser interaction mode', () => {
  const registry = createToolRegistry({
    builtinTools: [
      buildTool('web_search'),
      buildTool('system_browser_open'),
      buildTool('computer_capture_screen'),
    ],
  })

  const router = createToolRouter(registry, {
    modelDirected: true,
    capabilityTier: 'browser-interactive',
    webInteractionRequired: true,
  })
  const visibleToolNames = router.modelVisibleTools.map(tool => tool.name)

  assert.ok(visibleToolNames.includes('web_search'))
  assert.ok(visibleToolNames.includes('system_browser_open'))
  assert.ok(visibleToolNames.includes('computer_capture_screen'))
})

test('tool_search can find already-mounted direct tools', async () => {
  const registry = createToolRegistry({
    builtinTools: [
      buildTool('read_file'),
      buildTool('web_search'),
    ],
  })

  const router = createToolRouter(registry, {
    workspaceRelated: true,
  })

  const toolSearch = router.modelVisibleTools.find(tool => tool.name === 'tool_search')

  assert.ok(toolSearch)

  const result = await toolSearch.run({
    query: 'web search',
  })

  assert.equal(result.noResults, false)
  assert.ok(result.directToolNames.includes('web_search'))
  assert.equal(result.loadedToolNames.length, 0)
})

test('tool_search can find and load deferred MCP tools', async () => {
  const registry = createToolRegistry({
    mcpTools: [
      {
        source: 'mcp',
        capabilityId: 'context7',
        capabilityName: 'context7',
        name: 'mcp__context7__get-library-docs',
        description: '[MCP:context7] Get library documentation',
        deferLoading: true,
        discoverable: true,
        async run() {
          return 'ok'
        },
      },
    ],
  })

  const router = createToolRouter(registry, {
    workspaceRelated: true,
  })

  const visibleToolNames = router.modelVisibleTools.map(tool => tool.name)
  assert.ok(visibleToolNames.includes('tool_search'))
  assert.equal(visibleToolNames.includes('mcp__context7__get-library-docs'), false)

  const toolSearch = router.modelVisibleTools.find(tool => tool.name === 'tool_search')
  const registeredTools = []
  const result = await toolSearch.run(
    {
      query: 'context7 library docs',
    },
    {
      registerTools(nextTools) {
        registeredTools.push(...nextTools)
      },
    },
  )

  assert.equal(result.noResults, false)
  assert.ok(result.loadedToolNames.includes('mcp__context7__get-library-docs'))
  assert.equal(registeredTools.length, 1)
  assert.equal(registeredTools[0].name, 'mcp__context7__get-library-docs')
})
