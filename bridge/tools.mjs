import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  formatToolError,
  parseLooseJson,
  resolveWorkspacePath,
  stringifyOutput,
  truncate,
} from './utils.mjs'
import { createStructuredError, normalizeRuntimeError } from './runtimeErrors.mjs'

const execFileAsync = promisify(execFile)
const ALWAYS_ON_SKILL_IDS = new Set([
  'desktop-operator',
  'repair-planner',
  'repo-reviewer',
])

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

  let stats
  try {
    stats = await fs.stat(rootPath)
  } catch {
    return matches
  }

  if (stats.isFile()) {
    let content
    try {
      content = await fs.readFile(rootPath)
    } catch {
      return matches
    }

    if (detectBinary(content)) {
      return matches
    }

    const text = content.toString('utf8')
    const lines = text.split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(query)) {
        continue
      }
      matches.push(
        `${path.relative(baseCwd, rootPath) || path.basename(rootPath)}:${index + 1}:${lines[index]}`,
      )
      if (matches.length >= 200) {
        return matches
      }
    }

    return matches
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

function resolveAuraHomePath() {
  return path.join(os.homedir(), '.aura')
}

function createTodoId() {
  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeTodoItems(items) {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const content =
        typeof item.content === 'string'
          ? item.content.trim()
          : typeof item.text === 'string'
            ? item.text.trim()
            : ''
      if (!content) {
        return null
      }

      const status =
        item.status === 'completed' || item.status === 'in_progress'
          ? item.status
          : 'pending'

      return {
        id:
          typeof item.id === 'string' && item.id.trim()
            ? item.id.trim()
            : `${createTodoId()}-${index}`,
        content,
        status,
      }
    })
    .filter(Boolean)
}

function formatTodoList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'Todo list is empty.'
  }

  return items
    .map(item => {
      const marker =
        item.status === 'completed'
          ? '[x]'
          : item.status === 'in_progress'
            ? '[~]'
            : '[ ]'
      return `${marker} ${item.content}`
    })
    .join('\n')
}

function globPatternToRegExp(pattern) {
  const normalized = String(pattern || '').trim()
  if (!normalized) {
    return /^.*$/u
  }

  let output = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index]
    const next = normalized[index + 1]

    if (current === '*' && next === '*') {
      output += '.*'
      index += 1
      continue
    }

    if (current === '*') {
      output += '[^/]*'
      continue
    }

    if (current === '?') {
      output += '.'
      continue
    }

    if ('\\.[]{}()+-^$|'.includes(current)) {
      output += `\\${current}`
      continue
    }

    output += current
  }
  output += '$'
  return new RegExp(output, 'u')
}

async function collectWorkspaceFilePaths(rootPath, currentPath = rootPath, matches = []) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true })

  for (const entry of entries) {
    if (shouldSkipSearchEntry(entry.name) || entry.name.startsWith('.')) {
      continue
    }

    const entryPath = path.join(currentPath, entry.name)
    if (entry.isDirectory()) {
      await collectWorkspaceFilePaths(rootPath, entryPath, matches)
      continue
    }

    if (entry.isFile()) {
      matches.push(path.relative(rootPath, entryPath) || entry.name)
      if (matches.length >= 500) {
        return matches
      }
    }
  }

  return matches
}

async function globWorkspace(pattern, target, cwd) {
  const allFiles = await collectWorkspaceFilePaths(target)
  const regex = globPatternToRegExp(pattern)
  const matched = allFiles.filter(filePath => regex.test(filePath))
  return truncate(matched.join('\n') || 'No matches found')
}

