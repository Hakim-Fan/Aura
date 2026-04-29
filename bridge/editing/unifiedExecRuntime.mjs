import { spawn } from 'node:child_process'
import { buildShellEnv } from '../shellEnv.mjs'
import { createStructuredError } from '../runtimeErrors.mjs'
import { truncate } from '../utils.mjs'

const DEFAULT_SHELL = '/bin/zsh'
const DEFAULT_YIELD_TIME_MS = 1_000
const DEFAULT_MAX_OUTPUT_CHARS = 12_000
const MAX_SESSION_BUFFER_CHARS = 200_000
const IDLE_TERMINATION_MS = 5 * 60_000
const TERMINATION_SIGNALS = new Set([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
])

function clampPositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function joinOutput(stdout, stderr) {
  return [stdout, stderr].filter(Boolean).join('\n\n')
}

function trimBufferWithCursor(buffer, cursor, maxChars = MAX_SESSION_BUFFER_CHARS) {
  if (buffer.length <= maxChars) {
    return {
      buffer,
      cursor,
    }
  }

  const overflow = buffer.length - maxChars
  return {
    buffer: buffer.slice(overflow),
    cursor: Math.max(0, cursor - overflow),
  }
}

function buildShellArgs(command, login) {
  return [login === false ? '-c' : '-lc', command]
}

function buildSessionError(message, detail, code = 'EXEC_SESSION_ERROR') {
  return createStructuredError(message, {
    source: 'tool',
    category: 'execution_failed',
    code,
    detail,
    retryable: true,
  })
}

function normalizeTerminationSignal(value) {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return TERMINATION_SIGNALS.has(normalized) ? normalized : 'SIGTERM'
}

function collectOutputSlice(session, stdoutCursor, stderrCursor, maxOutputChars) {
  const stdout = session.stdout.slice(stdoutCursor)
  const stderr = session.stderr.slice(stderrCursor)
  const output = joinOutput(stdout, stderr)
  const limit = clampPositiveInteger(
    maxOutputChars,
    DEFAULT_MAX_OUTPUT_CHARS,
    256,
    MAX_SESSION_BUFFER_CHARS,
  )

  return {
    stdout: truncate(stdout, limit),
    stderr: truncate(stderr, limit),
    output: truncate(output, limit),
    truncated: output.length > limit || stdout.length > limit || stderr.length > limit,
    nextStdoutCursor: session.stdout.length,
    nextStderrCursor: session.stderr.length,
  }
}

function createExitWaiter(session, signal) {
  if (!session.running) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const onExit = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      session.exitListeners.delete(onExit)
      reject(new Error('Command observation was aborted.'))
    }

    session.exitListeners.add(onExit)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createDelayWaiter(timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, timeoutMs)

    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Command observation was aborted.'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function touchSession(session) {
  session.lastActivityAt = Date.now()
}

function emitSessionActivity(session) {
  for (const listener of session.activityListeners) {
    try {
      listener()
    } catch {
      // Ignore observer failures so command execution itself can continue.
    }
  }
}

function emitSessionExit(session) {
  for (const listener of session.exitListeners) {
    try {
      listener()
    } catch {
      // Ignore waiter cleanup failures.
    }
  }
  session.exitListeners.clear()
}

function clearSessionTimers(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
  if (session.commandTimeoutTimer) {
    clearTimeout(session.commandTimeoutTimer)
    session.commandTimeoutTimer = null
  }
  if (session.forceKillTimer) {
    clearTimeout(session.forceKillTimer)
    session.forceKillTimer = null
  }
}

function terminateProcess(session, signal = 'SIGTERM', reason = `signal:${signal}`) {
  if (!session.running) {
    return false
  }

  session.terminationReason = reason
  try {
    session.child.kill(signal)
  } catch {
    return false
  }

  if (signal !== 'SIGKILL') {
    if (session.forceKillTimer) {
      clearTimeout(session.forceKillTimer)
    }
    session.forceKillTimer = setTimeout(() => {
      if (session.running) {
        try {
          session.child.kill('SIGKILL')
        } catch {
          // Ignore late force-kill failures during shutdown.
        }
      }
    }, 1_500)
  }

  return true
}

function scheduleIdleTermination(session, disposeSession) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
  }

  session.idleTimer = setTimeout(() => {
    if (!session.running) {
      disposeSession(session.id)
      return
    }

    terminateProcess(session, 'SIGTERM', 'idle_timeout')
  }, IDLE_TERMINATION_MS)
}

