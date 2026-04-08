import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  formatToolError,
  resolveWorkspacePath,
  stringifyOutput,
  truncate,
} from './utils.mjs'
import { createStructuredError, normalizeRuntimeError } from './runtimeErrors.mjs'

const execFileAsync = promisify(execFile)

async function walkDirectory(dirPath, maxDepth, currentDepth = 0) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const lines = []

  for (const entry of entries.slice(0, 80)) {
    const entryPath = path.join(dirPath, entry.name)
    lines.push(
      `${'  '.repeat(currentDepth)}${entry.isDirectory() ? 'dir ' : 'file'} ${path.basename(entryPath)}`,
    )

    if (entry.isDirectory() && currentDepth < maxDepth) {
      lines.push(...(await walkDirectory(entryPath, maxDepth, currentDepth + 1)))
    }
  }

  return lines
}

function shouldSkipSearchEntry(name) {
  return (
    name === '.git' ||
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'target' ||
    name === '.next' ||
    name === '.turbo'
  )
}

async function runShell(command, cwd, timeoutMs = 60_000) {
  return runShellStreaming(command, cwd, timeoutMs)
}

function buildStepCancelledError(tool) {
  return createStructuredError('这一步已被用户主动停止。', {
    source:
      tool?.source === 'plugin'
        ? 'plugin'
        : tool?.source === 'mcp'
          ? 'mcp'
          : 'tool',
    category: 'cancelled',
    code: 'STEP_CANCELLED',
    detail: `Tool step cancelled: ${tool?.name || 'unknown'}`,
    suggestedAction: 'Aura 已停止当前步骤，你可以继续补充要求或等待下一步规划。',
  })
}

function throwIfAborted(signal, tool) {
  if (!signal?.aborted) {
    return
  }
  throw buildStepCancelledError(tool)
}

function waitForAbort(signal, tool) {
  if (!signal) {
    return new Promise(() => {})
  }

  if (signal.aborted) {
    return Promise.reject(buildStepCancelledError(tool))
  }

  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(buildStepCancelledError(tool)),
      { once: true },
    )
  })
}

async function runAbortable(promise, signal, tool) {
  if (!signal) {
    return promise
  }
  return Promise.race([promise, waitForAbort(signal, tool)])
}

async function runShellStreaming(
  command,
  cwd,
  timeoutMs = 60_000,
  onUpdate,
  signal,
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(buildStepCancelledError({ source: 'builtin', name: 'run_shell' }))
      return
    }

    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let flushTimer = null

    function flush() {
      flushTimer = null
      onUpdate?.(
        truncate(
          [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n') ||
            'Command is running...',
        ),
      )
    }

    function scheduleFlush() {
      if (flushTimer !== null) {
        return
      }
      flushTimer = setTimeout(flush, 60)
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Shell command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const handleAbort = () => {
      clearTimeout(timer)
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
      }
      child.kill('SIGTERM')
      reject(buildStepCancelledError({ source: 'builtin', name: 'run_shell' }))
    }
    signal?.addEventListener('abort', handleAbort, { once: true })

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      scheduleFlush()
    })

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
      scheduleFlush()
    })

    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
      }
      signal?.removeEventListener('abort', handleAbort)
      flush()
      if (code === 0) {
        resolve(
          truncate(
            [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n') ||
              'Command completed with no output',
          ),
        )
        return
      }

      reject(
        new Error(
          `Command exited with code ${code}\n\n${truncate(stderr || stdout)}`,
        ),
      )
    })
  })
}

function detectBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048))
  let suspicious = 0

  for (const byte of sample) {
    if (byte === 0) {
      return true
    }
    if ((byte < 7 || (byte > 14 && byte < 32)) && byte !== 9 && byte !== 10 && byte !== 13) {
      suspicious += 1
    }
  }

  return sample.length > 0 && suspicious / sample.length > 0.15
}