async function replaceExactTextInFile(target, oldText, newText, options = {}) {
  if (!oldText) {
    throw new Error('oldText must not be empty.')
  }

  const content = await fs.readFile(target, 'utf8')
  const occurrences = content.split(oldText).length - 1
  if (occurrences === 0) {
    throw new Error('oldText was not found in the target file.')
  }

  const replaceAll = options.replaceAll === true
  const expectedReplacements =
    typeof options.expectedReplacements === 'number' && Number.isFinite(options.expectedReplacements)
      ? Math.max(1, Math.round(options.expectedReplacements))
      : replaceAll
        ? occurrences
        : 1

  if (occurrences < expectedReplacements) {
    throw new Error(
      `Expected at least ${expectedReplacements} matching occurrence(s), but found ${occurrences}.`,
    )
  }

  let replacedCount = 0
  let nextContent
  if (replaceAll) {
    replacedCount = occurrences
    nextContent = content.split(oldText).join(newText)
  } else {
    replacedCount = 1
    nextContent = content.replace(oldText, newText)
  }

  await fs.writeFile(target, nextContent, 'utf8')
  return {
    replacedCount,
    beforeLength: content.length,
    afterLength: nextContent.length,
  }
}

function resolveUserSuppliedPath(cwd, targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('sourcePath must not be empty.')
  }
  if (path.isAbsolute(targetPath)) {
    return path.resolve(targetPath)
  }
  return resolveWorkspacePath(cwd, targetPath)
}

function inferAuraSkillTarget(sourcePath, requestedId = '') {
  const parsed = path.parse(sourcePath)
  const fallbackId = requestedId.trim() || parsed.name || path.basename(parsed.dir)
  if (parsed.ext.toLowerCase() === '.md') {
    return {
      id: fallbackId,
      destination: `${fallbackId}.md`,
      kind: 'file',
    }
  }

  return {
    id: fallbackId,
    destination: fallbackId,
    kind: 'directory',
  }
}

function inferAuraPluginTarget(sourcePath, requestedId = '') {
  const parsed = path.parse(sourcePath)
  const extension = parsed.ext.toLowerCase()
  const fallbackId = requestedId.trim() || parsed.name || path.basename(parsed.dir)
  if (extension === '.mjs' || extension === '.js') {
    return {
      id: fallbackId,
      destination: `${fallbackId}${extension}`,
      kind: 'file',
    }
  }

  return {
    id: fallbackId,
    destination: fallbackId,
    kind: 'directory',
  }
}

async function copyIntoAuraDirectory({ cwd, kind, sourcePath, targetId }) {
  const resolvedSource = resolveUserSuppliedPath(cwd, sourcePath)
  const stats = await fs.stat(resolvedSource)
  const auraHome = resolveAuraHomePath()
  const targetRoot = path.join(auraHome, kind)
  await fs.mkdir(targetRoot, { recursive: true })

  const inferred =
    kind === 'skills'
      ? inferAuraSkillTarget(resolvedSource, targetId)
      : inferAuraPluginTarget(resolvedSource, targetId)
  const destinationPath = path.join(targetRoot, inferred.destination)

  await fs.rm(destinationPath, { recursive: true, force: true })
  if (stats.isDirectory()) {
    await fs.cp(resolvedSource, destinationPath, { recursive: true, force: true })
  } else {
    await fs.copyFile(resolvedSource, destinationPath)
  }

  return {
    id: inferred.id,
    destinationPath,
    sourcePath: resolvedSource,
  }
}

function ensureAppControl(context) {
  if (typeof context.appControl !== 'function') {
    throw new Error('App control bridge is unavailable in this runtime.')
  }
  return context.appControl
}

async function getAuraState(context) {
  const appControl = ensureAppControl(context)
  return appControl('ensure_aura_home', {})
}

async function getLiveSettings(context) {
  const appControl = ensureAppControl(context)
  const settings = await appControl('get_settings', {})
  if (!settings || typeof settings !== 'object') {
    throw new Error('Aura settings are unavailable.')
  }
  return settings
}

async function saveLiveSettings(context, settings) {
  const appControl = ensureAppControl(context)
  return appControl('set_settings', { settings })
}

