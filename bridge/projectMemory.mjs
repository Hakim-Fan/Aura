import fs from 'node:fs/promises'
import path from 'node:path'
import { stringifyOutput, truncate } from './utils.mjs'

const MEMORY_DIR = path.join('.aura', 'memory')
const MEMORY_FILES = {
  project: 'project.md',
  decisions: 'decisions.md',
  troubleshooting: 'troubleshooting.md',
  preferences: 'preferences.md',
}
const METADATA_FILE = 'metadata.json'
const SESSIONS_DIR = 'sessions'
const MAX_MEMORY_FILE_CHARS = 24_000
const MAX_LOOKUP_CONTEXT_CHARS = 10_000
const LOOKUP_TASK_TTL_MS = 30 * 60 * 1000
const idleTimers = new Map()
const lookupTasks = new Map()
const updateTasks = new Map()
const updateWriteQueues = new Map()
let lookupSequence = 0

function safeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeWorkspaceRoot(value = '') {
  return safeString(value).replace(/\\/g, '/').replace(/\/+$/g, '')
}

function normalizeComparableRoot(value = '') {
  return normalizeWorkspaceRoot(value).toLowerCase()
}

function localeLabel(settings = {}) {
  const locale = safeString(settings.locale) || 'zh-CN'
  if (locale.toLowerCase().startsWith('zh')) {
    return '简体中文'
  }
  return 'English'
}

function isoDate(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

function nowIso() {
  return new Date().toISOString()
}

function slugify(value = 'memory-update') {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'memory-update'
}

function compactText(value = '', maxChars = 1200) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
    : normalized
}

function stableTaskKeyPart(value = '', maxChars = 400) {
  return compactText(value, maxChars).toLowerCase()
}

function memoryRoot(cwd) {
  return path.join(cwd, MEMORY_DIR)
}

function sessionsRoot(cwd) {
  return path.join(memoryRoot(cwd), SESSIONS_DIR)
}

