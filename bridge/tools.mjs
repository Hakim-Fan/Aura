import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  formatToolError,
  parseCommandSpec,
  parseLooseJson,
  resolveWorkspacePath,
  stringifyOutput,
  truncate,
} from './utils.mjs'
import { createStructuredError, normalizeRuntimeError } from './runtimeErrors.mjs'
import { createWebTools } from './webTools.mjs'
import { applyPatchInWorkspace } from './editing/applyPatchTool.mjs'
import { parseApplyPatchShellCommand } from './editing/applyPatchShell.mjs'
import {
  buildEditingToolApprovalPreview,
  createEditingTools,
} from './editing/toolHandlers.mjs'
import { createUnifiedExecRuntime } from './editing/unifiedExecRuntime.mjs'
import { buildShellEnv } from './shellEnv.mjs'
import { resolveCommandShell } from './shellRuntime.mjs'
import { resolveAuraSkillInstallSource } from './skillInstaller.mjs'

const ALWAYS_ON_SKILL_IDS = new Set([
  'aura-browser-operator',
  'desktop-operator',
  'repair-planner',
  'repo-reviewer',
  'web-research',
])

const STRUCTURED_EVENT_OUTPUT_TOOLS = new Set([
  'apply_patch',
  'write_file',
  'edit_file',
  'multi_edit_file',
  'replace_line_range',
])

function structuredEventOutputForTool(toolName, value) {
  if (!STRUCTURED_EVENT_OUTPUT_TOOLS.has(toolName)) {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value
}

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

function resolveShellPatchInterception(tool, args, hooks = {}) {
  if (tool?.name !== 'run_shell' || typeof args?.command !== 'string') {
    return null
  }

  const parsed = parseApplyPatchShellCommand(args.command)
  if (!parsed) {
    return null
  }

  if (parsed.kind === 'invalid') {
    return {
      tool: {
        ...tool,
        name: 'apply_patch',
        aliases: ['patch'],
        description:
          'Rejected an invalid apply_patch shell invocation before it could fall back to ordinary shell execution.',
        async run() {
          throw createStructuredError('检测到了无效的 apply_patch shell 调用。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'INVALID_APPLY_PATCH_INVOCATION',
            detail: parsed.reason,
            suggestedAction:
              '请改用标准的 apply_patch 调用形式，或直接使用 apply_patch 工具而不是 run_shell。',
          })
        },
      },
      args: {
        command: args.command,
      },
      originalCommand: args.command,
      summary:
        'Blocked an invalid apply_patch shell invocation before it could run as a normal shell command.',
    }
  }

  if (!hooks?.settings?.cwd) {
    return null
  }

  const patch = parsed.patch
  const patchRoot = parsed.workdir
    ? resolveWorkspacePath(hooks.settings.cwd, parsed.workdir)
    : hooks.settings.cwd

  return {
    tool: {
      ...tool,
      name: 'apply_patch',
      aliases: ['patch'],
      approvalCategory: 'file_write',
      description:
        'Intercepted a structured apply_patch command from shell and applied it through the verified patch runtime.',
      async run(nextArgs, runtime = {}) {
        return applyPatchInWorkspace(
          patchRoot,
          typeof nextArgs?.patch === 'string' ? nextArgs.patch : patch,
          runtime,
        )
      },
    },
    args: {
      patch,
    },
    patchRoot,
    originalCommand: args.command,
    summary:
      'Intercepted a shell apply_patch command and routed it through the verified patch tool.',
  }
}