async function refreshAuraState(context) {
  const settings = await getLiveSettings(context)
  await saveLiveSettings(context, settings)
  return getAuraState(context)
}

function normalizeStringArray(items) {
  if (!Array.isArray(items)) {
    return []
  }
  return Array.from(
    new Set(
      items
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean),
    ),
  )
}

function normalizeMcpServerEntries(items) {
  if (!Array.isArray(items)) {
    return []
  }
  return items
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `mcp-${Date.now()}`,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'new-mcp',
      description: typeof item.description === 'string' ? item.description : '',
      command: typeof item.command === 'string' ? item.command : '',
      args: typeof item.args === 'string' ? item.args : '',
      env: typeof item.env === 'string' ? item.env : '{}',
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      enabled: item.enabled !== false,
      isDefault: item.isDefault === true,
    }))
}

async function updateCapabilityEnabled(context, kind, capabilityId, enabled) {
  const settings = await getLiveSettings(context)
  const current = normalizeStringArray(
    kind === 'skill' ? settings.enabledSkillIds : settings.enabledPluginIds,
  )
  const next = enabled
    ? Array.from(new Set([...current, capabilityId]))
    : current.filter(item => item !== capabilityId)

  const nextSettings = {
    ...settings,
    [kind === 'skill' ? 'enabledSkillIds' : 'enabledPluginIds']: next,
  }
  await saveLiveSettings(context, nextSettings)
  return nextSettings
}

