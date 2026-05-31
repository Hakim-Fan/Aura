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

test('createAdvancedTools exposes Claude-style spawn_agent when multi-agent is enabled', () => {
  const baseOptions = {
    platform: 'darwin',
    context: {
      cwd: process.cwd(),
    },
    runtimeMeta: {},
  }

  const disabledTools = createAdvancedTools({
    ...baseOptions,
    settings: {
      enableMultiAgent: false,
    },
  })

  const enabledTools = createAdvancedTools({
    ...baseOptions,
    settings: {
      enableMultiAgent: true,
    },
  })

  const nestedTools = createAdvancedTools({
    ...baseOptions,
    settings: {
      enableMultiAgent: true,
    },
    runtimeMeta: {
      subagentDepth: 1,
    },
  })

  assert.equal(disabledTools.some(tool => tool.name === 'spawn_agent'), false)
  assert.equal(enabledTools.some(tool => tool.name === 'spawn_agent'), true)
  assert.equal(nestedTools.some(tool => tool.name === 'spawn_agent'), false)
  assert.match(
    enabledTools.find(tool => tool.name === 'spawn_agent')?.description || '',
    /verification/i,
  )
})

test('spawn_agent runs a role-scoped nested agent', async () => {
  const calls = []
  const tools = createAdvancedTools({
    platform: 'darwin',
    settings: {
      enableMultiAgent: true,
    },
    context: {
      cwd: process.cwd(),
    },
    runtimeMeta: {
      currentTaskId: 'parent-task',
      executionStepIds: ['step-1'],
    },
    taskTracker: {
      createChildTask(input) {
        calls.push({ type: 'task', input })
        return { id: 'child-task' }
      },
      completeTask(input) {
        calls.push({ type: 'complete', input })
      },
    },
    runNestedAgent: async input => {
      calls.push({ type: 'nested', input })
      return {
        status: 'completed',
        message: 'Found the relevant files.',
        toolEvents: [
          {
            id: 'tool-1',
            name: 'read_file',
            source: 'builtin',
            status: 'success',
            summary: 'Read package.json',
          },
        ],
      }
    },
  })

  const spawnAgent = tools.find(tool => tool.name === 'spawn_agent')
  assert.ok(spawnAgent)

  const output = await spawnAgent.run({
    message: 'Find where plugin tools are mounted.',
    task_name: 'inspect_plugin_mounting',
    agent_type: 'explorer',
  })
  const parsed = JSON.parse(output)

  assert.equal(parsed.agent_id, 'child-task')
  assert.equal(parsed.task_name, 'inspect_plugin_mounting')
  assert.equal(parsed.agent_type, 'explorer')
  assert.equal(parsed.agent_status, 'completed')
  assert.equal(parsed.toolEvents.length, 1)

  const nestedCall = calls.find(call => call.type === 'nested')
  assert.equal(nestedCall.input.runtime.subagentDepth, 1)
  assert.equal(nestedCall.input.runtime.subagentRole, 'explorer')
  assert.equal(nestedCall.input.settings.enableMultiAgent, false)
  assert.equal(
    nestedCall.input.messages[0].content.includes('Do not write, edit, patch'),
    true,
  )
})

test('spawn_agent accepts Claude AgentTool aliases', async () => {
  const calls = []
  const tools = createAdvancedTools({
    platform: 'darwin',
    settings: {
      enableMultiAgent: true,
      model: 'parent-model',
    },
    context: {
      cwd: process.cwd(),
    },
    runtimeMeta: {},
    runNestedAgent: async input => {
      calls.push(input)
      return {
        status: 'completed',
        message: 'Inspected the requested area.',
      }
    },
  })

  const spawnAgent = tools.find(tool => tool.name === 'spawn_agent')
  assert.ok(spawnAgent)

  const output = await spawnAgent.run({
    description: 'inspect_runtime_loop',
    prompt: 'Inspect how the runtime loop delegates tools.',
    subagent_type: 'Explore',
  })
  const parsed = JSON.parse(output)

  assert.equal(parsed.task_name, 'inspect_runtime_loop')
  assert.equal(parsed.agent_type, 'explorer')
  assert.equal(calls[0].runtime.subagentRole, 'explorer')
  assert.match(calls[0].messages[0].content, /Canonical task name: inspect_runtime_loop/)
  assert.match(calls[0].messages[0].content, /Inspect how the runtime loop delegates tools/)
})

test('spawn_agent rejects legacy verifier agent type', async () => {
  const tools = createAdvancedTools({
    platform: 'darwin',
    settings: {
      enableMultiAgent: true,
    },
    context: {
      cwd: process.cwd(),
    },
    runtimeMeta: {},
    runNestedAgent: async () => ({ status: 'completed', message: 'unused' }),
  })

  const spawnAgent = tools.find(tool => tool.name === 'spawn_agent')
  assert.ok(spawnAgent)

  await assert.rejects(
    () => spawnAgent.run({
      message: 'Verify the task.',
      task_name: 'verify_task',
      agent_type: 'verifier',
    }),
    error => error?.code === 'UNKNOWN_AGENT_TYPE',
  )
})
