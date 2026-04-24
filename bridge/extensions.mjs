import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStructuredError } from './runtimeErrors.mjs'
import { readCache, normalizeCacheKey, writeCache } from './web/shared/cache.mjs'
import {
  readPersistentCacheEntry,
  writePersistentCache,
} from './web/shared/persistentCache.mjs'
import { stringifyOutput } from './utils.mjs'

const PLUGIN_METADATA_CACHE = new Map()
const PLUGIN_METADATA_NAMESPACE = 'plugin-tools'
const PLUGIN_METADATA_CACHE_MAX_ENTRIES = 128
const PLUGIN_METADATA_TTL_MS = 15 * 60_000
const PLUGIN_RUNTIME_CACHE = new Map()
const SKILL_METADATA_CACHE = new Map()
const SKILL_METADATA_NAMESPACE = 'skill-catalog'
const SKILL_METADATA_CACHE_MAX_ENTRIES = 128
const SKILL_METADATA_TTL_MS = 15 * 60_000

function resolveAuraHome() {
  return path.join(os.homedir(), '.aura')
}

function ensureAppControl(context) {
  return typeof context?.appControl === 'function' ? context.appControl : null
}

async function getAuraState(context) {
  const appControl = ensureAppControl(context)
  if (!appControl) {
    return null
  }

  try {
    return await appControl('ensure_aura_home', {})
  } catch {
    return null
  }
}

async function resolveAuraAssetPath(kind, id, extension) {
  const directFilePath = path.join(resolveAuraHome(), kind, `${id}.${extension}`)
  try {
    await fs.access(directFilePath)
    return directFilePath
  } catch {
    if (kind === 'skills') {
      const directorySkillPath = path.join(resolveAuraHome(), kind, id, 'SKILL.md')
      try {
        await fs.access(directorySkillPath)
        return directorySkillPath
      } catch {
        return null
      }
    }
    return null
  }
}

async function resolveAuraPluginModulePath(id) {
  for (const extension of ['mjs', 'js']) {
    const directFilePath = path.join(resolveAuraHome(), 'plugins', `${id}.${extension}`)
    try {
      await fs.access(directFilePath)
      return directFilePath
    } catch {}
  }

  const pluginDir = path.join(resolveAuraHome(), 'plugins', id)
  try {
    await fs.access(pluginDir)
  } catch {
    return null
  }

  const manifestPath = path.join(pluginDir, 'manifest.json')
  try {
    const manifestContent = await fs.readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestContent)
    if (typeof manifest.main === 'string' && manifest.main.trim()) {
      const mainPath = path.join(pluginDir, manifest.main)
      try {
        await fs.access(mainPath)
        return mainPath
      } catch {
        return null
      }
    }
  } catch {}

  for (const candidate of ['main.mjs', 'index.mjs', 'plugin.mjs', 'main.js', 'index.js']) {
    const candidatePath = path.join(pluginDir, candidate)
    try {
      await fs.access(candidatePath)
      return candidatePath
    } catch {}
  }

  return null
}

async function resolveBundledPluginModulePath(appRoot, id) {
  for (const extension of ['mjs', 'js']) {
    const filePath = path.join(appRoot, 'plugins', `${id}.${extension}`)
    try {
      await fs.access(filePath)
      return filePath
    } catch {}
  }

  return null
}

async function statAssetEntry(filePath) {
  try {
    const stat = await fs.stat(filePath)
    return {
      size: Number(stat.size) || 0,
      mtimeMs: Math.round(Number(stat.mtimeMs) || 0),
    }
  } catch {
    return null
  }
}

function buildAssetVersionToken(filePath, stat) {
  return `${filePath}:${stat?.size || 0}:${stat?.mtimeMs || 0}`
}

