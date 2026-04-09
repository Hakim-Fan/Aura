import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringifyOutput } from './utils.mjs'

function resolveAuraHome() {
  return path.join(os.homedir(), '.aura')
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

function summarizeSkillContent(skillId, content) {
  const lines = String(content || '')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
  const heading = lines.find(line => line.startsWith('#'))
  const title = stripMarkdown(heading || '') || prettifyIdentifier(skillId)
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
    summary: summary || 'Use this skill when it is directly relevant to the task.',
    keywords: [title, paragraph, ...bullets].filter(Boolean),
  }
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
    try {
      const content = await fs.readFile(filePath, 'utf8')
      const metadata = summarizeSkillContent(skillId, content)
      entries.push({
        id: skillId,
        name: metadata.title,
        filePath,
        content: content.trim(),
        summary: metadata.summary,
        keywords: metadata.keywords,
      })
    } catch {
      entries.push({
        id: skillId,
        name: prettifyIdentifier(skillId),
        filePath,
        content: '',
        summary: 'This skill file was not found.',
        keywords: [skillId],
      })
    }
  }

  return entries
}

export function buildSkillPrompt(skillEntries) {
  if (!Array.isArray(skillEntries) || skillEntries.length === 0) {
    return ''
  }

  return skillEntries
    .map(
      skill =>
        `- ${skill.name}: ${skill.summary}`,
    )
    .join('\n')
}

export async function loadPluginTools(appRoot, enabledPlugins, context) {
  const tools = []

  for (const entry of enabledPlugins) {
    const pluginId = typeof entry === 'string' ? entry : entry?.id
    const explicitPath = typeof entry === 'object' ? entry?.entryPath : ''
    if (!pluginId) {
      continue
    }
    const filePath =
      explicitPath ||
      (await resolveAuraPluginModulePath(pluginId)) ||
      (await resolveBundledPluginModulePath(appRoot, pluginId))
    if (!filePath) {
      continue
    }
    let module
    try {
      module = await import(pathToFileURL(filePath).href)
    } catch (error) {
      console.warn(`[Aura] Failed to load plugin "${pluginId}" from ${filePath}:`, error)
      continue
    }
    const plugin = module.plugin || module.default?.plugin || module.default
    if (!plugin?.tools?.length) {
      continue
    }

    for (const tool of plugin.tools) {
      tools.push({
        source: 'plugin',
        capabilityId: plugin.id,
        capabilityName: plugin.name,
        capabilityDescription: plugin.description || '',
        name: `plugin__${plugin.id}__${tool.name}`,
        description: `[Plugin:${plugin.name}] ${tool.description}`,
        inputSchema: tool.inputSchema ?? {
          type: 'object',
          properties: {},
        },
        async run(args, runtime = {}) {
          const result = await tool.handler({
            args,
            context,
            signal: runtime.signal,
            throwIfAborted: runtime.throwIfAborted,
          })
          return stringifyOutput(result)
        },
      })
    }
  }

  return tools
}
