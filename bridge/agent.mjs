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
import { createStructuredError, normalizeRuntimeError } from './runtimeErrors.mjs'
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
  return normalizeRuntimeError(error, {
    source: 'system',
    operationLabel: '本轮任务',
  })
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
    // 思考程度：关闭。倾向于快速、简明的回答，除非任务明确要求，否则避免进行过多的内部探索与展开。
    off: 'Reasoning intensity: off. Prefer fast, concise answers and avoid extended internal exploration unless the task clearly requires it.',
    // 思考程度：低。为速度进行优化，并保持思考过程的轻量化。
    low: 'Reasoning intensity: low. Optimize for speed and keep reasoning lightweight.',
    // 思考程度：中。在响应速度和推理深度之间取得平衡。
    medium: 'Reasoning intensity: medium. Balance speed and reasoning depth.',
    // 思考程度：高。在采取行动之前投入更多的精力进行分析，特别适用于复杂的任务。
    high: 'Reasoning intensity: high. Spend more effort on analysis before acting, especially for complex tasks.',
    // 思考程度：最大化。在处理困难任务时使用你力所能及的最深度的推理能力，同时依然要避免无意义的冗余重复。
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
  const { settings, messages, runtime = {}, hooks = {}, capabilities } = request
  if (!settings?.apiKey?.trim()) {
    throw createStructuredError('模型调用失败，当前缺少 API Key。', {
      source: 'provider',
      category: 'authentication',
      code: 'MISSING_API_KEY',
      detail: 'Missing API key.',
      suggestedAction: '请先在设置页填写可用的 Provider API Key。',
    })
  }
  if (!settings?.cwd?.trim()) {
    throw createStructuredError('任务无法开始，当前没有可用的工作区目录。', {
      source: 'system',
      category: 'invalid_input',
      code: 'MISSING_WORKSPACE',
      detail: 'Missing workspace directory.',
      suggestedAction: '请先为当前会话设置工作区目录，再重新执行。',
    })
  }

  const toolEvents = []
  const context = {
    cwd: settings.cwd,
  }
  const taskTracker =
    runtime.taskTracker || createTaskTracker(hooks, summarizeMessages(messages))
  const currentTaskId = runtime.currentTaskId || taskTracker.rootId
  taskTracker.setStatus(currentTaskId, 'running')

  const skillPrompt = await loadSkillPrompt(
    appRoot,
    capabilities?.skills || settings.enabledSkillIds || [],
  )
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
    capabilities?.plugins || settings.enabledPluginIds || [],
    context,
  )
  const mcp = await connectMcpTools(capabilities?.mcpServers || settings.mcpServers || [])
  const allTools = [
    ...builtinTools,
    ...advancedTools,
    ...pluginTools,
    ...mcp.tools,
  ]
  const systemPrompt = buildSystemPrompt(settings, skillPrompt)

  try {
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
    throw createStructuredError(`模型调用失败，当前 Provider "${settings.provider}" 不受支持。`, {
      source: 'provider',
      category: 'unsupported',
      code: 'UNSUPPORTED_PROVIDER',
      detail: `Unsupported provider: ${settings.provider}`,
      suggestedAction: '请切换到已支持的 Provider 后再试。',
    })
  } catch (error) {
    const normalized = normalizeAgentError(error)

    if (normalized.source === 'provider' && toolEvents.length > 0) {
      try {
        const recoveredMessage =
          settings.provider === 'google'
            ? await finalizeGoogleAnswer({
                settings,
                systemPrompt,
                messages,
                toolEvents,
                reasoningText: '',
                draftMessage: '',
              })
            : await finalizeOpenAiCompatibleAnswer({
                settings,
                systemPrompt,
                messages,
                toolEvents,
                reasoningText: '',
                draftMessage: '',
              })

        if (recoveredMessage.trim()) {
          const summaryReasoning = summarizeReasoning(messages, toolEvents, recoveredMessage)
          hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
            blockId: summaryReasoning[0].id,
            kind: summaryReasoning[0].kind,
          })
          taskTracker.completeTask(currentTaskId, '生成最终回答')
          return {
            message: recoveredMessage,
            toolEvents,
            reasoning: summaryReasoning,
            usage: undefined,
            status: 'completed',
            taskTree: taskTracker.getTree(),
          }
        }
      } catch {
        // Recovery finalization is best-effort only. Preserve the original failure if it also fails.
      }
    }

    taskTracker.setStatus(currentTaskId, 'failed', normalized.message)
    const enriched = new Error(normalized.message)
    enriched.code = normalized.code
    enriched.source = normalized.source
    enriched.rawMessage = normalized.rawMessage
    enriched.errorInfo = normalized.errorInfo
    throw enriched
  } finally {
    await mcp.close()
  }
}
