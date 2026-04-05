import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdvancedTools } from './advancedTools.mjs'
import { loadPluginTools, loadSkillPrompt } from './extensions.mjs'
import { connectMcpTools } from './mcp.mjs'
import {
  finalizeGoogleAnswer,
  finalizeOpenAiCompatibleAnswer,
  runGoogleAgent,
  runOpenAiCompatibleAgent,
} from './providers.mjs'
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

function summarizeReasoning(messages, toolEvents, finalMessage) {
  const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')
  const userIntent = latestUserMessage?.content?.replace(/\s+/g, ' ').trim() || '处理当前任务'
  const imageCount = (latestUserMessage?.parts || []).filter(part => part.type === 'image').length
  const fileCount = (latestUserMessage?.parts || []).filter(part => part.type === 'file').length
  const lines = [
    `围绕“${userIntent.length > 42 ? `${userIntent.slice(0, 42)}...` : userIntent}”组织本轮处理。`,
  ]

  if (imageCount > 0 || fileCount > 0) {
    lines.push(
      `本轮同时参考了 ${[
        imageCount > 0 ? `${imageCount} 张图片` : null,
        fileCount > 0 ? `${fileCount} 个文件` : null,
      ]
        .filter(Boolean)
        .join('、')}。`,
    )
  }

  if (toolEvents.length > 0) {
    lines.push(`执行了 ${toolEvents.length} 个工具步骤来补充上下文和完成操作。`)
  }

  if (finalMessage?.trim()) {
    lines.push('最后将结果整理成对用户可直接阅读的回复。')
  }

  return [
    {
      id: 'summary',
      kind: 'summary',
      content: lines.join('\n'),
    },
  ]
}

function extractProviderReasoning(reasoning = []) {
  return reasoning
    .filter(entry => entry.kind === 'provider')
    .map(entry => entry.content.trim())
    .filter(Boolean)
    .join('\n\n')
}

function normalizeFinalAnswer(message) {
  return (message || '').trim()
}

function shouldRunFinalization(result) {
  const finalMessage = normalizeFinalAnswer(result.message)
  const providerReasoning = extractProviderReasoning(result.reasoning || [])
  const hasContext = (result.toolEvents || []).length > 0 || providerReasoning.length > 200
  if (!hasContext) {
    return false
  }
  if (!finalMessage || finalMessage === '模型没有返回文本内容。') {
    return true
  }
  if (finalMessage.length >= 120) {
    return false
  }
  return !/[。！？!?\n]/u.test(finalMessage.slice(60))
}

function normalizeAgentError(error) {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown'
  const source =
    error && typeof error === 'object' && 'source' in error && typeof error.source === 'string'
      ? error.source
      : 'runtime'
  const raw =
    error && typeof error === 'object' && 'rawMessage' in error && typeof error.rawMessage === 'string'
      ? error.rawMessage
      : rawMessage

  return {
    code,
    source,
    rawMessage: raw,
    message: rawMessage,
  }
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
    'You are Aura, a local-first desktop coding agent.',
    `The active workspace is: ${settings.cwd}`,
    'Use tools when they reduce uncertainty or let you act directly inside the workspace.',
    'Prefer concrete changes and verification steps over abstract advice.',
    'Do not access paths outside the configured workspace root.',
    'If the user includes image attachments, treat them as already provided visual input. Do not read PNG/JPG/WebP files as plain text unless the user explicitly asks for raw file inspection or metadata.',
  ]

  const reasoningInstructions = {
    off: 'Reasoning intensity: off. Prefer fast, concise answers and avoid extended internal exploration unless the task clearly requires it.',
    low: 'Reasoning intensity: low. Optimize for speed and keep reasoning lightweight.',
    medium: 'Reasoning intensity: medium. Balance speed and reasoning depth.',
    high: 'Reasoning intensity: high. Spend more effort on analysis before acting, especially for complex tasks.',
    max: 'Reasoning intensity: maximum. Use your deepest available reasoning for difficult tasks, while still avoiding unnecessary repetition.',
  }
  sections.push(reasoningInstructions[settings.reasoningEffort] || reasoningInstructions.medium)

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
      let result = await runGoogleAgent({
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

      if (shouldRunFinalization(result)) {
        try {
          const finalizedMessage = await finalizeGoogleAnswer({
            settings,
            systemPrompt,
            messages,
            toolEvents,
            reasoningText: extractProviderReasoning(result.reasoning || []),
            draftMessage: result.message,
          })
          if (finalizedMessage.trim()) {
            result = {
              ...result,
              message: finalizedMessage,
            }
          }
        } catch {
          // 如果收尾补答失败，回退到原始结果，避免把整轮执行直接打成失败。
        }
      }

      const summaryReasoning = summarizeReasoning(messages, toolEvents, result.message)
      hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
        blockId: summaryReasoning[0].id,
        kind: summaryReasoning[0].kind,
      })
      const reasoning = [...summaryReasoning, ...(result.reasoning || [])]
      taskTracker.completeTask(currentTaskId, '生成最终回答')
      return {
        ...result,
        reasoning,
        status: 'completed',
        taskTree: taskTracker.getTree(),
      }
    }

    if (settings.provider === 'openai' || settings.provider === 'custom') {
      let result = await runOpenAiCompatibleAgent({
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

      if (shouldRunFinalization(result)) {
        try {
          const finalizedMessage = await finalizeOpenAiCompatibleAnswer({
            settings,
            systemPrompt,
            messages,
            toolEvents,
            reasoningText: extractProviderReasoning(result.reasoning || []),
            draftMessage: result.message,
          })
          if (finalizedMessage.trim()) {
            result = {
              ...result,
              message: finalizedMessage,
            }
          }
        } catch {
          // 如果收尾补答失败，回退到原始结果，避免把整轮执行直接打成失败。
        }
      }

      const summaryReasoning = summarizeReasoning(messages, toolEvents, result.message)
      hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
        blockId: summaryReasoning[0].id,
        kind: summaryReasoning[0].kind,
      })
      const reasoning = [...summaryReasoning, ...(result.reasoning || [])]
      taskTracker.completeTask(currentTaskId, '生成最终回答')
      return {
        ...result,
        reasoning,
        status: 'completed',
        taskTree: taskTracker.getTree(),
      }
    }
    throw new Error(`Unsupported provider: ${settings.provider}`)
  } catch (error) {
    const normalized = normalizeAgentError(error)
    taskTracker.setStatus(currentTaskId, 'failed', normalized.message)
    const enriched = new Error(normalized.message)
    enriched.code = normalized.code
    enriched.source = normalized.source
    enriched.rawMessage = normalized.rawMessage
    throw enriched
  } finally {
    await mcp.close()
  }
}
