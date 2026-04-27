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
    answerMode: 'advise',
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
    answerMode: 'advise',
    workspaceRelated: false,
  })

  const visibleToolNames = router.modelVisibleTools.map(tool => tool.name)

  assert.ok(visibleToolNames.includes('apply_patch'))
  assert.ok(visibleToolNames.includes('write_file'))
  assert.ok(visibleToolNames.includes('exec_command'))
})

test('tool_search can find already-mounted direct tools', async () => {
  const registry = createToolRegistry({
    builtinTools: [
      buildTool('read_file'),
      buildTool('web_search'),
    ],
  })

  const router = createToolRouter(registry, {
    answerMode: 'advise',
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