function prettifyIdentifier(value) {
  return String(value || '')
    .split(/[_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/\*([^*]+)\*/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitFrontmatter(content) {
  const normalized = String(content || '').replace(/^\uFEFF/u, '')
  if (!normalized.startsWith('---\n')) {
    return {
      frontmatter: '',
      body: normalized,
    }
  }

  const remainder = normalized.slice(4)
  const endIndex = remainder.indexOf('\n---\n')
  if (endIndex < 0) {
    return {
      frontmatter: '',
      body: normalized,
    }
  }

  return {
    frontmatter: remainder.slice(0, endIndex),
    body: remainder.slice(endIndex + 5),
  }
}

function extractMetadataField(frontmatter, fieldName) {
  const lines = String(frontmatter || '').split(/\r?\n/u)
  const needle = `${fieldName}:`

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.toLowerCase().startsWith(needle.toLowerCase())) {
      continue
    }
    const value = trimmed
      .slice(needle.length)
      .trim()
      .replace(/^['"]|['"]$/gu, '')
      .trim()
    if (value) {
      return value
    }
  }

  return ''
}

function extractListMetadataField(frontmatter, fieldName) {
  const lines = String(frontmatter || '').split(/\r?\n/u)
  const needle = `${fieldName}:`
  const items = []
  let collecting = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!collecting) {
      if (!trimmed.toLowerCase().startsWith(needle.toLowerCase())) {
        continue
      }

      const inlineValue = trimmed.slice(needle.length).trim()
      if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
        return inlineValue
          .slice(1, -1)
          .split(',')
          .map(entry => entry.trim().replace(/^['"]|['"]$/gu, ''))
          .filter(Boolean)
      }

      collecting = true
      continue
    }

    if (!trimmed) {
      if (items.length > 0) {
        break
      }
      continue
    }

    if (!trimmed.startsWith('- ')) {
      break
    }

    const value = trimmed.slice(2).trim().replace(/^['"]|['"]$/gu, '')
    if (value) {
      items.push(value)
    }
  }

  return items
}

function normalizeSkillBody(content) {
  return String(content || '')
    .split(/\r?\n/u)
    .map(line => line.replace(/\s+$/u, ''))
    .join('\n')
    .trim()
}

function summarizeSkillContent(skillId, content) {
  const { frontmatter, body } = splitFrontmatter(content)
  const lines = normalizeSkillBody(body)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
  const heading = lines.find(line => line.startsWith('#'))
  const title =
    extractMetadataField(frontmatter, 'name') ||
    stripMarkdown(heading || '') ||
    prettifyIdentifier(skillId)
  const bullets = lines
    .filter(line => /^[-*+]\s+/u.test(line))
    .map(line => stripMarkdown(line))
    .filter(Boolean)
  const paragraph = lines
    .filter(line => !line.startsWith('#') && !/^[-*+]\s+/u.test(line))
    .map(line => stripMarkdown(line))
    .find(Boolean)

  const summary = [paragraph, ...bullets]
    .filter(Boolean)
    .join('；')
    .slice(0, 420)

  return {
    title,
    description: extractMetadataField(frontmatter, 'description') || paragraph || '',
    summary: summary || 'Use this skill when it is directly relevant to the task.',
    keywords: [title, paragraph, ...bullets].filter(Boolean),
    allowedTools: extractListMetadataField(frontmatter, 'allowed-tools'),
    body: normalizeSkillBody(body),
  }
}

function buildPluginLoadError(pluginId, filePath, error) {
  return createStructuredError(`插件“${pluginId}”加载失败。`, {
    source: 'plugin',
    category: 'execution_failed',
    code:
      error && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'PLUGIN_LOAD_FAILED',
    detail: [
      `Plugin id: ${pluginId}`,
      `Entry path: ${filePath}`,
      error instanceof Error ? error.stack || error.message : String(error),
    ]
      .filter(Boolean)
      .join('\n'),
    suggestedAction: '请检查插件入口文件是否存在、导出格式是否正确，以及插件代码是否能在当前环境下正常加载。',
  })
}

function buildPluginToolLookupError(pluginId, toolName, filePath) {
  return createStructuredError(`插件工具“${pluginId}/${toolName}”当前不可用。`, {
    source: 'plugin',
    category: 'not_found',
    code: 'PLUGIN_TOOL_NOT_FOUND',
    detail: [
      `Plugin id: ${pluginId}`,
      `Tool name: ${toolName}`,
      `Entry path: ${filePath}`,
    ].join('\n'),
    suggestedAction: '请检查插件是否仍然导出了这个工具，或重新加载插件后再试。',
  })
}

function sanitizePluginSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      type: 'object',
      properties: {},
    }
  }

  try {
    return JSON.parse(JSON.stringify(schema))
  } catch {
    return {
      type: 'object',
      properties: {},
    }
  }
}

function resolvePluginExport(module) {
  return module?.plugin || module?.default?.plugin || module?.default
}

function normalizePluginToolMetadata(tool) {
  const localName = typeof tool?.name === 'string' ? tool.name.trim() : ''
  if (!localName) {
    return null
  }

  return {
    localName,
    aliases: Array.isArray(tool?.aliases)
      ? tool.aliases.filter(entry => typeof entry === 'string' && entry.trim())
      : [],
    approvalCategory:
      tool?.approvalCategory === 'shell' ||
      tool?.approvalCategory === 'file_write' ||
      tool?.approvalCategory === 'computer_use'
        ? tool.approvalCategory
        : undefined,
    description:
      typeof tool?.description === 'string' && tool.description.trim()
        ? tool.description.trim()
        : localName,
    inputSchema: sanitizePluginSchema(tool?.inputSchema),
  }
}

function normalizePluginMetadata(plugin, fallbackPluginId) {
  const pluginId =
    typeof plugin?.id === 'string' && plugin.id.trim()
      ? plugin.id.trim()
      : String(fallbackPluginId || '').trim()
  if (!pluginId) {
    return null
  }

  const tools = Array.isArray(plugin?.tools)
    ? plugin.tools.map(normalizePluginToolMetadata).filter(Boolean)
    : []
  if (tools.length === 0) {
    return null
  }

  return {
    id: pluginId,
    name:
      typeof plugin?.name === 'string' && plugin.name.trim()
        ? plugin.name.trim()
        : prettifyIdentifier(pluginId),
    description:
      typeof plugin?.description === 'string' ? plugin.description.trim() : '',
    tools,
  }
}

function normalizeCachedPluginMetadata(value, fallbackPluginId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return normalizePluginMetadata(
    {
      id: value.id || fallbackPluginId,
      name: value.name,
      description: value.description,
      tools: Array.isArray(value.tools)
        ? value.tools.map(tool => ({
            name: tool?.localName,
            aliases: tool?.aliases,
            approvalCategory: tool?.approvalCategory,
            description: tool?.description,
            inputSchema: tool?.inputSchema,
          }))
        : [],
    },
    fallbackPluginId,
  )
}

function buildPluginMetadataCacheKey(pluginId, filePath, versionToken) {
  return normalizeCacheKey(
    JSON.stringify({
      pluginId,
      filePath,
      versionToken,
    }),
  )
}

function buildSkillMetadataCacheKey(skillId, filePath, versionToken) {
  return normalizeCacheKey(
    JSON.stringify({
      skillId,
      filePath,
      versionToken,
    }),
  )
}

function readPluginMetadataCache(cacheKey) {
  const inMemory = readCache(PLUGIN_METADATA_CACHE, cacheKey)
  if (inMemory) {
    return {
      value: inMemory,
      layer: 'memory',
    }
  }

  const persisted = readPersistentCacheEntry(PLUGIN_METADATA_NAMESPACE, cacheKey, {
    maxEntries: PLUGIN_METADATA_CACHE_MAX_ENTRIES,
  })
  if (!persisted) {
    return null
  }

  writeCache(
    PLUGIN_METADATA_CACHE,
    cacheKey,
    persisted.value,
    Math.max(1, persisted.expiresAt - Date.now()),
  )
  return {
    value: persisted.value,
    layer: 'persistent',
  }
}

function writePluginMetadataCache(cacheKey, value, ttlMs = PLUGIN_METADATA_TTL_MS) {
  writeCache(PLUGIN_METADATA_CACHE, cacheKey, value, ttlMs)
  writePersistentCache(PLUGIN_METADATA_NAMESPACE, cacheKey, value, ttlMs, {
    maxEntries: PLUGIN_METADATA_CACHE_MAX_ENTRIES,
  })
}

function readSkillMetadataCache(cacheKey) {
  const inMemory = readCache(SKILL_METADATA_CACHE, cacheKey)
  if (inMemory) {
    return {
      value: inMemory,
      layer: 'memory',
    }
  }

  const persisted = readPersistentCacheEntry(SKILL_METADATA_NAMESPACE, cacheKey, {
    maxEntries: SKILL_METADATA_CACHE_MAX_ENTRIES,
  })
  if (!persisted) {
    return null
  }

  writeCache(
    SKILL_METADATA_CACHE,
    cacheKey,
    persisted.value,
    Math.max(1, persisted.expiresAt - Date.now()),
  )
  return {
    value: persisted.value,
    layer: 'persistent',
  }
}

function writeSkillMetadataCache(cacheKey, value, ttlMs = SKILL_METADATA_TTL_MS) {
  writeCache(SKILL_METADATA_CACHE, cacheKey, value, ttlMs)
  writePersistentCache(SKILL_METADATA_NAMESPACE, cacheKey, value, ttlMs, {
    maxEntries: SKILL_METADATA_CACHE_MAX_ENTRIES,
  })
}

function normalizeCachedSkillMetadata(value, fallbackSkillId, fallbackPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : fallbackSkillId,
    name:
      typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : prettifyIdentifier(fallbackSkillId),
    filePath:
      typeof value.filePath === 'string' && value.filePath.trim()
        ? value.filePath
        : fallbackPath,
    content: typeof value.content === 'string' ? value.content : '',
    body: typeof value.body === 'string' ? value.body : '',
    description: typeof value.description === 'string' ? value.description : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    keywords: Array.isArray(value.keywords)
      ? value.keywords.filter(entry => typeof entry === 'string' && entry.trim())
      : [],
    allowedTools: Array.isArray(value.allowedTools)
      ? value.allowedTools.filter(entry => typeof entry === 'string' && entry.trim())
      : [],
  }
}

async function importPluginRuntime(filePath, versionToken, pluginId) {
  const runtimeKey = `${filePath}::${versionToken}`
  const cached = PLUGIN_RUNTIME_CACHE.get(runtimeKey)
  if (cached) {
    return cached
  }

  const loadPromise = (async () => {
    try {
      const moduleUrl = new URL(pathToFileURL(filePath).href)
      moduleUrl.searchParams.set('v', versionToken)
      const module = await import(moduleUrl.href)
      const plugin = resolvePluginExport(module)
      const normalized = normalizePluginMetadata(plugin, pluginId)
      if (!normalized) {
        throw new Error('Plugin did not export a valid tool definition set.')
      }

      const toolMap = new Map()
      for (const tool of Array.isArray(plugin?.tools) ? plugin.tools : []) {
        if (typeof tool?.name === 'string' && tool.name.trim()) {
          toolMap.set(tool.name.trim(), tool)
        }
      }

      return {
        plugin: normalized,
        toolMap,
      }
    } catch (error) {
      throw buildPluginLoadError(pluginId, filePath, error)
    }
  })()

  PLUGIN_RUNTIME_CACHE.set(runtimeKey, loadPromise)
  return loadPromise
}

function buildPluginActivationHint(pluginEntry, pluginMetadata) {
  const pluginName =
    pluginMetadata?.name ||
    (typeof pluginEntry?.name === 'string' && pluginEntry.name.trim()) ||
    pluginEntry?.id ||
    'this plugin'
  const pluginId = pluginMetadata?.id || pluginEntry?.id || ''
  return [
    `Installed plugin "${pluginName}" is not enabled for the current workspace or session.`,
    pluginId
      ? `Enable it with aura_enable_plugin (pluginId: "${pluginId}") or via workspace capability settings before trying to call this tool directly.`
      : 'Enable it in Aura settings before trying to call this tool directly.',
  ].join(' ')
}

function normalizePluginEntry(entry) {
  const pluginId = typeof entry === 'string' ? entry : entry?.id
  if (!pluginId) {
    return null
  }

  const explicitPath =
    typeof entry === 'object' && typeof entry?.entryPath === 'string'
      ? entry.entryPath
      : typeof entry === 'object' && typeof entry?.path === 'string'
        ? entry.path
        : ''

  return {
    id: pluginId,
    name: typeof entry === 'object' ? entry?.name || '' : '',
    entryPath: explicitPath,
  }
}

function buildPluginToolsFromMetadata(
  pluginMetadata,
  filePath,
  versionToken,
  context,
  options = {},
) {
  const exposure =
    options.exposure === 'discoverable-only'
      ? 'discoverable-only'
      : options.exposure === 'direct'
        ? 'direct'
        : 'deferred'
  const activationHint =
    typeof options.activationHint === 'string' ? options.activationHint.trim() : ''

  async function getPluginRuntime() {
    return importPluginRuntime(filePath, versionToken, pluginMetadata.id)
  }

  return pluginMetadata.tools.map(toolMetadata => ({
    source: 'plugin',
    capabilityId: pluginMetadata.id,
    capabilityName: pluginMetadata.name,
    capabilityDescription: pluginMetadata.description || '',
    name: `plugin__${pluginMetadata.id}__${toolMetadata.localName}`,
    aliases: toolMetadata.aliases,
    approvalCategory: toolMetadata.approvalCategory,
    description: `[Plugin:${pluginMetadata.name}] ${toolMetadata.description}`,
    inputSchema: toolMetadata.inputSchema,
    deferLoading: exposure !== 'direct',
    discoverable: true,
    discoverOnly: exposure === 'discoverable-only',
    availability:
      exposure === 'discoverable-only'
        ? 'activation_required'
        : exposure === 'deferred'
          ? 'loadable'
          : 'mounted',
    activationHint,
    async run(args, runtime = {}) {
      const pluginRuntime = await getPluginRuntime()
      const tool = pluginRuntime.toolMap.get(toolMetadata.localName)
      if (!tool || typeof tool.handler !== 'function') {
        throw buildPluginToolLookupError(
          pluginMetadata.id,
          toolMetadata.localName,
          filePath,
        )
      }

      const result = await tool.handler({
        args,
        context,
        signal: runtime.signal,
        throwIfAborted: runtime.throwIfAborted,
      })
      return stringifyOutput(result)
    },
  }))
}

async function resolveSkillFilePath(appRoot, entry) {
  const skillId = typeof entry === 'string' ? entry : entry?.id
  const explicitPath = typeof entry === 'object' ? entry?.promptPath : ''
  if (!skillId) {
    return null
  }

  return (
    explicitPath ||
    (await resolveAuraAssetPath('skills', skillId, 'md')) ||
    path.join(appRoot, 'skills', `${skillId}.md`)
  )
}

export async function loadSkillCatalog(appRoot, enabledSkills) {
  const entries = []

  for (const entry of enabledSkills) {
    const skillId = typeof entry === 'string' ? entry : entry?.id
    if (!skillId) {
      continue
    }

    const filePath = await resolveSkillFilePath(appRoot, entry)
    const fileStat = await statAssetEntry(filePath)
    const versionToken = buildAssetVersionToken(filePath, fileStat)
    const cacheKey = buildSkillMetadataCacheKey(skillId, filePath, versionToken)
    const cachedSkill = normalizeCachedSkillMetadata(
      readSkillMetadataCache(cacheKey)?.value,
      skillId,
      filePath,
    )

    if (cachedSkill) {
      entries.push(cachedSkill)
      continue
    }

    try {
      const content = await fs.readFile(filePath, 'utf8')
      const metadata = summarizeSkillContent(skillId, content)
      const normalizedEntry = {
        id: skillId,
        name: metadata.title,
        filePath,
        content: normalizeSkillBody(content),
        body: metadata.body,
        description: metadata.description,
        summary: metadata.summary,
        keywords: metadata.keywords,
        allowedTools: metadata.allowedTools,
      }
      writeSkillMetadataCache(cacheKey, normalizedEntry)
      entries.push(normalizedEntry)
    } catch {
      const missingEntry = {
        id: skillId,
        name: prettifyIdentifier(skillId),
        filePath,
        content: '',
        body: '',
        description: '',
        summary: 'This skill file was not found.',
        keywords: [skillId],
        allowedTools: [],
      }
      writeSkillMetadataCache(cacheKey, missingEntry)
      entries.push(missingEntry)
    }
  }

  return entries
}

export function buildSkillPrompt(skillEntries) {
  if (!Array.isArray(skillEntries) || skillEntries.length === 0) {
    return ''
  }

  return skillEntries
    .map(skill => {
      const details = [skill.description || skill.summary]
      details.push('read the full skill file only if you decide to use it.')
      return `- ${skill.name}: ${details.filter(Boolean).join('; ')}`
    })
    .join('\n')
}

async function loadPluginToolsForEntries(
  appRoot,
  pluginEntries,
  context,
  options = {},
) {
  const tools = []

  for (const entry of pluginEntries) {
    const normalizedEntry = normalizePluginEntry(entry)
    const pluginId = normalizedEntry?.id
    if (!pluginId) {
      continue
    }
    const explicitPath = normalizedEntry?.entryPath || ''
    const filePath =
      explicitPath ||
      (await resolveAuraPluginModulePath(pluginId)) ||
      (await resolveBundledPluginModulePath(appRoot, pluginId))
    if (!filePath) {
      continue
    }
    const fileStat = await statAssetEntry(filePath)
    const versionToken = buildAssetVersionToken(filePath, fileStat)
    const cacheKey = buildPluginMetadataCacheKey(pluginId, filePath, versionToken)

    let pluginMetadata = normalizeCachedPluginMetadata(
      readPluginMetadataCache(cacheKey)?.value,
      pluginId,
    )
    if (!pluginMetadata) {
      let pluginRuntime
      try {
        pluginRuntime = await importPluginRuntime(filePath, versionToken, pluginId)
      } catch (error) {
        console.warn(`[Aura] Failed to load plugin "${pluginId}" from ${filePath}:`, error)
        continue
      }
      pluginMetadata = pluginRuntime.plugin
      writePluginMetadataCache(cacheKey, pluginMetadata)
    }

    if (!pluginMetadata?.tools?.length) {
      continue
    }

    tools.push(
      ...buildPluginToolsFromMetadata(pluginMetadata, filePath, versionToken, context, {
        exposure: options.exposure,
        activationHint:
          options.exposure === 'discoverable-only'
            ? buildPluginActivationHint(normalizedEntry, pluginMetadata)
            : '',
      }),
    )
  }

  return tools
}

export async function loadPluginTools(appRoot, enabledPlugins, context) {
  return loadPluginToolsForEntries(appRoot, enabledPlugins, context, {
    exposure: 'deferred',
  })
}

export async function loadPluginToolInventory(appRoot, enabledPlugins, context) {
  const activeTools = await loadPluginToolsForEntries(
    appRoot,
    enabledPlugins,
    context,
    {
      exposure: 'deferred',
    },
  )

  const aura = await getAuraState(context)
  if (!aura || !Array.isArray(aura.plugins)) {
    return {
      activeTools,
      discoverableTools: [],
    }
  }

  const enabledPluginIds = new Set(
    enabledPlugins
      .map(normalizePluginEntry)
      .map(entry => entry?.id)
      .filter(Boolean),
  )
  const discoverablePluginEntries = aura.plugins
    .filter(
      plugin =>
        plugin &&
        plugin.supported !== false &&
        typeof plugin.id === 'string' &&
        plugin.id.trim() &&
        !enabledPluginIds.has(plugin.id),
    )
    .map(plugin => ({
      id: plugin.id,
      name: plugin.name || plugin.id,
      entryPath:
        typeof plugin.entryPath === 'string' && plugin.entryPath.trim()
          ? plugin.entryPath
          : typeof plugin.path === 'string' && plugin.path.trim()
            ? plugin.path
            : '',
    }))

  const discoverableTools = await loadPluginToolsForEntries(
    appRoot,
    discoverablePluginEntries,
    context,
    {
      exposure: 'discoverable-only',
    },
  )

  return {
    activeTools,
    discoverableTools,
  }
}
