import test from 'node:test'
import assert from 'node:assert/strict'
import { createUnifiedExecRuntime } from './unifiedExecRuntime.mjs'

test('unifiedExecRuntime supports interactive stdin writes and closes the session cleanly', async () => {
  const runtime = createUnifiedExecRuntime()
  try {
    const first = await runtime.execCommand({
      cmd: "printf 'ready\\n'; cat",
      cwd: process.cwd(),
      login: false,
      yieldTimeMs: 100,
    })

    assert.equal(first.running, true)
    assert.match(first.output, /ready/)

    const second = await runtime.writeStdin({
      sessionId: first.sessionId,
      chars: 'hello from stdin\n',
      closeStdin: true,
      yieldTimeMs: 100,
    })

    assert.equal(second.running, false)
    assert.equal(second.exitCode, 0)
    assert.match(second.output, /hello from stdin/)
  } finally {
    await runtime.closeAllSessions()
  }
})

test('unifiedExecRuntime can terminate a running session with an explicit signal', async () => {
  const runtime = createUnifiedExecRuntime()
  try {
    const first = await runtime.execCommand({
      cmd: 'sleep 30',
      cwd: process.cwd(),
      login: false,
      yieldTimeMs: 50,
    })

    assert.equal(first.running, true)

    const second = await runtime.writeStdin({
      sessionId: first.sessionId,
      terminate: true,
      signal: 'SIGTERM',
      yieldTimeMs: 50,
    })

    assert.equal(second.running, false)
    assert.equal(second.status, 'terminated')
    assert.equal(second.terminationReason, 'signal:SIGTERM')
  } finally {
    await runtime.closeAllSessions()
  }
})

test('unifiedExecRuntime rejects unsupported tty requests', async () => {
  const runtime = createUnifiedExecRuntime()
  try {
    await assert.rejects(
      runtime.execCommand({
        cmd: 'echo hello',
        cwd: process.cwd(),
        login: false,
        tty: true,
      }),
      /TTY/,
    )
  } finally {
    await runtime.closeAllSessions()
  }
})