const SHELL_SCRIPT_FILE_WRITE_PATTERN =
  /\b(?:python3?|node|ruby|perl|php)\b[\s\S]*(?:\.write_text\s*\(|\.write_bytes\s*\(|\bopen\s*\([^)]*,\s*['"][wa]\b|\bwriteFile(?:Sync)?\s*\(|\bcreateWriteStream\s*\()/i

const SHELL_IN_PLACE_EDIT_PATTERN =
  /\b(?:sed|perl)\b[\s\S]*(?:\s-i(?:\s|$|['"])|--in-place\b)/i

const SHELL_REDIRECT_SOURCE_WRITE_PATTERN =
  /\b(?:cat|tee|printf|echo)\b[\s\S]*(?:>|>>)\s*['"]?[^'"\s]+\.(?:cjs|css|go|html|java|js|jsx|json|kt|mjs|md|py|rs|scss|svelte|swift|toml|ts|tsx|vue|ya?ml)\b/i

function looksLikeShellFileMutation(command) {
  return (
    SHELL_SCRIPT_FILE_WRITE_PATTERN.test(command) ||
    SHELL_IN_PLACE_EDIT_PATTERN.test(command) ||
    SHELL_REDIRECT_SOURCE_WRITE_PATTERN.test(command)
  )
}

function resolveShellFileMutationInterception(tool, args) {
  if (tool?.name !== 'run_shell' || typeof args?.command !== 'string') {
    return null
  }

  if (!looksLikeShellFileMutation(args.command)) {
    return null
  }

  return {
    tool: {
      ...tool,
      name: 'run_shell',
      aliases: ['bash', 'shell', 'terminal', 'command'],
      approvalCategory: undefined,
      description:
        'Blocked a shell command that appears to create or modify source files.',
      async run() {
        throw createStructuredError('已阻止使用 shell 脚本直接修改源码文件。', {
          source: 'tool',
          category: 'invalid_input',
          code: 'SHELL_FILE_MUTATION_BLOCKED',
          detail:
            'Shell commands may run verification or build steps, but source edits should use the mounted file editing tools.',
          suggestedAction:
            '请先用 read_file 读取当前文件，再用 apply_patch 修改已有文件；如果精确上下文不稳定，请用 replace_line_range；如果是新文件或完整重写，请使用 write_file。',
        })
      },
    },
    args: {
      command: args.command,
    },
    originalCommand: args.command,
    summary:
      'Blocked shell-based source editing; use apply_patch, replace_line_range, or write_file instead.',
  }
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

    const env = buildShellEnv()
    const commandShell = resolveCommandShell({ env })
    const child = spawn(commandShell.file, commandShell.args(command), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let flushTimer = null
    let settled = false

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
      if (settled) {
        return
      }
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`Shell command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const handleAbort = () => {
      if (settled) {
        return
      }
      settled = true
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

    child.on('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
      }
      signal?.removeEventListener('abort', handleAbort)
      reject(error)
    })
    child.on('close', code => {
      if (settled) {
        return
      }
      settled = true
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
      matches.push((path.relative(rootPath, entryPath) || entry.name).split(path.sep).join('/'))
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

async function copyIntoAuraDirectory({ cwd, kind, sourcePath, targetId, targetRoot }) {
  const resolvedSource = resolveUserSuppliedPath(cwd, sourcePath)
  const stats = await fs.stat(resolvedSource)
  const auraHome = resolveAuraHomePath()
  const resolvedTargetRoot = targetRoot || path.join(auraHome, kind)
  await fs.mkdir(resolvedTargetRoot, { recursive: true })

  const inferred =
    kind === 'skills'
      ? inferAuraSkillTarget(resolvedSource, targetId)
      : inferAuraPluginTarget(resolvedSource, targetId)
  const destinationPath = path.join(resolvedTargetRoot, inferred.destination)

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

function buildSkillImmediateUseHint(skillId, enabled) {
  if (!enabled) {
    return 'This skill is installed but not enabled, so it will not be included in future task prompts unless enabled later.'
  }
  return `This skill is enabled immediately. For the current task, decide whether it matches the user request now; if it does, call aura_read_skill with skillId "${skillId}" before continuing and follow the skill instructions. Do not wait for the user to mention the skill.`
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
  const byFingerprint = new Map()

  for (const item of items.filter(item => item && typeof item === 'object')) {
    const command = typeof item.command === 'string' ? item.command.trim() : ''
    const args = typeof item.args === 'string' ? item.args.trim() : ''
    const cwd = typeof item.cwd === 'string' ? item.cwd.trim() : ''
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'new-mcp'
    const healthStatus =
      item.healthStatus === 'ok' || item.healthStatus === 'error'
        ? item.healthStatus
        : 'unknown'
    const normalized = {
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `mcp-${Date.now()}`,
      name,
      description: typeof item.description === 'string' ? item.description : '',
      command,
      args,
      env: typeof item.env === 'string' ? item.env : '{}',
      cwd,
      enabled: item.enabled === true && healthStatus === 'ok',
      healthStatus,
      healthMessage: typeof item.healthMessage === 'string' ? item.healthMessage : '',
      lastCheckedAt:
        typeof item.lastCheckedAt === 'number' && Number.isFinite(item.lastCheckedAt)
          ? item.lastCheckedAt
          : undefined,
      toolCount:
        typeof item.toolCount === 'number' && Number.isFinite(item.toolCount)
          ? Math.max(0, Math.round(item.toolCount))
          : undefined,
      isDefault: item.isDefault === true,
    }
    const fingerprint = [command, args, cwd, name.toLowerCase()].join('::')
    const existing = byFingerprint.get(fingerprint)
    byFingerprint.set(
      fingerprint,
      existing
        ? {
            ...existing,
            ...normalized,
            id: existing.id || normalized.id,
          }
        : normalized,
    )
  }

  return Array.from(byFingerprint.values())
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
  const commandSpec = parseCommandSpec(
    typeof serverInput.command === 'string' ? serverInput.command : '',
    typeof serverInput.args === 'string' ? serverInput.args : '',
  )
  const name =
    typeof serverInput.name === 'string' && serverInput.name.trim()
      ? serverInput.name.trim()
      : 'new-mcp'
  const description =
    typeof serverInput.description === 'string' ? serverInput.description : ''
  const cwd = typeof serverInput.cwd === 'string' ? serverInput.cwd.trim() : ''
  const env =
    typeof serverInput.env === 'string'
      ? serverInput.env
      : JSON.stringify(serverInput.env || {}, null, 2)
  const fingerprint = [
    commandSpec.command,
    commandSpec.args.join(' '),
    cwd,
    name.toLowerCase(),
  ].join('::')
  const matchedServer =
    current.find(server => server.id === serverInput.id) ||
    current.find(
      server => [server.command, server.args, server.cwd, server.name.toLowerCase()].join('::') === fingerprint,
    )
  const serverId =
    typeof serverInput.id === 'string' && serverInput.id.trim()
      ? serverInput.id.trim()
      : matchedServer?.id || `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const nextServer = {
    id: serverId,
    name,
    description,
    command: commandSpec.command,
    args: commandSpec.args.join(' '),
    env,
    cwd,
    enabled:
      matchedServer &&
      matchedServer.command === commandSpec.command &&
      matchedServer.args === commandSpec.args.join(' ') &&
      matchedServer.cwd === cwd &&
      matchedServer.env === env &&
      matchedServer.healthStatus === 'ok' &&
      serverInput.enabled !== false,
    healthStatus:
      matchedServer &&
      matchedServer.command === commandSpec.command &&
      matchedServer.args === commandSpec.args.join(' ') &&
      matchedServer.cwd === cwd &&
      matchedServer.env === env
        ? matchedServer.healthStatus || 'unknown'
        : 'unknown',
    healthMessage:
      matchedServer &&
      matchedServer.command === commandSpec.command &&
      matchedServer.args === commandSpec.args.join(' ') &&
      matchedServer.cwd === cwd &&
      matchedServer.env === env
        ? matchedServer.healthMessage || ''
        : '',
    lastCheckedAt:
      matchedServer &&
      matchedServer.command === commandSpec.command &&
      matchedServer.args === commandSpec.args.join(' ') &&
      matchedServer.cwd === cwd &&
      matchedServer.env === env
        ? matchedServer.lastCheckedAt
        : undefined,
    toolCount:
      matchedServer &&
      matchedServer.command === commandSpec.command &&
      matchedServer.args === commandSpec.args.join(' ') &&
      matchedServer.cwd === cwd &&
      matchedServer.env === env
        ? matchedServer.toolCount
        : undefined,
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
  const unifiedExec = createUnifiedExecRuntime()
  context.cleanupHandlers ||= []
  context.cleanupHandlers.push(() => unifiedExec.closeAllSessions())

  return [
    ...createWebTools(context),
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
    ...createEditingTools(context),
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
      name: 'request_user_input',
      aliases: ['ask_user', 'request_confirmation'],
      description:
        'Pause the current run and ask the user for a needed confirmation, missing decision, or extra local context before continuing.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The concrete question or confirmation request to show the user.',
          },
          context: {
            type: 'string',
            description: 'Optional short context explaining why the extra input is needed.',
          },
          allowAttachments: {
            type: 'boolean',
            description: 'Whether the user may respond with attachments as part of the follow-up.',
          },
        },
        required: ['question'],
      },
      internalOnly: true,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        if (typeof runtime.requestUserInput !== 'function') {
          throw createStructuredError('当前运行时不支持请求用户补充输入。', {
            source: 'tool',
            category: 'unsupported',
            code: 'REQUEST_USER_INPUT_UNAVAILABLE',
            suggestedAction:
              '请直接在最终回答里说明还缺什么信息，或切换到支持交互续跑的运行时。',
          })
        }

        const response = await runtime.requestUserInput({
          id: `user-input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          question: typeof args.question === 'string' ? args.question : '',
          context: typeof args.context === 'string' ? args.context : '',
          allowAttachments: args.allowAttachments !== false,
        })

        return stringifyOutput({
          status: 'received',
          queuedAsNextUserTurn: true,
          attachmentCount:
            response && typeof response === 'object' && Number.isFinite(response.attachmentCount)
              ? response.attachmentCount
              : 0,
        })
      },
    },
    {
      source: 'builtin',
      name: 'exec_command',
      aliases: ['exec', 'shell_session', 'command_session'],
      approvalCategory: 'shell',
      description:
        'Start a long-lived shell command session inside the workspace. Use this for watch tasks, repeated debugging, or commands that need follow-up interaction. Prefer list_files, glob_files, read_file, and search_code for workspace inspection.',
      inputSchema: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            description: 'Shell command to execute.',
          },
          workdir: {
            type: 'string',
            description: 'Optional relative directory inside the workspace.',
          },
          login: {
            type: 'boolean',
            description: 'Use a login shell. Defaults to true.',
          },
          tty: {
            type: 'boolean',
            description: 'Reserved for future TTY support. Currently only false is supported.',
          },
          yieldTimeMs: {
            type: 'number',
            description: 'How long to wait for initial output before returning.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Optional maximum lifetime for the command session in milliseconds before it is terminated.',
          },
          maxOutputChars: {
            type: 'number',
            description: 'Maximum number of output characters to include in each response.',
          },
        },
        required: ['cmd'],
      },
      liveUpdates: true,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const cwd = resolveWorkspacePath(context.cwd, args.workdir || '.')
        return unifiedExec.execCommand(
          {
            cmd: args.cmd,
            cwd,
            login: args.login,
            tty: args.tty,
            yieldTimeMs: args.yieldTimeMs,
            timeoutMs: args.timeoutMs,
            maxOutputChars: args.maxOutputChars,
          },
          runtime,
        )
      },
    },
    {
      source: 'builtin',
      name: 'write_stdin',
      aliases: ['stdin', 'poll_command'],
      description:
        'Write to an existing exec_command session or poll it for more output.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'number',
            description: 'Session id returned by exec_command.',
          },
          chars: {
            type: 'string',
            description: 'Optional text to write to stdin. Leave empty to only poll for more output.',
          },
          closeStdin: {
            type: 'boolean',
            description: 'Close stdin for the session after any optional chars are written.',
          },
          terminate: {
            type: 'boolean',
            description: 'Send a termination signal to the session before collecting more output.',
          },
          signal: {
            type: 'string',
            description: 'Optional signal name when terminate is true. Supported values: SIGINT, SIGTERM, SIGKILL.',
          },
          yieldTimeMs: {
            type: 'number',
            description: 'How long to wait for more output before returning.',
          },
          maxOutputChars: {
            type: 'number',
            description: 'Maximum number of output characters to include in each response.',
          },
        },
        required: ['sessionId'],
      },
      liveUpdates: true,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        return unifiedExec.writeStdin(
          {
            sessionId: args.sessionId,
            chars: args.chars,
            closeStdin: args.closeStdin,
            terminate: args.terminate,
            signal: args.signal,
            yieldTimeMs: args.yieldTimeMs,
            maxOutputChars: args.maxOutputChars,
          },
          runtime,
        )
      },
    },
    {
      source: 'builtin',
      name: 'run_shell',
      aliases: ['bash', 'shell', 'terminal', 'command'],
      approvalCategory: 'shell',
      description:
        'Run a one-shot shell command inside the workspace. Prefer exec_command for long-running or interactive sessions, and keep run_shell focused on short commands. Prefer list_files, glob_files, read_file, and search_code for workspace inspection. Source edits are routed through file editing tools rather than shell scripts.',
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
            enabled: server.enabled === true && server.healthStatus === 'ok',
            healthStatus: server.healthStatus,
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
        const enabled = normalizeStringArray(nextSettings.enabledSkillIds).includes(args.skillId)
        return stringifyOutput({
          skillId: args.skillId,
          enabled,
          usageHint: buildSkillImmediateUseHint(args.skillId, enabled),
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
      name: 'aura_install_skill',
      aliases: ['installauraskill', 'install_skill', 'skill_install'],
      approvalCategory: 'file_write',
      description:
        'Install a skill into Aura from local path, pasted SKILL.md content, raw URL, GitHub source, npm package, or an npx command without executing third-party installer scripts. Use this whenever the user wants to install a skill for Aura.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description:
              'Skill source: local path, URL, github:owner/repo/path, npm package name, or a copied npx install command.',
          },
          sourceType: {
            type: 'string',
            description:
              'Optional source hint: auto, local, content, url, github, npm, or npx. Defaults to auto.',
          },
          content: {
            type: 'string',
            description: 'Optional direct SKILL.md markdown content to install.',
          },
          skillId: {
            type: 'string',
            description: 'Optional target skill id inside Aura.',
          },
          enable: {
            type: 'boolean',
            description: 'Enable the installed skill after copying it.',
          },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const aura = await getAuraState(context)
        const staged = await resolveAuraSkillInstallSource({
          cwd: context.cwd,
          source: args.source || '',
          sourceType: args.sourceType || 'auto',
          content: args.content || '',
          skillId: args.skillId || '',
          signal: runtime.signal,
        })

        try {
          const imported = await copyIntoAuraDirectory({
            cwd: context.cwd,
            kind: 'skills',
            sourcePath: staged.stagedPath,
            targetId: args.skillId || staged.inferredSkillId || '',
            targetRoot: aura.skillsDir,
          })
          if (args.enable !== false) {
            await updateCapabilityEnabled(context, 'skill', imported.id, true)
          } else {
            await refreshAuraState(context)
          }
          const refreshedAura = await getAuraState(context)
          const installedSkill = (refreshedAura.skills || []).find(skill => skill.id === imported.id)
          return stringifyOutput({
            installedFrom: staged.sourceDescription || args.source || 'inline content',
            installedTo: imported.destinationPath,
            skillId: imported.id,
            name: staged.name,
            description: staged.description,
            enabled: args.enable !== false,
            note: staged.note || '',
            usageHint: buildSkillImmediateUseHint(imported.id, args.enable !== false),
            skill: installedSkill || null,
          })
        } finally {
          await staged.cleanup?.()
        }
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
        const aura = await getAuraState(context)
        const imported = await copyIntoAuraDirectory({
          cwd: context.cwd,
          kind: 'skills',
          sourcePath: args.sourcePath,
          targetId: args.skillId || '',
          targetRoot: aura.skillsDir,
        })
        if (args.enable !== false) {
          await updateCapabilityEnabled(context, 'skill', imported.id, true)
        } else {
          await refreshAuraState(context)
        }
        const refreshedAura = await getAuraState(context)
        const installedSkill = (refreshedAura.skills || []).find(skill => skill.id === imported.id)
        return stringifyOutput({
          importedFrom: imported.sourcePath,
          installedTo: imported.destinationPath,
          skillId: imported.id,
          enabled: args.enable !== false,
          usageHint: buildSkillImmediateUseHint(imported.id, args.enable !== false),
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
        const aura = await getAuraState(context)
        const imported = await copyIntoAuraDirectory({
          cwd: context.cwd,
          kind: 'plugins',
          sourcePath: args.sourcePath,
          targetId: args.pluginId || '',
          targetRoot: aura.pluginsDir,
        })
        if (args.enable !== false) {
          await updateCapabilityEnabled(context, 'plugin', imported.id, true)
        } else {
          await refreshAuraState(context)
        }
        const refreshedAura = await getAuraState(context)
        const installedPlugin = (refreshedAura.plugins || []).find(plugin => plugin.id === imported.id)
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
        'Create or update an MCP server entry in Aura settings. New or changed configs stay pending until they pass MCP connection verification.',
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
            description: 'Executable command, or a full inline command such as "npx -y @upstash/context7-mcp@latest".',
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
        return stringifyOutput({
          ...nextServer,
          ready: nextServer.enabled === true && nextServer.healthStatus === 'ok',
          requiresValidation: nextServer.healthStatus !== 'ok',
          note:
            nextServer.healthStatus === 'ok' && nextServer.enabled === true
              ? ''
              : '配置已保存，但还未进入工具池；需要先通过 MCP 连接验证。',
        })
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
    default:
      return true
  }
}

async function resolveApprovalSettings(hooks = {}) {
  if (typeof hooks.appControl === 'function') {
    try {
      const liveSettings = await hooks.appControl('get_settings', {})
      if (liveSettings && typeof liveSettings === 'object') {
        return {
          ...(hooks.settings || {}),
          ...liveSettings,
        }
      }
    } catch {
      // Fall back to the task-start settings snapshot if live settings are unavailable.
    }
  }

  return hooks.settings || {}
}

async function buildEditingApprovalPreview(tool, args, hooks = {}, patchRoot) {
  const rootPath =
    typeof patchRoot === 'string' && patchRoot.trim()
      ? patchRoot
      : typeof hooks.settings?.cwd === 'string' && hooks.settings.cwd.trim()
        ? hooks.settings.cwd
        : ''
  if (!rootPath) {
    return undefined
  }

  try {
    const preview = await buildEditingToolApprovalPreview(rootPath, tool?.name, args, {
      signal: hooks.signal,
    })
    return preview ? stringifyOutput(preview) : undefined
  } catch (error) {
    return stringifyOutput({
      stage: 'edit_transaction_preview',
      phase: 'approval_unavailable',
      operation: 'edit_transaction',
      sourceOperation: tool?.name,
      summary: 'Editing preview is unavailable before approval.',
      error: formatToolError(error),
    })
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
  const shellPatchInterception = resolveShellPatchInterception(tool, args, hooks)
  const shellFileMutationInterception = shellPatchInterception
    ? null
    : resolveShellFileMutationInterception(tool, args)
  const effectiveTool =
    shellPatchInterception?.tool || shellFileMutationInterception?.tool || tool
  const effectiveArgs =
    shellPatchInterception?.args || shellFileMutationInterception?.args || args
  const eventId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const shouldEmitEvent = effectiveTool.internalOnly !== true
  const eventSummary =
    shellPatchInterception?.summary ||
    shellFileMutationInterception?.summary ||
    (typeof effectiveTool.getSummary === 'function'
      ? effectiveTool.getSummary(effectiveArgs) || effectiveTool.description
      : effectiveTool.description)
  const baseEvent = {
    id: eventId,
    source: effectiveTool.source,
    name: effectiveTool.name,
    summary: eventSummary,
    order:
      typeof hooks.timelineOrder === 'number'
        ? hooks.timelineOrder
        : undefined,
    input:
      shellPatchInterception?.originalCommand
        ? `$ ${shellPatchInterception.originalCommand}`
        : shellFileMutationInterception?.originalCommand
          ? `$ ${shellFileMutationInterception.originalCommand}`
        : (
              effectiveTool.name === 'run_shell' &&
              typeof effectiveArgs?.command === 'string'
            ) || (
              effectiveTool.name === 'exec_command' &&
              typeof effectiveArgs?.cmd === 'string'
            )
          ? `$ ${effectiveTool.name === 'exec_command' ? effectiveArgs.cmd : effectiveArgs.command}`
          : stringifyOutput(effectiveArgs ?? {}),
  }

  function updateEvent(partial) {
    if (!shouldEmitEvent) {
      return
    }
    emitToolEvent(
      {
        ...baseEvent,
        ...partial,
      },
      toolEvents,
      hooks,
    )
  }

  const approvalSettings = effectiveTool.approvalCategory
    ? await resolveApprovalSettings(hooks)
    : hooks.settings || {}

  if (effectiveTool.approvalCategory && !isAutoApproved(effectiveTool, approvalSettings)) {
    const approvalPreview = await buildEditingApprovalPreview(
      effectiveTool,
      effectiveArgs,
      hooks,
      shellPatchInterception?.patchRoot,
    )
    const decision = await hooks.requestApproval?.({
      id: eventId,
      category: effectiveTool.approvalCategory,
      toolName: effectiveTool.name,
      summary: effectiveTool.description,
      input: stringifyOutput(effectiveArgs ?? {}),
      output: approvalPreview,
    })

    if (decision !== 'approve') {
      const deniedError = createStructuredError('这一步已被用户拒绝执行。', {
        source:
          effectiveTool.source === 'plugin'
            ? 'plugin'
            : effectiveTool.source === 'mcp'
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
      return `Tool ${effectiveTool.name} was denied by the user.`
    }
  }

  const abortController = hooks.createCurrentStepAbortController?.()
  try {
    hooks?.onPhaseChange?.('tool_running')
    hooks?.onProgress?.()
    updateEvent({
      status: 'running',
      output: '',
      error: undefined,
      errorInfo: undefined,
    })
    throwIfAborted(abortController?.signal, effectiveTool)
    const output = await runAbortable(
      Promise.resolve(
        effectiveTool.run(effectiveArgs, {
          signal: abortController?.signal,
          settings: hooks.settings,
          appControl: hooks.appControl,
          routeState: hooks.routeState,
          researchMode: hooks.researchMode,
          throwIfAborted() {
            throwIfAborted(abortController?.signal, effectiveTool)
          },
          onUpdate(nextOutput) {
            const structuredOutput = structuredEventOutputForTool(
              effectiveTool.name,
              nextOutput,
            )
            updateEvent({
              status: 'running',
              output: stringifyOutput(nextOutput),
              structuredOutput,
            })
          },
          registerTools(nextTools) {
            hooks.registerDynamicTools?.(nextTools)
          },
          requestUserInput(request) {
            return hooks.requestUserInput?.(request)
          },
        }),
      ),
      abortController?.signal,
      effectiveTool,
    )
    const structuredOutput = structuredEventOutputForTool(effectiveTool.name, output)
    updateEvent({
      status: 'success',
      output: stringifyOutput(output),
      structuredOutput,
      error: undefined,
    })
    return stringifyOutput(output)
  } catch (error) {
    const detail = formatToolError(error)
    const normalized = normalizeRuntimeError(error, {
      source:
        effectiveTool.source === 'plugin'
          ? 'plugin'
          : effectiveTool.source === 'mcp'
            ? 'mcp'
            : 'tool',
      operationLabel: effectiveTool.description || effectiveTool.name,
    })
    if (hooks.rethrowToolError?.(error, normalized, effectiveTool) === true) {
      throw error
    }
    updateEvent({
      status: 'error',
      error: detail,
      errorInfo: normalized.errorInfo,
    })
    return [
      normalized.errorInfo.summary,
      normalized.errorInfo.suggestedAction || null,
      normalized.errorInfo.repairHint
        ? `repairHint:\n${stringifyOutput(normalized.errorInfo.repairHint)}`
        : null,
      detail ? `原始错误:\n${detail}` : null,
    ]
      .filter(Boolean)
      .join('\n\n')
  } finally {
    hooks.releaseCurrentStepAbortController?.(abortController)
  }
}