function isInsideMemoryRoot(cwd, candidate) {
  const root = memoryRoot(cwd)
  const relative = path.relative(root, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function emitMemoryLog(hooks, event, details = {}, level = 'info') {
  try {
    hooks?.onRuntimeLog?.({
      event,
      level,
      details: {
        subsystem: 'project_memory',
        ...details,
      },
    })
  } catch {
    // Memory logging must not affect the foreground task.
  }
}

function projectMemoryScopeKey(settings = {}, scopeId = '') {
  return [
    normalizeComparableRoot(settings.cwd),
    safeString(scopeId) || 'workspace',
  ].join('::')
}

function cleanupLookupTasks(now = Date.now()) {
  for (const [key, entry] of lookupTasks.entries()) {
    const terminalAt = entry.injectedAt || entry.finishedAt
    if (
      terminalAt &&
      now - terminalAt > LOOKUP_TASK_TTL_MS &&
      (entry.injected === true || entry.status === 'failed')
    ) {
      lookupTasks.delete(key)
    }
  }
}

export function isProjectMemoryEnabled(settings = {}) {
  const cwd = normalizeWorkspaceRoot(settings.cwd)
  if (!cwd || settings.projectMemory?.enabled === false) {
    return false
  }
  const disabled = Array.isArray(settings.projectMemory?.disabledWorkspaceRoots)
    ? settings.projectMemory.disabledWorkspaceRoots.map(normalizeComparableRoot)
    : []
  return !disabled.includes(normalizeComparableRoot(cwd))
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function isSymlink(filePath) {
  try {
    return (await fs.lstat(filePath)).isSymbolicLink()
  } catch {
    return false
  }
}

async function assertMemoryRootSafe(cwd) {
  const root = memoryRoot(cwd)
  if (await isSymlink(root)) {
    throw new Error(`Refusing to use symlinked project memory root: ${root}`)
  }
  if (await pathExists(root)) {
    const [realCwd, realRoot] = await Promise.all([
      fs.realpath(cwd),
      fs.realpath(root),
    ])
    const relative = path.relative(realCwd, realRoot)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing to use project memory root outside workspace: ${root}`)
    }
  }
}

async function assertMemoryFileSafe(cwd, target) {
  if (!isInsideMemoryRoot(cwd, target)) {
    throw new Error(`Refusing to access project memory path outside memory root: ${target}`)
  }
  if (await isSymlink(target)) {
    throw new Error(`Refusing to access symlinked project memory file: ${target}`)
  }
  const parent = path.dirname(target)
  if (await pathExists(parent)) {
    const [realRoot, realParent] = await Promise.all([
      fs.realpath(memoryRoot(cwd)),
      fs.realpath(parent),
    ])
    const relative = path.relative(realRoot, realParent)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing to access project memory path outside memory root: ${target}`)
    }
  }
}

async function ensureGitignore(cwd, hooks) {
  const gitignorePath = path.join(cwd, '.gitignore')
  const entry = '.aura/memory/'
  let current = ''
  try {
    current = await fs.readFile(gitignorePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      emitMemoryLog(hooks, 'project_memory.gitignore_failed', {
        cwd,
        error: error instanceof Error ? error.message : String(error),
      }, 'warn')
      return
    }
  }

  const lines = current.split(/\r?\n/u).map(line => line.trim())
  if (lines.includes(entry) || lines.includes('.aura/memory')) {
    return
  }
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  await fs.writeFile(gitignorePath, `${current}${prefix}${entry}\n`, 'utf8')
  emitMemoryLog(hooks, 'project_memory.gitignore_updated', { cwd })
}

function initialMemoryFileContent(kind, settings = {}) {
  const language = localeLabel(settings)
  if (language === '简体中文') {
    const titles = {
      project: '项目摘要',
      decisions: '重要决策',
      troubleshooting: '排查经验',
      preferences: '用户偏好',
    }
    return [
      `# ${titles[kind] || '项目记忆'}`,
      '',
      '<!-- Aura 项目长期记忆。本文件只保存在本机，默认不提交到 git。 -->',
      '',
    ].join('\n')
  }
  const titles = {
    project: 'Project Summary',
    decisions: 'Decisions',
    troubleshooting: 'Troubleshooting',
    preferences: 'Preferences',
  }
  return [
    `# ${titles[kind] || 'Project Memory'}`,
    '',
    '<!-- Aura project long-term memory. This file is local-only and ignored by git by default. -->',
    '',
  ].join('\n')
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function ensureProjectMemoryLayout(settings = {}, hooks) {
  const cwd = normalizeWorkspaceRoot(settings.cwd)
  if (!cwd) {
    return null
  }
  const root = memoryRoot(cwd)
  await assertMemoryRootSafe(cwd)
  await fs.mkdir(root, { recursive: true })
  await assertMemoryRootSafe(cwd)
  await assertMemoryFileSafe(cwd, sessionsRoot(cwd))
  await fs.mkdir(sessionsRoot(cwd), { recursive: true })
  await assertMemoryFileSafe(cwd, sessionsRoot(cwd))
  for (const [kind, fileName] of Object.entries(MEMORY_FILES)) {
    const filePath = path.join(root, fileName)
    await assertMemoryFileSafe(cwd, filePath)
    if (!(await pathExists(filePath))) {
      await fs.writeFile(filePath, initialMemoryFileContent(kind, settings), 'utf8')
    }
  }
  const metadataPath = path.join(root, METADATA_FILE)
  await assertMemoryFileSafe(cwd, metadataPath)
  if (!(await pathExists(metadataPath))) {
    await writeJson(metadataPath, {
      version: 1,
      created_at: nowIso(),
      last_updated: null,
      last_lookup_at: null,
      last_idle_update_at: null,
    })
  }
  await ensureGitignore(cwd, hooks)
  return root
}

async function readMemoryFile(cwd, fileName) {
  const target = path.join(memoryRoot(cwd), fileName)
  try {
    await assertMemoryFileSafe(cwd, target)
  } catch {
    return ''
  }
  try {
    const content = await fs.readFile(target, 'utf8')
    return content.length > MAX_MEMORY_FILE_CHARS
      ? `${content.slice(0, MAX_MEMORY_FILE_CHARS)}\n\n[Truncated by Aura project memory: file exceeds ${MAX_MEMORY_FILE_CHARS} chars.]`
      : content
  } catch {
    return ''
  }
}

async function listSessionFiles(cwd) {
  try {
    const entries = await fs.readdir(sessionsRoot(cwd), { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort()
      .slice(-8)
  } catch {
    return []
  }
}

function tokenizeQuery(query = '') {
  return Array.from(new Set(
    String(query || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_./:-]+/u)
      .map(token => token.trim())
      .filter(token => token.length >= 2)
      .slice(0, 40),
  ))
}

function relevantLines(content = '', tokens = [], maxLines = 18) {
  if (!tokens.length) {
    return ''
  }
  const lines = content.split(/\r?\n/u)
  const matches = []
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase()
    if (tokens.some(token => lower.includes(token))) {
      const start = Math.max(0, index - 1)
      const end = Math.min(lines.length, index + 2)
      matches.push(...lines.slice(start, end))
    }
    if (matches.length >= maxLines) {
      break
    }
  }
  return Array.from(new Set(matches)).join('\n').trim()
}

function buildLookupContext({ cwd, query, memoryFiles, sessions }) {
  const tokens = tokenizeQuery(query)
  const sections = [
    '<project_memory>',
    memoryFiles.project
      ? `项目摘要：\n${truncate(memoryFiles.project, 2600)}`
      : '',
    memoryFiles.preferences
      ? `用户偏好：\n${truncate(memoryFiles.preferences, 1800)}`
      : '',
    relevantLines(memoryFiles.decisions, tokens)
      ? `相关历史决策：\n${relevantLines(memoryFiles.decisions, tokens)}`
      : '',
    relevantLines(memoryFiles.troubleshooting, tokens)
      ? `相关排查经验：\n${relevantLines(memoryFiles.troubleshooting, tokens)}`
      : '',
    sessions.length
      ? `相关阶段总结：\n${sessions.map(entry => `## ${entry.name}\n${truncate(entry.content, 1200)}`).join('\n\n')}`
      : '',
    `memory_root: ${path.join(cwd, MEMORY_DIR)}`,
    '</project_memory>',
  ].filter(Boolean)
  return truncate(sections.join('\n\n'), MAX_LOOKUP_CONTEXT_CHARS)
}

async function readProjectMemorySnapshot(settings = {}, hooks) {
  const cwd = normalizeWorkspaceRoot(settings.cwd)
  await ensureProjectMemoryLayout(settings, hooks)
  const [project, decisions, troubleshooting, preferences] = await Promise.all([
    readMemoryFile(cwd, MEMORY_FILES.project),
    readMemoryFile(cwd, MEMORY_FILES.decisions),
    readMemoryFile(cwd, MEMORY_FILES.troubleshooting),
    readMemoryFile(cwd, MEMORY_FILES.preferences),
  ])
  const sessionNames = await listSessionFiles(cwd)
  const sessionMatches = []
  for (const name of sessionNames) {
    const content = await readMemoryFile(cwd, path.join(SESSIONS_DIR, name))
    sessionMatches.push({ name, content })
  }
  return {
    cwd,
    memoryFiles: { project, decisions, troubleshooting, preferences },
    sessions: sessionMatches,
  }
}

function buildRetrieverAgentPrompt({ settings, query, snapshot }) {
  const language = localeLabel(settings)
  const deterministicContext = buildLookupContext({
    cwd: snapshot.cwd,
    query,
    memoryFiles: snapshot.memoryFiles,
    sessions: snapshot.sessions.slice(-3),
  })
  const fullSnapshot = [
    `memory_root: ${path.join(snapshot.cwd, MEMORY_DIR)}`,
    `project.md:\n${truncate(snapshot.memoryFiles.project, 6000)}`,
    `preferences.md:\n${truncate(snapshot.memoryFiles.preferences, 4000)}`,
    `decisions.md:\n${truncate(snapshot.memoryFiles.decisions, 6000)}`,
    `troubleshooting.md:\n${truncate(snapshot.memoryFiles.troubleshooting, 6000)}`,
    snapshot.sessions.length
      ? `recent sessions:\n${snapshot.sessions.slice(-8).map(entry =>
          `## ${entry.name}\n${truncate(entry.content, 1800)}`,
        ).join('\n\n')}`
      : '',
  ].filter(Boolean).join('\n\n')
  return [
    `You are Aura project-memory retriever, an internal task-time memory query subagent. Answer in ${language}.`,
    'You are an internal asynchronous subagent. Do not answer the user directly.',
    'Use only the provided local project memory snapshot. Do not invent facts.',
    'Return only one <project_memory>...</project_memory> block.',
    'Include only durable memory relevant to the query. If nothing is relevant, return <project_memory></project_memory>.',
    '',
    `Query:\n${query}`,
    '',
    `Fast relevance seed:\n${deterministicContext}`,
    '',
    `Full local project memory snapshot:\n${truncate(fullSnapshot, 28_000)}`,
  ].join('\n')
}

function extractProjectMemoryBlock(value = '') {
  const text = safeString(value)
  if (!text) {
    return ''
  }
  const match = text.match(/<project_memory>([\s\S]*?)<\/project_memory>/iu)
  if (match) {
    const body = safeString(match[1])
    return body ? `<project_memory>\n${body}\n</project_memory>` : ''
  }
  return `<project_memory>\n${truncate(text, MAX_LOOKUP_CONTEXT_CHARS - 64)}\n</project_memory>`
}

function createSilentMemoryHooks(hooks) {
  return {
    onRuntimeLog: hooks?.onRuntimeLog,
    onUsage: hooks?.onUsage,
    onPhaseChange() {},
    onProgress() {},
    onReasoningDelta() {},
    onToolCatalogEvent() {},
    onRouteDecision() {},
    onToolCallStart() {},
    onToolCallEnd() {},
  }
}

async function runLookup(entry, settings, hooks, runNestedAgent) {
  if (typeof runNestedAgent !== 'function') {
    throw new Error('Project memory retrieval requires a nested project_memory_retriever runner.')
  }
  const snapshot = await readProjectMemorySnapshot(settings, hooks)
  const result = await runNestedAgent({
    settings: {
      ...resolveMemoryModelSettings(settings),
      cwd: snapshot.cwd,
      enableMultiAgent: false,
      projectMemory: {
        ...(settings.projectMemory || {}),
        enabled: false,
      },
    },
    messages: [
      {
        role: 'user',
        content: buildRetrieverAgentPrompt({
          settings,
          query: entry.query,
          snapshot,
        }),
      },
    ],
    hooks: createSilentMemoryHooks(hooks),
    runtime: {
      subagentDepth: 1,
      subagentRole: 'project_memory_retriever',
      subagentTaskName: 'project_memory_retriever',
      skipProjectMemoryIdleUpdate: true,
    },
  })
  const metadataPath = path.join(memoryRoot(snapshot.cwd), METADATA_FILE)
  const metadata = await readJson(metadataPath, {})
  await writeJson(metadataPath, {
    ...metadata,
    last_lookup_at: nowIso(),
  })
  return extractProjectMemoryBlock(result?.message)
}

export function createProjectMemoryRuntime({
  settings = {},
  messages = [],
  hooks = {},
  runNestedAgent,
  scopeId = '',
} = {}) {
  const scopeKey = projectMemoryScopeKey(settings, scopeId)

  function latestUserRequest() {
    const latest = [...messages].reverse().find(message => message?.role === 'user')
    return safeString(latest?.content)
  }

  function keyFor(query) {
    return [
      scopeKey,
      stableTaskKeyPart(query, 400),
    ].join('::')
  }

  function scopedEntries() {
    cleanupLookupTasks()
    return [...lookupTasks.values()].filter(entry => entry.scopeKey === scopeKey)
  }

  function startLookup(args = {}) {
    const query = safeString(args.query || args.request || args.topic) || latestUserRequest()
    const key = keyFor(query)
    cleanupLookupTasks()
    const existing = lookupTasks.get(key)
    if (existing && existing.status !== 'failed') {
      if (existing.status === 'done' && existing.injected === true) {
        lookupTasks.delete(key)
      } else {
        return existing
      }
    }
    const entry = {
      key,
      scopeKey,
      query,
      status: 'pending',
      memoryTaskId: `memory-retrieval-${Date.now().toString(36)}-${lookupSequence += 1}`,
      result: '',
      injected: false,
      injectedAt: null,
      startedAt: Date.now(),
      finishedAt: null,
      promise: null,
    }
    entry.promise = runLookup(entry, settings, hooks, runNestedAgent)
      .then(result => {
        entry.status = 'done'
        entry.result = result
        entry.finishedAt = Date.now()
        emitMemoryLog(hooks, 'project_memory.lookup_done', {
          memoryTaskId: entry.memoryTaskId,
          query: compactText(query, 300),
          resultChars: result.length,
        })
        return result
      })
      .catch(error => {
        entry.status = 'failed'
        entry.error = error instanceof Error ? error.message : String(error)
        entry.finishedAt = Date.now()
        emitMemoryLog(hooks, 'project_memory.lookup_failed', {
          memoryTaskId: entry.memoryTaskId,
          error: entry.error,
        }, 'warn')
        return ''
      })
    lookupTasks.set(key, entry)
    emitMemoryLog(hooks, 'project_memory.lookup_started', {
      memoryTaskId: entry.memoryTaskId,
      query: compactText(query, 300),
    })
    return entry
  }

  function drainReadyContext() {
    const ready = scopedEntries().filter(entry =>
      entry.status === 'done' && entry.result && entry.injected !== true,
    )
    for (const entry of ready) {
      entry.injected = true
      entry.injectedAt = Date.now()
    }
    if (ready.length === 0) {
      return ''
    }
    return ready.map(entry => entry.result).join('\n\n')
  }

  function hasReadyContext() {
    return scopedEntries().some(entry =>
      entry.injected !== true && entry.status === 'done' && entry.result,
    )
  }

  function hasPendingLookup() {
    return scopedEntries().some(entry =>
      entry.injected !== true && entry.status === 'pending',
    )
  }

  async function waitForUninjectedLookups() {
    const pending = scopedEntries().filter(entry =>
      entry.injected !== true && entry.status === 'pending' && entry.promise,
    )
    if (pending.length === 0) {
      return
    }
    await Promise.allSettled(pending.map(entry => entry.promise))
  }

  return {
    startLookup,
    drainReadyContext,
    hasReadyContext,
    hasPendingLookup,
    waitForUninjectedLookups,
  }
}

export async function runSpawnMemoryAgentTool(context, args = {}, runtime = {}) {
  runtime.throwIfAborted?.()
  const memoryRuntime = context.projectMemoryRuntime
  if (!memoryRuntime || !isProjectMemoryEnabled(context.settings)) {
    return stringifyOutput({
      status: 'disabled',
      message: 'Project memory is disabled for this workspace.',
    })
  }
  const entry = memoryRuntime.startLookup(args)
  return stringifyOutput({
    status: entry.status,
    memory_task_id: entry.memoryTaskId,
    message: 'project_memory_retriever is running in the background. Results will be injected into a later model call when ready.',
  })
}

function resolveMemoryModelSettings(settings = {}) {
  const projectMemory = settings.projectMemory || {}
  if (!projectMemory.providerProfileId || !projectMemory.model) {
    return settings
  }
  const profile = Array.isArray(settings.providerProfiles)
    ? settings.providerProfiles.find(entry => entry?.id === projectMemory.providerProfileId)
    : null
  if (!profile) {
    return settings
  }
  return {
    ...settings,
    provider: profile.provider || settings.provider,
    apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : settings.apiKey,
    baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : settings.baseUrl,
    model: projectMemory.model,
  }
}

function summarizeMessagesForMemory(messages = [], maxMessages = 12) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-maxMessages)
    .map(message => `${message.role || 'message'}: ${compactText(message.content, 900)}`)
    .join('\n\n')
}

function summarizeToolEvents(toolEvents = []) {
  return (Array.isArray(toolEvents) ? toolEvents : [])
    .slice(-16)
    .map(event => `- ${event?.name || 'tool'} [${event?.status || 'unknown'}]: ${compactText(event?.summary || event?.error || event?.output, 260)}`)
    .join('\n')
}

function buildMemoryOrganizerPrompt({ settings, messages, result, notes, reason, snapshot }) {
  const language = localeLabel(settings)
  return [
    'You are Aura project-memory organizer, an internal background memory organization subagent.',
    `Write durable local project memory draft in ${language}.`,
    'Use only evidence from the supplied conversation summary, tool evidence, final result, and explicit user notes.',
    'Do not invent facts. Do not store secrets, tokens, credentials, generic plans, raw chain-of-thought, or temporary speculation.',
    'Return strict JSON with keys: project, decisions, troubleshooting, preferences, session_title, session_summary.',
    'Each value must be a concise markdown string. Use empty strings for fields that should not be updated.',
    'Respect manual user edits in existing memory. Do not rewrite the existing files; produce only incremental additions.',
    '',
    `Update reason: ${reason}`,
    notes ? `Explicit notes:\n${notes}` : '',
    `Recent conversation:\n${summarizeMessagesForMemory(messages)}`,
    result?.message ? `Final answer:\n${compactText(result.message, 1800)}` : '',
    Array.isArray(result?.toolEvents) ? `Tool evidence:\n${summarizeToolEvents(result.toolEvents)}` : '',
    `Existing project memory snapshot:\n${truncate(buildLookupContext({
      cwd: snapshot.cwd,
      query: [
        notes,
        result?.message,
        summarizeMessagesForMemory(messages, 4),
      ].filter(Boolean).join('\n'),
      memoryFiles: snapshot.memoryFiles,
      sessions: snapshot.sessions.slice(-3),
    }), 12_000)}`,
  ].filter(Boolean).join('\n\n')
}

function parseMemoryDraft(text = '') {
  const normalized = safeString(text)
    .replace(/^```json\s*/iu, '')
    .replace(/```$/u, '')
    .trim()
  if (!normalized) {
    return null
  }
  try {
    const parsed = JSON.parse(normalized)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    const match = normalized.match(/\{[\s\S]*\}/u)
    if (match) {
      try {
        const parsed = JSON.parse(match[0])
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return {
          session_title: 'memory update',
          session_summary: normalized,
        }
      }
    }
    return {
      session_title: 'memory update',
      session_summary: normalized,
    }
  }
}

async function generateMemoryDraftWithAgent({
  settings,
  messages,
  result,
  notes,
  reason,
  hooks,
  runNestedAgent,
}) {
  if (typeof runNestedAgent !== 'function') {
    throw new Error('Project memory update requires a nested memory organizer agent runner.')
  }
  const snapshot = await readProjectMemorySnapshot(settings, hooks)
  const effectiveSettings = resolveMemoryModelSettings(settings)
  const generated = await runNestedAgent({
    settings: {
      ...effectiveSettings,
      cwd: snapshot.cwd,
      enableMultiAgent: false,
      projectMemory: {
        ...(settings.projectMemory || {}),
        enabled: false,
      },
    },
    messages: [
      {
        role: 'user',
        content: buildMemoryOrganizerPrompt({
          settings,
          messages,
          result,
          notes,
          reason,
          snapshot,
        }),
      },
    ],
    hooks: createSilentMemoryHooks(hooks),
    runtime: {
      subagentDepth: 1,
      subagentRole: 'project_memory_organizer',
      subagentTaskName: 'project_memory_organizer',
      skipProjectMemoryIdleUpdate: true,
    },
  })
  const text = safeString(generated?.message)
  if (!text) {
    return null
  }
  return parseMemoryDraft(text)
}

async function appendSection(cwd, fileName, title, body) {
  const normalized = safeString(body)
  if (!normalized) {
    return false
  }
  const target = path.join(memoryRoot(cwd), fileName)
  await assertMemoryFileSafe(cwd, target)
  const current = await fs.readFile(target, 'utf8').catch(() => '')
  const separator = current.endsWith('\n') ? '\n' : '\n\n'
  await fs.writeFile(target, `${current}${separator}## ${title}\n\n${normalized}\n`, 'utf8')
  return true
}

async function writeSessionSummary(cwd, title, summary) {
  const normalized = safeString(summary)
  if (!normalized) {
    return false
  }
  const fileName = `${isoDate()}-${slugify(title)}.md`
  const target = path.join(sessionsRoot(cwd), fileName)
  await assertMemoryFileSafe(cwd, target)
  const heading = `# ${safeString(title) || 'Memory update'}`
  const current = await fs.readFile(target, 'utf8').catch(() => `${heading}\n\n`)
  const separator = current.endsWith('\n') ? '\n' : '\n\n'
  await fs.writeFile(target, `${current}${separator}## ${nowIso()}\n\n${normalized}\n`, 'utf8')
  return true
}

function enqueueProjectMemoryUpdate(cwd, task) {
  const previous = updateWriteQueues.get(cwd) || Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  updateWriteQueues.set(cwd, current)
  current.then(() => {
    if (updateWriteQueues.get(cwd) === current) {
      updateWriteQueues.delete(cwd)
    }
  }, () => {
    if (updateWriteQueues.get(cwd) === current) {
      updateWriteQueues.delete(cwd)
    }
  })
  return current
}

async function updateProjectMemoryNowUnlocked({
  settings = {},
  messages = [],
  result = {},
  notes = '',
  reason = 'manual',
  hooks,
  runNestedAgent,
} = {}) {
  if (!isProjectMemoryEnabled(settings)) {
    return { status: 'skipped', reason: 'disabled' }
  }
  const cwd = normalizeWorkspaceRoot(settings.cwd)
  await ensureProjectMemoryLayout(settings, hooks)
  emitMemoryLog(hooks, 'project_memory.update_started', { cwd, reason })
  let draft = null
  try {
    draft = await generateMemoryDraftWithAgent({
      settings,
      messages,
      result,
      notes,
      reason,
      hooks,
      runNestedAgent,
    })
  } catch (error) {
    emitMemoryLog(hooks, 'project_memory.update_model_failed', {
      cwd,
      reason,
      error: error instanceof Error ? error.message : String(error),
    }, 'warn')
  }
  if (!draft) {
    emitMemoryLog(hooks, 'project_memory.update_skipped', {
      cwd,
      reason,
      skipReason: 'memory_organizer_returned_no_draft',
    }, 'warn')
    return { status: 'skipped', reason: 'memory_organizer_returned_no_draft' }
  }
  const sectionTitle = `${isoDate()} ${reason === 'idle' ? '空闲更新' : '记忆更新'}`
  const changedFiles = []
  if (await appendSection(cwd, MEMORY_FILES.project, sectionTitle, draft.project)) {
    changedFiles.push(MEMORY_FILES.project)
  }
  if (await appendSection(cwd, MEMORY_FILES.decisions, sectionTitle, draft.decisions)) {
    changedFiles.push(MEMORY_FILES.decisions)
  }
  if (await appendSection(cwd, MEMORY_FILES.troubleshooting, sectionTitle, draft.troubleshooting)) {
    changedFiles.push(MEMORY_FILES.troubleshooting)
  }
  if (await appendSection(cwd, MEMORY_FILES.preferences, sectionTitle, draft.preferences)) {
    changedFiles.push(MEMORY_FILES.preferences)
  }
  if (await writeSessionSummary(
    cwd,
    draft.session_title || sectionTitle,
    draft.session_summary || safeString(notes),
  )) {
    changedFiles.push(`${SESSIONS_DIR}/${isoDate()}-${slugify(draft.session_title || sectionTitle)}.md`)
  }
  const metadataPath = path.join(memoryRoot(cwd), METADATA_FILE)
  const metadata = await readJson(metadataPath, {})
  await writeJson(metadataPath, {
    ...metadata,
    last_updated: nowIso(),
    last_update_reason: reason,
    last_idle_update_at: reason === 'idle' ? nowIso() : metadata.last_idle_update_at || null,
  })
  emitMemoryLog(hooks, 'project_memory.update_done', {
    cwd,
    reason,
    changedFiles,
  })
  return {
    status: 'updated',
    changedFiles,
  }
}

export async function updateProjectMemoryNow(options = {}) {
  if (!isProjectMemoryEnabled(options.settings || {})) {
    return { status: 'skipped', reason: 'disabled' }
  }
  const cwd = normalizeWorkspaceRoot(options.settings?.cwd)
  if (!cwd) {
    return { status: 'skipped', reason: 'missing_cwd' }
  }
  return enqueueProjectMemoryUpdate(cwd, () => updateProjectMemoryNowUnlocked(options))
}

export function startProjectMemoryUpdateAgent({
  settings = {},
  messages = [],
  result = {},
  notes = '',
  reason = 'manual',
  hooks,
  runNestedAgent,
} = {}) {
  if (!isProjectMemoryEnabled(settings)) {
    return { status: 'skipped', reason: 'disabled' }
  }
  const cwd = normalizeWorkspaceRoot(settings.cwd)
  const key = [
    cwd,
    reason,
    stableTaskKeyPart(notes || result?.message || summarizeMessagesForMemory(messages, 2), 240),
  ].join('::')
  const existing = updateTasks.get(key)
  if (existing) {
    return {
      status: 'scheduled',
      memoryTaskId: existing.memoryTaskId,
      deduped: true,
    }
  }
  const memoryTaskId = `memory-organizer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const promise = updateProjectMemoryNow({
    settings,
    messages,
    result,
    notes,
    reason,
    hooks,
    runNestedAgent,
  }).catch(error => {
    emitMemoryLog(hooks, 'project_memory.update_failed', {
      cwd,
      reason,
      memoryTaskId,
      error: error instanceof Error ? error.message : String(error),
    }, 'warn')
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }).finally(() => {
    updateTasks.delete(key)
  })
  updateTasks.set(key, { memoryTaskId, promise })
  emitMemoryLog(hooks, 'project_memory.update_agent_started', {
    cwd,
    reason,
    memoryTaskId,
  })
  return {
    status: 'scheduled',
    memoryTaskId,
  }
}

async function shouldRunIdleUpdate(settings = {}, hooks, thresholdHours = 4) {
  const cwd = normalizeWorkspaceRoot(settings.cwd)
  try {
    await ensureProjectMemoryLayout(settings, hooks)
    const metadata = await readJson(path.join(memoryRoot(cwd), METADATA_FILE), {})
    const latestUpdate = [metadata.last_updated, metadata.last_idle_update_at]
      .map(value => Date.parse(value))
      .filter(value => Number.isFinite(value))
      .sort((a, b) => b - a)[0]
    if (!latestUpdate) {
      return true
    }
    return Date.now() - latestUpdate >= thresholdHours * 60 * 60 * 1000
  } catch (error) {
    emitMemoryLog(hooks, 'project_memory.idle_update_check_failed', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    }, 'warn')
    return false
  }
}

export function scheduleProjectMemoryIdleUpdate({
  settings = {},
  messages = [],
  result = {},
  hooks,
  runNestedAgent,
} = {}) {
  if (!isProjectMemoryEnabled(settings)) {
    return
  }
  const cwd = normalizeWorkspaceRoot(settings.cwd)
  if (!cwd) {
    return
  }
  const thresholdHours = Math.max(
    1,
    Math.min(72, Number(settings.projectMemory?.idleUpdateThresholdHours) || 4),
  )
  const existing = idleTimers.get(cwd)
  if (existing) {
    clearTimeout(existing)
  }
  const timer = setTimeout(async () => {
    idleTimers.delete(cwd)
    if (!(await shouldRunIdleUpdate(settings, hooks, thresholdHours))) {
      emitMemoryLog(hooks, 'project_memory.idle_update_skipped_recent', {
        cwd,
        thresholdHours,
      })
      return
    }
    startProjectMemoryUpdateAgent({
      settings,
      messages,
      result,
      reason: 'idle',
      hooks,
      runNestedAgent,
    })
  }, thresholdHours * 60 * 60 * 1000)
  timer.unref?.()
  idleTimers.set(cwd, timer)
  emitMemoryLog(hooks, 'project_memory.idle_update_scheduled', {
    cwd,
    thresholdHours,
  })
}
