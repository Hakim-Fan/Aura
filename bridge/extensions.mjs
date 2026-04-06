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

export async function loadSkillPrompt(appRoot, enabledSkills) {
  const sections = []
  for (const entry of enabledSkills) {
    const skillId = typeof entry === 'string' ? entry : entry?.id
    const explicitPath = typeof entry === 'object' ? entry?.promptPath : ''
    if (!skillId) {
      continue
    }
    const filePath =
      explicitPath ||
      (await resolveAuraAssetPath('skills', skillId, 'md')) ||
      path.join(appRoot, 'skills', `${skillId}.md`)
    try {
      const content = await fs.readFile(filePath, 'utf8')
      sections.push(content.trim())
    } catch {
      sections.push(`# Missing Skill: ${skillId}\n\nThis skill file was not found.`)
    }
  }

  return sections.join('\n\n')
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
        name: `plugin__${plugin.id}__${tool.name}`,
        description: `[Plugin:${plugin.name}] ${tool.description}`,
        inputSchema: tool.inputSchema ?? {
          type: 'object',
          properties: {},
        },
        async run(args) {
          const result = await tool.handler({
            args,
            context,
          })
          return stringifyOutput(result)
        },
      })
    }
  }

  return tools
}
