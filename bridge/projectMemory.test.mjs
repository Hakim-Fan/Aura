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

test('project_memory_organizer reads pending DB sources instead of transient messages', async () => {
  const cwd = await makeWorkspace()
  const finished = []
  const hooks = {
    async appControl(action, payload) {
      if (action === 'start_project_memory_job') {
        assert.equal(payload.workspaceRoot, cwd)
        return {
          job: {
            id: 'job-db-sources',
            workspaceRoot: cwd,
            status: 'running',
            reason: payload.reason,
            inputWatermark: 123,
          },
          sources: [
            {
              id: 'source-1',
              sourceType: 'message',
              sourceId: 'message-1',
              sourceVersion: '0',
              memoryStatus: 'pending',
              detail: {
                role: 'user',
                content: '数据库 source：项目记忆整理不要使用 work_memory。',
              },
            },
          ],
        }
      }
      if (action === 'finish_project_memory_job') {
        finished.push(payload)
        return { status: payload.status, sourceStatus: payload.sourceStatus }
      }
      throw new Error(`unexpected appControl action: ${action}`)
    },
  }
  const runNestedAgent = async request => {
    const prompt = request.messages[0].content
    assert.match(prompt, /数据库 source：项目记忆整理不要使用 work_memory/u)
    assert.doesNotMatch(prompt, /这段临时 messages 不该出现/u)
    return {
      message: JSON.stringify({
        project: '记忆整理来源改为 project_memory_sources。',
        decisions: '',
        troubleshooting: '',
        preferences: '',
        session_title: 'DB sources',
        session_summary: 'organizer 从 DB source 整理。',
      }),
    }
  }

  const result = await updateProjectMemoryNow({
    settings: settingsFor(cwd),
    messages: [{ role: 'user', content: '这段临时 messages 不该出现' }],
    sessionId: 'session-1',
    hooks,
    runNestedAgent,
  })

  assert.equal(result.status, 'updated')
  assert.equal(result.sourceCount, 1)
  assert.equal(finished.at(-1)?.sourceStatus, 'consolidated')
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