async function upsertMcpServer(context, serverInput) {
  const settings = await getLiveSettings(context)
  const current = normalizeMcpServerEntries(settings.mcpServers)
  const serverId =
    typeof serverInput.id === 'string' && serverInput.id.trim()
      ? serverInput.id.trim()
      : `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const nextServer = {
    id: serverId,
    name:
      typeof serverInput.name === 'string' && serverInput.name.trim()
        ? serverInput.name.trim()
        : 'new-mcp',
    description:
      typeof serverInput.description === 'string' ? serverInput.description : '',
    command:
      typeof serverInput.command === 'string' ? serverInput.command.trim() : '',
    args: typeof serverInput.args === 'string' ? serverInput.args : '',
    env:
      typeof serverInput.env === 'string'
        ? serverInput.env
        : JSON.stringify(serverInput.env || {}, null, 2),
    cwd: typeof serverInput.cwd === 'string' ? serverInput.cwd : '',
    enabled: serverInput.enabled !== false,
    isDefault: serverInput.isDefault === true,
  }

  const nextServers = current.some(server => server.id === serverId)
    ? current.map(server => (server.id === serverId ? { ...server, ...nextServer } : server))
    : [...current, nextServer]

  const nextSettings = {
    ...settings,
    mcpServers: nextServers,
  }
  await saveLiveSettings(context, nextSettings)
  return nextServer
}

async function removeMcpServer(context, serverId) {
  const settings = await getLiveSettings(context)
  const current = normalizeMcpServerEntries(settings.mcpServers)
  const nextSettings = {
    ...settings,
    mcpServers: current.filter(server => server.id !== serverId),
  }
  await saveLiveSettings(context, nextSettings)
  return nextSettings.mcpServers
}

export function createBuiltinTools(context) {
  context.todoState ||= { items: [] }

  return [
    {
      source: 'builtin',
      name: 'list_files',
      aliases: ['listfiles', 'ls', 'files'],
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
      name: 'glob_files',
      aliases: ['glob', 'findfiles'],
      description:
        'Find workspace files by glob pattern. Useful for locating likely files before reading or editing.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern, for example "src/**/*.ts" or "**/*.md".',
          },
          path: {
            type: 'string',
            description: 'Optional relative directory inside the workspace to search from.',
          },
        },
        required: ['pattern'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path || '.')
        return globWorkspace(args.pattern, target, context.cwd)
      },
    },
    {
      source: 'builtin',
      name: 'read_file',
      aliases: ['read', 'readfile', 'cat'],
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
      aliases: ['write', 'writefile'],
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
      name: 'edit_file',
      aliases: ['edit', 'replace'],
      approvalCategory: 'file_write',
      description:
        'Edit a file by replacing an exact text block. Prefer this over rewriting the whole file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside the workspace.',
          },
          oldText: {
            type: 'string',
            description: 'Exact text to replace.',
          },
          newText: {
            type: 'string',
            description: 'Replacement text.',
          },
          replaceAll: {
            type: 'boolean',
            description: 'Replace every occurrence instead of only the first one.',
          },
          expectedReplacements: {
            type: 'number',
            description: 'Optional minimum number of occurrences expected before editing.',
          },
        },
        required: ['path', 'oldText', 'newText'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path)
        const result = await replaceExactTextInFile(target, args.oldText, args.newText, {
          replaceAll: args.replaceAll,
          expectedReplacements: args.expectedReplacements,
        })
        return stringifyOutput({
          path: target,
          ...result,
        })
      },
    },
    {
      source: 'builtin',
      name: 'multi_edit_file',
      aliases: ['multiedit', 'editmany'],
      approvalCategory: 'file_write',
      description:
        'Apply multiple exact text replacements to one file in sequence.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside the workspace.',
          },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string' },
                newText: { type: 'string' },
                replaceAll: { type: 'boolean' },
                expectedReplacements: { type: 'number' },
              },
              required: ['oldText', 'newText'],
            },
            description: 'Ordered list of exact replacements to apply.',
          },
        },
        required: ['path', 'edits'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path)
        if (!Array.isArray(args.edits) || args.edits.length === 0) {
          throw new Error('edits must contain at least one replacement.')
        }

        const applied = []
        for (const edit of args.edits) {
          runtime.throwIfAborted?.()
          const result = await replaceExactTextInFile(target, edit.oldText, edit.newText, {
            replaceAll: edit.replaceAll,
            expectedReplacements: edit.expectedReplacements,
          })
          applied.push(result)
        }

        return stringifyOutput({
          path: target,
          editsApplied: applied.length,
          results: applied,
        })
      },
    },
    {
      source: 'builtin',
      name: 'search_code',
      aliases: ['search', 'grep', 'ripgrep'],
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
      name: 'todo_write',
      aliases: ['todo', 'plan', 'tasklist'],
      description:
        'Track the current plan as a structured todo list. Use it for multi-step or stateful work.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                content: { type: 'string' },
                status: {
                  type: 'string',
                  description: 'One of: pending, in_progress, completed.',
                },
              },
              required: ['content'],
            },
          },
        },
        required: ['items'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const nextItems = normalizeTodoItems(args.items)
        context.todoState.items = nextItems
        return formatTodoList(nextItems)
      },
    },
    {
      source: 'builtin',
      name: 'run_shell',
      aliases: ['bash', 'shell', 'terminal', 'command'],
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
    {
      source: 'builtin',
      name: 'aura_list_capabilities',
      aliases: ['listcapabilities', 'capabilities'],
      description:
        'Inspect installed and enabled Aura skills, plugins, and MCP servers.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const [settings, aura] = await Promise.all([
          getLiveSettings(context),
          getAuraState(context),
        ])

        return stringifyOutput({
          skills: (aura.skills || []).map(skill => ({
            id: skill.id,
            name: skill.name,
            enabled:
              ALWAYS_ON_SKILL_IDS.has(skill.id) ||
              normalizeStringArray(settings.enabledSkillIds).includes(skill.id),
            readonly: skill.readonly === true,
            supported: skill.supported !== false,
            supportMessage: skill.supportMessage || '',
          })),
          plugins: (aura.plugins || []).map(plugin => ({
            id: plugin.id,
            name: plugin.name,
            enabled: normalizeStringArray(settings.enabledPluginIds).includes(plugin.id),
            readonly: plugin.readonly === true,
            supported: plugin.supported !== false,
          })),
          mcpServers: normalizeMcpServerEntries(settings.mcpServers).map(server => ({
            id: server.id,
            name: server.name,
            enabled: server.enabled !== false,
            command: server.command,
          })),
        })
      },
    },
    {
      source: 'builtin',
      name: 'aura_read_skill',
      aliases: ['readskill', 'skillfile', 'openskill'],
      description:
        'Read the full content of an installed Aura skill by id. Use this only when a selected skill is relevant and you need its detailed instructions.',
      inputSchema: {
        type: 'object',
        properties: {
          skillId: {
            type: 'string',
            description: 'Installed skill id to inspect.',
          },
        },
        required: ['skillId'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const aura = await getAuraState(context)
        const skill = (aura.skills || []).find(entry => entry.id === args.skillId)
        if (!skill) {
          throw new Error(`Skill not found: ${args.skillId}`)
        }
        const skillPath = skill.entryPath || skill.path
        if (!skillPath) {
          throw new Error(`Skill file path is unavailable for: ${args.skillId}`)
        }
        const content = await fs.readFile(skillPath, 'utf8')
        return stringifyOutput({
          skillId: skill.id,
          name: skill.name,
          description: skill.description,
          path: skillPath,
          content,
        })
      },
    },
    {
      source: 'builtin',
      name: 'aura_enable_skill',
      aliases: ['enableskill', 'disableskill'],
      approvalCategory: 'file_write',
      description:
        'Enable or disable an installed Aura skill in the desktop app settings.',
      inputSchema: {
        type: 'object',
        properties: {
          skillId: {
            type: 'string',
            description: 'Installed skill id to toggle.',
          },
          enabled: {
            type: 'boolean',
            description: 'Set true to enable the skill, false to disable it.',
          },
        },
        required: ['skillId', 'enabled'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const aura = await getAuraState(context)
        if (!(aura.skills || []).some(skill => skill.id === args.skillId)) {
          throw new Error(`Skill not found: ${args.skillId}`)
        }
        const nextSettings = await updateCapabilityEnabled(
          context,
          'skill',
          args.skillId,
          args.enabled !== false,
        )
        return stringifyOutput({
          skillId: args.skillId,
          enabled: normalizeStringArray(nextSettings.enabledSkillIds).includes(args.skillId),
        })
      },
    },
    {
      source: 'builtin',
      name: 'aura_enable_plugin',
      aliases: ['enableplugin', 'disableplugin'],
      approvalCategory: 'file_write',
      description:
        'Enable or disable an installed Aura plugin in the desktop app settings.',
      inputSchema: {
        type: 'object',
        properties: {
          pluginId: {
            type: 'string',
            description: 'Installed plugin id to toggle.',
          },
          enabled: {
            type: 'boolean',
            description: 'Set true to enable the plugin, false to disable it.',
          },
        },
        required: ['pluginId', 'enabled'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const aura = await getAuraState(context)
        if (!(aura.plugins || []).some(plugin => plugin.id === args.pluginId)) {
          throw new Error(`Plugin not found: ${args.pluginId}`)
        }
        const nextSettings = await updateCapabilityEnabled(
          context,
          'plugin',
          args.pluginId,
          args.enabled !== false,
        )
        return stringifyOutput({
          pluginId: args.pluginId,
          enabled: normalizeStringArray(nextSettings.enabledPluginIds).includes(args.pluginId),
        })
      },
    },
    {
      source: 'builtin',
      name: 'aura_import_skill',
      aliases: ['importskill', 'installskill'],
      approvalCategory: 'file_write',
      description:
        'Copy a skill file or skill directory into Aura and optionally enable it immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          sourcePath: {
            type: 'string',
            description: 'Workspace-relative or absolute path to a .md file or skill directory.',
          },
          skillId: {
            type: 'string',
            description: 'Optional target skill id inside Aura.',
          },
          enable: {
            type: 'boolean',
            description: 'Enable the imported skill after copying it.',
          },
        },
        required: ['sourcePath'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const imported = await copyIntoAuraDirectory({
          cwd: context.cwd,
          kind: 'skills',
          sourcePath: args.sourcePath,
          targetId: args.skillId || '',
        })
        if (args.enable !== false) {
          await updateCapabilityEnabled(context, 'skill', imported.id, true)
        } else {
          await refreshAuraState(context)
        }
        const aura = await getAuraState(context)
        const installedSkill = (aura.skills || []).find(skill => skill.id === imported.id)
        return stringifyOutput({
          importedFrom: imported.sourcePath,
          installedTo: imported.destinationPath,
          skillId: imported.id,
          enabled: args.enable !== false,
          skill: installedSkill || null,
        })
      },
    },
    {
      source: 'builtin',
      name: 'aura_import_plugin',
      aliases: ['importplugin', 'installplugin'],
      approvalCategory: 'file_write',
      description:
        'Copy a plugin file or plugin directory into Aura and optionally enable it immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          sourcePath: {
            type: 'string',
            description: 'Workspace-relative or absolute path to a .mjs/.js file or plugin directory.',
          },
          pluginId: {
            type: 'string',
            description: 'Optional target plugin id inside Aura.',
          },
          enable: {
            type: 'boolean',
            description: 'Enable the imported plugin after copying it.',
          },
        },
        required: ['sourcePath'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const imported = await copyIntoAuraDirectory({
          cwd: context.cwd,
          kind: 'plugins',
          sourcePath: args.sourcePath,
          targetId: args.pluginId || '',
        })
        if (args.enable !== false) {
          await updateCapabilityEnabled(context, 'plugin', imported.id, true)
        } else {
          await refreshAuraState(context)
        }
        const aura = await getAuraState(context)
        const installedPlugin = (aura.plugins || []).find(plugin => plugin.id === imported.id)
        return stringifyOutput({
          importedFrom: imported.sourcePath,
          installedTo: imported.destinationPath,
          pluginId: imported.id,
          enabled: args.enable !== false,
          plugin: installedPlugin || null,
        })
      },
    },
    {
      source: 'builtin',
      name: 'aura_upsert_mcp_server',
      aliases: ['savemcp', 'upsertmcp'],
      approvalCategory: 'file_write',
      description:
        'Create or update an MCP server entry in Aura settings and optionally enable it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Optional existing MCP server id to update.',
          },
          name: {
            type: 'string',
            description: 'Display name for the MCP server.',
          },
          description: {
            type: 'string',
            description: 'Optional description.',
          },
          command: {
            type: 'string',
            description: 'Executable command, for example "npx".',
          },
          args: {
            type: 'string',
            description: 'Optional argument string.',
          },
          env: {
            type: 'string',
            description: 'Optional JSON object string for environment variables.',
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory.',
          },
          enabled: {
            type: 'boolean',
            description: 'Enable the server after saving it.',
          },
        },
        required: ['name', 'command'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const envValue =
          typeof args.env === 'string' && args.env.trim()
            ? JSON.stringify(parseLooseJson(args.env, {}), null, 2)
            : '{}'
        const nextServer = await upsertMcpServer(context, {
          ...args,
          env: envValue,
        })
        return stringifyOutput(nextServer)
      },
    },
    {
      source: 'builtin',
      name: 'aura_remove_mcp_server',
      aliases: ['removemcp', 'deletemcp'],
      approvalCategory: 'file_write',
      description:
        'Remove an MCP server entry from Aura settings.',
      inputSchema: {
        type: 'object',
        properties: {
          serverId: {
            type: 'string',
            description: 'Existing MCP server id to remove.',
          },
        },
        required: ['serverId'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const remaining = await removeMcpServer(context, args.serverId)
        return stringifyOutput({
          removed: args.serverId,
          remainingCount: remaining.length,
        })
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
