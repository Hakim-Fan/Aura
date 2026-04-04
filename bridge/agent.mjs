import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdvancedTools } from './advancedTools.mjs'
import { loadPluginTools, loadSkillPrompt } from './extensions.mjs'
import { connectMcpTools } from './mcp.mjs'
import { runGoogleAgent, runOpenAiCompatibleAgent } from './providers.mjs'
import { createBuiltinTools } from './tools.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function createId(prefix = 'task') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function summarizeMessages(messages) {
  const firstUser = messages.find(message => message.role === 'user')?.content || 'Agent task'
  return firstUser.length > 80 ? `${firstUser.slice(0, 80)}...` : firstUser
}

function createTaskTracker(hooks, rootTitle) {
  const root = {
    id: createId('main'),
    title: rootTitle,
    summary: '',
    kind: 'main',
    status: 'running',
    children: [],
  }

  function emit() {
    hooks?.onTaskTree?.(clone([root]))
  }

  function findNode(node, id) {
    if (!id) return node
    if (node.id === id) return node
    for (const child of node.children) {
      const found = findNode(child, id)
      if (found) {
        return found
      }
    }
    return null
  }

  return {
    rootId: root.id,
    getTree() {
      return clone([root])
    },
    setStatus(id, status, summary) {
      const node = findNode(root, id)
      if (!node) return
      node.status = status
      if (summary) {
        node.summary = summary
      }
      emit()
    },
    createChildTask({ parentId, title, summary }) {
      const parent = findNode(root, parentId || root.id)
      if (!parent) {
        return null
      }
      const child = {
        id: createId('subagent'),
        title: title || 'Subagent task',
        summary: summary || '',
        kind: 'subagent',
        status: 'running',
        children: [],
      }
      parent.children.push(child)
      emit()
      return child
    },
    completeTask(id, summary, status = 'completed', nestedChildren = []) {
      const node = findNode(root, id)
      if (!node) return
      node.status = status
      if (summary) {
        node.summary = summary
      }
      if (Array.isArray(nestedChildren) && nestedChildren.length > 0) {
        node.children.push(...nestedChildren.flatMap(entry => entry.children || []))
      }
      emit()
    },
    failRoot(message) {
      root.status = 'failed'
      root.summary = message
      emit()
    },
    completeRoot(message) {
      root.status = 'completed'
      root.summary = message
      emit()
    },
  }
}

function buildSystemPrompt(settings, skillPrompt) {
  const sections = [
    'You are Desk Agent, a local-first desktop coding agent.',
    `The active workspace is: ${settings.cwd}`,
    'Use tools when they reduce uncertainty or let you act directly inside the workspace.',
    'Prefer concrete changes and verification steps over abstract advice.',
    'Do not access paths outside the configured workspace root.',
  ]

  const capabilities = []
  if (settings.enableMultiAgent) {
    capabilities.push('- You may delegate sharply scoped subtasks with spawn_subagent.')
  }
  if (settings.enableComputerUse) {
    capabilities.push(
      '- You may control the local desktop through computer_* tools on macOS.',
    )
  }
  if (settings.enableChromeAutomation) {
    capabilities.push(
      '- You may automate Google Chrome through chrome_* tools on macOS.',
    )
  }
  if (capabilities.length > 0) {
    sections.push(`Available advanced capabilities:\n${capabilities.join('\n')}`)
  }

  if (skillPrompt.trim()) {
    sections.push('Enabled skills:\n' + skillPrompt)
  }

  return sections.join('\n\n')
}

export async function runAgent(request) {
  const { settings, messages, runtime = {}, hooks = {} } = request
  if (!settings?.apiKey?.trim()) {
    throw new Error('Missing API key.')
  }
  if (!settings?.cwd?.trim()) {
    throw new Error('Missing workspace directory.')
  }

  const toolEvents = []
  const context = {
    cwd: settings.cwd,
  }
  const taskTracker =
    runtime.taskTracker || createTaskTracker(hooks, summarizeMessages(messages))
  const currentTaskId = runtime.currentTaskId || taskTracker.rootId
  taskTracker.setStatus(currentTaskId, 'running')

  const skillPrompt = await loadSkillPrompt(appRoot, settings.enabledSkillIds || [])
  const builtinTools = createBuiltinTools(context)
  const advancedTools = createAdvancedTools({
    appRoot,
    settings,
    context,
    runtimeMeta: runtime,
    runNestedAgent: nestedRequest =>
      runAgent({
        ...nestedRequest,
        hooks,
      }),
    taskTracker,
  })
  const pluginTools = await loadPluginTools(
    appRoot,
    settings.enabledPluginIds || [],
    context,
  )
  const mcp = await connectMcpTools(settings.mcpServers || [])

  try {
    const allTools = [
      ...builtinTools,
      ...advancedTools,
      ...pluginTools,
      ...mcp.tools,
    ]
    const systemPrompt = buildSystemPrompt(settings, skillPrompt)
    if (settings.provider === 'google') {
      const result = await runGoogleAgent({
        settings,
        systemPrompt,
        messages,
        tools: allTools,
        toolEvents,
        hooks: {
          ...hooks,
          settings,
          taskTracker,
          currentTaskId,
        },
      })
      taskTracker.completeTask(currentTaskId, result.message || 'Task completed')
      return {
        ...result,
        status: 'completed',
        taskTree: taskTracker.getTree(),
      }
    }

    if (settings.provider === 'openai' || settings.provider === 'custom') {
      const result = await runOpenAiCompatibleAgent({
        settings,
        systemPrompt,
        messages,
        tools: allTools,
        toolEvents,
        hooks: {
          ...hooks,
          settings,
          taskTracker,
          currentTaskId,
        },
      })
      taskTracker.completeTask(currentTaskId, result.message || 'Task completed')
      return {
        ...result,
        status: 'completed',
        taskTree: taskTracker.getTree(),
      }
    }
    throw new Error(`Unsupported provider: ${settings.provider}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    taskTracker.setStatus(currentTaskId, 'failed', message)
    throw error
  } finally {
    await mcp.close()
  }
}
