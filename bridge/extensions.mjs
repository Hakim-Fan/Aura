import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringifyOutput } from './utils.mjs'

export async function loadSkillPrompt(appRoot, enabledSkillIds) {
  const sections = []
  for (const skillId of enabledSkillIds) {
    const filePath = path.join(appRoot, 'skills', `${skillId}.md`)
    try {
      const content = await fs.readFile(filePath, 'utf8')
      sections.push(content.trim())
    } catch {
      sections.push(`# Missing Skill: ${skillId}\n\nThis skill file was not found.`)
    }
  }

  return sections.join('\n\n')
}

export async function loadPluginTools(appRoot, enabledPluginIds, context) {
  const tools = []

  for (const pluginId of enabledPluginIds) {
    const filePath = path.join(appRoot, 'plugins', `${pluginId}.mjs`)
    const module = await import(pathToFileURL(filePath).href)
    const plugin = module.plugin
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
