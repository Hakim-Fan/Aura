import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createProjectMemoryRuntime,
  startProjectMemoryUpdateAgent,
  updateProjectMemoryNow,
} from './projectMemory.mjs'

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aura-project-memory-'))
}

function settingsFor(cwd) {
  return {
    cwd,
    locale: 'zh-CN',
    projectMemory: {
      enabled: true,
      disabledWorkspaceRoots: [],
      idleUpdateThresholdHours: 4,
      providerProfileId: '',
      model: '',
    },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('project_memory_retriever result can be drained by a later runtime without blocking', async () => {
  const cwd = await makeWorkspace()
  const agentResult = deferred()
  let agentStarted
  const started = new Promise(resolve => {
    agentStarted = resolve
  })
  const runNestedAgent = async request => {
    assert.equal(request.runtime.subagentRole, 'project_memory_retriever')
    agentStarted()
    return agentResult.promise
  }

  const firstRuntime = createProjectMemoryRuntime({
    settings: settingsFor(cwd),
    messages: [{ role: 'user', content: '继续之前的鉴权设计' }],
    runNestedAgent,
    scopeId: 'session-1',
  })

  const entry = firstRuntime.startLookup({ query: '鉴权设计' })
  assert.equal(entry.status, 'pending')
  assert.equal(firstRuntime.drainReadyContext(), '')

  await started
  agentResult.resolve({
    message: '<project_memory>鉴权模块使用 provider route 做隔离。</project_memory>',
  })
  await entry.promise

  const secondRuntime = createProjectMemoryRuntime({
    settings: settingsFor(cwd),
    messages: [{ role: 'user', content: '继续之前的鉴权设计' }],
    runNestedAgent,
    scopeId: 'session-1',
  })

  const drained = secondRuntime.drainReadyContext()
  assert.match(drained, /鉴权模块使用 provider route 做隔离/u)
  assert.equal(secondRuntime.drainReadyContext(), '')

  const restarted = secondRuntime.startLookup({ query: '鉴权设计' })
  assert.notEqual(restarted.memoryTaskId, entry.memoryTaskId)
})

test('project memory retrieval dedupes pending requests in the same session scope', async () => {
  const cwd = await makeWorkspace()
  let calls = 0
  let agentStarted
  const started = new Promise(resolve => {
    agentStarted = resolve
  })
  const never = new Promise(() => {})
  const runtime = createProjectMemoryRuntime({
    settings: settingsFor(cwd),
    messages: [{ role: 'user', content: '查一下之前的记忆' }],
    runNestedAgent: async () => {
      calls += 1
      agentStarted()
      return never
    },
    scopeId: 'session-dedupe',
  })

  const first = runtime.startLookup({ query: '项目记忆' })
  const second = runtime.startLookup({ query: '项目记忆' })

  assert.equal(second.memoryTaskId, first.memoryTaskId)
  await started
  assert.equal(calls, 1)
})

test('project_memory_organizer writes are serialized so concurrent updates preserve both sections', async () => {
  const cwd = await makeWorkspace()
  let callIndex = 0
  const runNestedAgent = async request => {
    assert.equal(request.runtime.subagentRole, 'project_memory_organizer')
    callIndex += 1
    return {
      message: JSON.stringify({
        project: `第 ${callIndex} 次整理`,
        decisions: '',
        troubleshooting: '',
        preferences: '',
        session_title: `整理 ${callIndex}`,
        session_summary: `阶段总结 ${callIndex}`,
      }),
    }
  }

  await Promise.all([
    updateProjectMemoryNow({
      settings: settingsFor(cwd),
      messages: [{ role: 'user', content: '记录项目记忆 A' }],
      notes: 'A',
      runNestedAgent,
    }),
    updateProjectMemoryNow({
      settings: settingsFor(cwd),
      messages: [{ role: 'user', content: '记录项目记忆 B' }],
      notes: 'B',
      runNestedAgent,
    }),
  ])

  const projectMemory = await fs.readFile(path.join(cwd, '.aura', 'memory', 'project.md'), 'utf8')
  assert.match(projectMemory, /第 1 次整理/u)
  assert.match(projectMemory, /第 2 次整理/u)
})

test('project_memory_organizer scheduled updates dedupe identical pending work', async () => {
  const cwd = await makeWorkspace()
  const pending = new Promise(() => {})
  const first = startProjectMemoryUpdateAgent({
    settings: settingsFor(cwd),
    notes: '同一条记忆',
    runNestedAgent: async () => pending,
  })
  const second = startProjectMemoryUpdateAgent({
    settings: settingsFor(cwd),
    notes: '同一条记忆',
    runNestedAgent: async () => pending,
  })

  assert.equal(first.status, 'scheduled')
  assert.equal(second.status, 'scheduled')
  assert.equal(second.deduped, true)
  assert.equal(second.memoryTaskId, first.memoryTaskId)
})