function readPngDimensions(buffer) {
  if (buffer.length < 24) {
    return null
  }
  const signature = '89504e470d0a1a0a'
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    return null
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function summarizeBinaryFile(target, buffer) {
  const extension = path.extname(target).slice(1).toLowerCase() || 'unknown'
  const size = buffer.byteLength
  const pngDimensions = readPngDimensions(buffer)
  const details = [
    `Binary file detected: ${path.basename(target)}`,
    `Type: ${extension.toUpperCase()}`,
    `Size: ${size} bytes`,
  ]

  if (pngDimensions) {
    details.push(`Dimensions: ${pngDimensions.width} x ${pngDimensions.height}`)
  }

  details.push(
    'This tool only previews text safely. For images, rely on visual input or use a dedicated metadata/image tool instead of reading raw bytes as text.',
  )
  return details.join('\n')
}

async function collectSearchMatches(rootPath, query, baseCwd, matches = [], signal) {
  if (signal?.aborted) {
    throw buildStepCancelledError({ source: 'builtin', name: 'search_code' })
  }
  const entries = await fs.readdir(rootPath, { withFileTypes: true })

  for (const entry of entries) {
    if (shouldSkipSearchEntry(entry.name)) {
      continue
    }

    const entryPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      await collectSearchMatches(entryPath, query, baseCwd, matches, signal)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    let content
    try {
      content = await fs.readFile(entryPath)
    } catch {
      continue
    }

    if (detectBinary(content)) {
      continue
    }

    const text = content.toString('utf8')
    const lines = text.split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(query)) {
        continue
      }
      matches.push(
        `${path.relative(baseCwd, entryPath) || path.basename(entryPath)}:${index + 1}:${lines[index]}`,
      )
      if (matches.length >= 200) {
        return matches
      }
    }
  }

  return matches
}

async function searchWorkspace(query, target, cwd, signal) {
  try {
    const { stdout } = await execFileAsync(
      'rg',
      [
        '-n',
        '--hidden',
        '--glob',
        '!node_modules',
        '--glob',
        '!.git',
        query,
        target,
      ],
      {
        cwd,
        maxBuffer: 1024 * 1024,
        signal,
      },
    )
    return truncate(stdout || 'No matches found')
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      const matches = await collectSearchMatches(target, query, cwd, [], signal)
      return truncate(matches.join('\n') || 'No matches found')
    }
    throw error
  }
}

export function createBuiltinTools(context) {
  return [
    {
      source: 'builtin',
      name: 'list_files',
      description: 'List files and directories inside the current workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path inside the workspace.',
          },
          depth: {
            type: 'number',
            description: 'Maximum recursion depth.',
          },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path || '.')
        const lines = await walkDirectory(target, Math.min(args.depth ?? 2, 4))
        return truncate(lines.join('\n') || '(empty directory)')
      },
    },
    {
      source: 'builtin',
      name: 'read_file',
      description: 'Read a text file from inside the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside the workspace.',
          },
        },
        required: ['path'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path)
        const content = await fs.readFile(target)
        if (detectBinary(content)) {
          return summarizeBinaryFile(target, content)
        }
        return truncate(content.toString('utf8'))
      },
    },
    {
      source: 'builtin',
      name: 'write_file',
      approvalCategory: 'file_write',
      description:
        'Write a text file inside the workspace. Overwrites the file if it already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside the workspace.',
          },
          content: {
            type: 'string',
            description: 'Full text content to write.',
          },
        },
        required: ['path', 'content'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, args.content, 'utf8')
        return `Wrote ${args.content.length} characters to ${target}`
      },
    },
    {
      source: 'builtin',
      name: 'search_code',
      description:
        'Search the workspace using ripgrep. Good for finding symbols, text, or patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query for ripgrep.',
          },
          path: {
            type: 'string',
            description: 'Optional relative path inside the workspace.',
          },
        },
        required: ['query'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path || '.')
        return searchWorkspace(args.query, target, context.cwd, runtime.signal)
      },
    },
    {
      source: 'builtin',
      name: 'run_shell',
      approvalCategory: 'shell',
      description:
        'Run a shell command inside the workspace. Use carefully and keep commands focused.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Optional timeout in milliseconds.',
          },
        },
        required: ['command'],
      },
      liveUpdates: true,
      async run(args, runtime = {}) {
        return runShellStreaming(
          args.command,
          context.cwd,
          args.timeoutMs ?? 60_000,
          output => runtime.onUpdate?.(output),
          runtime.signal,
        )
      },
    },
  ]
}