function scheduleCommandTimeout(session) {
  if (session.commandTimeoutTimer) {
    clearTimeout(session.commandTimeoutTimer)
    session.commandTimeoutTimer = null
  }

  if (!session.running || !Number.isFinite(session.commandTimeoutMs) || session.commandTimeoutMs <= 0) {
    return
  }

  session.commandTimeoutTimer = setTimeout(() => {
    if (!session.running) {
      return
    }
    session.timedOut = true
    terminateProcess(session, 'SIGTERM', 'timeout')
  }, session.commandTimeoutMs)
}

export function createUnifiedExecRuntime({ shell = DEFAULT_SHELL } = {}) {
  let nextSessionId = 1
  const sessions = new Map()

  function disposeSession(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) {
      return
    }

    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
    }
    sessions.delete(sessionId)
  }

  function getSession(sessionId) {
    const numericId = clampPositiveInteger(sessionId, NaN)
    if (!Number.isFinite(numericId)) {
      throw buildSessionError('命令会话 id 无效。', `Invalid session id: ${sessionId}`, 'EXEC_INVALID_SESSION')
    }

    const session = sessions.get(numericId)
    if (!session) {
      throw buildSessionError(
        `找不到命令会话 ${numericId}。`,
        `Unknown exec session: ${numericId}`,
        'EXEC_UNKNOWN_SESSION',
      )
    }
    return session
  }

  function appendOutput(session, key, chunk) {
    const text = chunk.toString()
    const nextBuffer = `${session[key]}${text}`
    const cursorKey = key === 'stdout' ? 'stdoutCursor' : 'stderrCursor'
    const trimmed = trimBufferWithCursor(nextBuffer, session[cursorKey], MAX_SESSION_BUFFER_CHARS)
    session[key] = trimmed.buffer
    session[cursorKey] = trimmed.cursor
    touchSession(session)
    scheduleIdleTermination(session, disposeSession)
    emitSessionActivity(session)
  }

  function createStreamingObserver(session, onUpdate, maxOutputChars) {
    if (typeof onUpdate !== 'function') {
      return () => {}
    }

    let stdoutCursor = session.stdoutCursor
    let stderrCursor = session.stderrCursor

    const listener = () => {
      const slice = collectOutputSlice(session, stdoutCursor, stderrCursor, maxOutputChars)
      stdoutCursor = slice.nextStdoutCursor
      stderrCursor = slice.nextStderrCursor
      if (slice.output) {
        onUpdate(slice.output)
      }
    }

    session.activityListeners.add(listener)
    return () => {
      session.activityListeners.delete(listener)
    }
  }

  async function waitForYieldOrExit(session, yieldTimeMs, signal) {
    if (!session.running) {
      return
    }

    const waitMs = clampPositiveInteger(yieldTimeMs, DEFAULT_YIELD_TIME_MS, 50, 60_000)
    await Promise.race([
      createDelayWaiter(waitMs, signal),
      createExitWaiter(session, signal),
    ])
  }

  function buildStructuredResult(session, maxOutputChars) {
    const slice = collectOutputSlice(
      session,
      session.stdoutCursor,
      session.stderrCursor,
      maxOutputChars,
    )
    session.stdoutCursor = slice.nextStdoutCursor
    session.stderrCursor = slice.nextStderrCursor
    touchSession(session)
    scheduleIdleTermination(session, disposeSession)

    return {
      sessionId: session.id,
      status: session.spawnError
        ? 'spawn_failed'
        : session.running
          ? 'running'
          : session.timedOut
            ? 'timed_out'
            : session.terminationReason &&
                session.terminationReason !== 'session_shutdown'
              ? 'terminated'
              : 'exited',
      running: session.running,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      stdout: slice.stdout,
      stderr: slice.stderr,
      output: slice.output,
      truncated: slice.truncated,
      wallTimeMs: Date.now() - session.startedAt,
      command: session.command,
      cwd: session.cwd,
      pid: session.pid,
      tty: false,
      stdinClosed: session.stdinClosed === true,
      timedOut: session.timedOut === true,
      terminationReason: session.terminationReason || '',
    }
  }

  async function execCommand(
    {
      cmd,
      cwd,
      login,
      tty = false,
      yieldTimeMs = DEFAULT_YIELD_TIME_MS,
      maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
      timeoutMs = 0,
    },
    runtime = {},
  ) {
    const command = typeof cmd === 'string' ? cmd.trim() : ''
    if (!command) {
      throw new Error('exec_command.cmd must not be empty.')
    }
    if (tty === true) {
      throw buildSessionError(
        '当前长会话命令执行暂不支持 TTY 模式。',
        'TTY mode is not implemented in unifiedExecRuntime yet.',
        'EXEC_TTY_UNSUPPORTED',
      )
    }

    const child = spawn(shell, buildShellArgs(command, login), {
      cwd,
      env: buildShellEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const session = {
      id: nextSessionId++,
      child,
      command,
      cwd,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      pid: typeof child.pid === 'number' ? child.pid : null,
      stdout: '',
      stderr: '',
      stdoutCursor: 0,
      stderrCursor: 0,
      running: true,
      exitCode: null,
      exitSignal: null,
      spawnError: null,
      stdinClosed: false,
      timedOut: false,
      terminationReason: '',
      commandTimeoutMs: clampPositiveInteger(timeoutMs, 0, 0, 24 * 60 * 60_000),
      activityListeners: new Set(),
      exitListeners: new Set(),
      idleTimer: null,
      commandTimeoutTimer: null,
      forceKillTimer: null,
    }

    sessions.set(session.id, session)
    scheduleIdleTermination(session, disposeSession)
    scheduleCommandTimeout(session)

    child.stdout.on('data', chunk => appendOutput(session, 'stdout', chunk))
    child.stderr.on('data', chunk => appendOutput(session, 'stderr', chunk))
    child.on('error', error => {
      session.spawnError = error
      session.running = false
      session.stdinClosed = true
      clearSessionTimers(session)
      touchSession(session)
      emitSessionActivity(session)
      emitSessionExit(session)
    })
    child.on('close', (code, signal) => {
      session.running = false
      session.exitCode = typeof code === 'number' ? code : null
      session.exitSignal = typeof signal === 'string' ? signal : null
      session.stdinClosed = true
      clearSessionTimers(session)
      if (!session.terminationReason && session.exitSignal) {
        session.terminationReason = `signal:${session.exitSignal}`
      }
      touchSession(session)
      emitSessionActivity(session)
      emitSessionExit(session)
      scheduleIdleTermination(session, disposeSession)
    })

    const detachObserver = createStreamingObserver(session, runtime.onUpdate, maxOutputChars)
    try {
      await waitForYieldOrExit(session, yieldTimeMs, runtime.signal)
    } finally {
      detachObserver()
    }

    if (session.spawnError) {
      disposeSession(session.id)
      throw session.spawnError
    }

    return buildStructuredResult(session, maxOutputChars)
  }

  async function writeStdin(
    {
      sessionId,
      chars = '',
      yieldTimeMs = DEFAULT_YIELD_TIME_MS,
      maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
      closeStdin = false,
      terminate = false,
      signal,
    },
    runtime = {},
  ) {
    const session = getSession(sessionId)
    const terminationSignal = normalizeTerminationSignal(signal)

    if (typeof chars === 'string' && chars.length > 0) {
      if (
        !session.running ||
        session.stdinClosed === true ||
        !session.child.stdin ||
        session.child.stdin.destroyed
      ) {
        throw buildSessionError(
          `命令会话 ${session.id} 已经结束，无法继续写入 stdin。`,
          `Session ${session.id} is not writable.`,
          'EXEC_SESSION_NOT_WRITABLE',
        )
      }

      await new Promise((resolve, reject) => {
        session.child.stdin.write(chars, error => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
      touchSession(session)
      scheduleIdleTermination(session, disposeSession)
    }

    if (closeStdin === true && session.running && session.stdinClosed !== true) {
      await new Promise((resolve, reject) => {
        session.child.stdin.end(error => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
      session.stdinClosed = true
      touchSession(session)
      scheduleIdleTermination(session, disposeSession)
    }

    if (terminate === true) {
      terminateProcess(session, terminationSignal, `signal:${terminationSignal}`)
      touchSession(session)
      scheduleIdleTermination(session, disposeSession)
    }

    const detachObserver = createStreamingObserver(session, runtime.onUpdate, maxOutputChars)
    try {
      await waitForYieldOrExit(session, yieldTimeMs, runtime.signal)
    } finally {
      detachObserver()
    }

    if (session.spawnError) {
      disposeSession(session.id)
      throw session.spawnError
    }

    return buildStructuredResult(session, maxOutputChars)
  }

  async function closeAllSessions() {
    for (const session of sessions.values()) {
      clearSessionTimers(session)
      if (session.running) {
        terminateProcess(session, 'SIGTERM', 'session_shutdown')
      }
    }
    sessions.clear()
  }

  return {
    execCommand,
    writeStdin,
    closeAllSessions,
  }
}
