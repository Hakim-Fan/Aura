import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdvancedTools } from './advancedTools.mjs'

test('createAdvancedTools omits macOS-only computer tools on Windows', () => {
  const tools = createAdvancedTools({
    platform: 'win32',
    settings: {
      enableComputerUse: true,
      enableMultiAgent: false,
      browser: {
        interactive: {
          enabled: true,
        },
      },
    },
    context: {
      cwd: process.cwd(),
    },
    runtimeMeta: {},
  })

  assert.equal(tools.some(tool => tool.name.startsWith('computer_')), false)
  assert.equal(tools.some(tool => tool.name === 'system_browser_open'), true)
})