function isAutoApproved(tool, settings) {
  switch (tool.approvalCategory) {
    case 'shell':
      return settings.autoApproveShell
    case 'file_write':
      return settings.autoApproveFileWrite
    case 'computer_use':
      return settings.autoApproveComputerUse
    case 'chrome_automation':
      return settings.autoApproveChromeAutomation
    default:
      return true
  }
}

function emitToolEvent(event, toolEvents, hooks) {
  const index = toolEvents.findIndex(entry => entry.id === event.id)
  if (index >= 0) {
    toolEvents[index] = event
  } else {
    toolEvents.push(event)
  }
  hooks?.onToolEvent?.(event)
}

export async function invokeTool(tool, args, toolEvents, hooks = {}) {
  const eventId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const baseEvent = {
    id: eventId,
    source: tool.source,
    name: tool.name,
    summary: tool.description,
    order:
      typeof hooks.timelineOrder === 'number'
        ? hooks.timelineOrder
        : undefined,
    input:
      tool.name === 'run_shell' && typeof args?.command === 'string'
        ? `$ ${args.command}`
        : stringifyOutput(args ?? {}),
  }

  function updateEvent(partial) {
    emitToolEvent(
      {
        ...baseEvent,
        ...partial,
      },
      toolEvents,
      hooks,
    )
  }

  if (tool.approvalCategory && !isAutoApproved(tool, hooks.settings || {})) {
    const decision = await hooks.requestApproval?.({
      id: eventId,
      category: tool.approvalCategory,
      toolName: tool.name,
      summary: tool.description,
      input: stringifyOutput(args ?? {}),
    })

    if (decision !== 'approve') {
      const deniedError = createStructuredError('这一步已被用户拒绝执行。', {
        source:
          tool.source === 'plugin'
            ? 'plugin'
            : tool.source === 'mcp'
              ? 'mcp'
              : 'tool',
        category: 'cancelled',
        code: 'USER_DENIED',
        detail: 'Tool execution was denied by the user.',
        suggestedAction: '如果仍然需要执行，请重新发起并在审批时允许本次操作。',
      })
      updateEvent({
        summary: `${tool.description} (denied by user)`,
        status: 'error',
        error: deniedError.rawMessage,
        errorInfo: deniedError.errorInfo,
      })
      return `Tool ${tool.name} was denied by the user.`
    }
  }

  const abortController = hooks.createCurrentStepAbortController?.()
  try {
    updateEvent({
      status: 'running',
      output: '',
      error: undefined,
      errorInfo: undefined,
    })
    throwIfAborted(abortController?.signal, tool)
    const output = await runAbortable(
      Promise.resolve(
        tool.run(args, {
          signal: abortController?.signal,
          throwIfAborted() {
            throwIfAborted(abortController?.signal, tool)
          },
          onUpdate(nextOutput) {
            updateEvent({
              status: 'running',
              output: stringifyOutput(nextOutput),
            })
          },
        }),
      ),
      abortController?.signal,
      tool,
    )
    updateEvent({
      status: 'success',
      output: stringifyOutput(output),
      error: undefined,
    })
    return stringifyOutput(output)
  } catch (error) {
    const detail = formatToolError(error)
    const normalized = normalizeRuntimeError(error, {
      source:
        tool.source === 'plugin'
          ? 'plugin'
          : tool.source === 'mcp'
            ? 'mcp'
            : 'tool',
      operationLabel: tool.description || tool.name,
    })
    updateEvent({
      status: 'error',
      error: detail,
      errorInfo: normalized.errorInfo,
    })
    return [
      normalized.errorInfo.summary,
      normalized.errorInfo.suggestedAction || null,
      detail ? `原始错误:\n${detail}` : null,
    ]
      .filter(Boolean)
      .join('\n\n')
  } finally {
    hooks.releaseCurrentStepAbortController?.(abortController)
  }
}
