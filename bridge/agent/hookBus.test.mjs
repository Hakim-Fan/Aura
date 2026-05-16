import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentHookEvent,
  createAgentHookBus,
  invokeAgentHook,
} from './hookBus.mjs'

test('createAgentHookBus invokes matching handlers and supports blocking', async () => {
  const calls = []
  const hookBus = createAgentHookBus({
    handlers: [
      {
        event: AgentHookEvent.PreToolUse,
        handle({ payload }) {
          calls.push(payload.tool.name)
          return {
            blocked: true,
            code: 'BLOCKED_BY_TEST',
            reason: 'blocked for test',
          }
        },
      },
    ],
  })

  const result = await hookBus.invoke(AgentHookEvent.PreToolUse, {
    tool: { name: 'write_file' },
  })

  assert.deepEqual(calls, ['write_file'])
  assert.equal(result.blocked, true)
  assert.equal(result.code, 'BLOCKED_BY_TEST')
  assert.equal(result.reason, 'blocked for test')
})

test('invokeAgentHook emits diagnostics and ignores thrown hook errors', async () => {
  const diagnostics = []
  const result = await invokeAgentHook(
    {
      async onAgentHook() {
        throw new Error('hook failed')
      },
      onAgentHookEvent(event) {
        diagnostics.push(event)
      },
    },
    AgentHookEvent.PostToolUse,
    {
      toolEventId: 'tool-1',
      tool: { name: 'read_file' },
    },
  )

  assert.equal(result.blocked, false)
  assert.equal(diagnostics.length, 2)
  assert.equal(diagnostics[0].status, 'started')
  assert.equal(diagnostics[1].status, 'error')
  assert.equal(diagnostics[1].toolName, 'read_file')
})
