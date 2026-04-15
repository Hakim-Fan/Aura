import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectTurnCapabilities } from './capabilitySelector.mjs'
import { createAdvancedTools } from './advancedTools.mjs'
import {
  buildCapabilityExposureNote as buildAgentCapabilityExposureNote,
  buildRouteFirstSystemPrompt,
} from './agentPrompting.mjs'
import {
  applyRouteToolBudgets,
  filterToolsForRouteState,
  inferRouteState,
} from './agentRouting.mjs'
import { closeHeadlessBrowserSession } from './browserRuntime.mjs'
import { buildSkillPrompt, loadPluginTools, loadSkillCatalog } from './extensions.mjs'
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
  const latestUser =
    [...messages].reverse().find(message => message.role === 'user')?.content || 'Agent task'
  return latestUser.length > 80 ? `${latestUser.slice(0, 80)}...` : latestUser
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

function extractPartialProviderMessage(normalized) {
  return typeof normalized?.errorInfo?.partialMessage === 'string'
    ? normalized.errorInfo.partialMessage.trim()
    : ''
}

function extractPartialProviderReasoning(normalized) {
  return typeof normalized?.errorInfo?.partialReasoning === 'string'
    ? normalized.errorInfo.partialReasoning.trim()
    : ''
}

function extractProviderRetryInfo(value) {
  if (!value || typeof value !== 'object' || !value.retryInfo || typeof value.retryInfo !== 'object') {
    return undefined
  }

  const retryInfo = value.retryInfo
  const configuredMaxRetries =
    typeof retryInfo.configuredMaxRetries === 'number' &&
    Number.isFinite(retryInfo.configuredMaxRetries)
      ? Math.max(0, Math.round(retryInfo.configuredMaxRetries))
      : typeof retryInfo.configuredMaxAttempts === 'number' &&
          Number.isFinite(retryInfo.configuredMaxAttempts)
        ? Math.max(0, Math.round(retryInfo.configuredMaxAttempts) - 1)
        : undefined
  const configuredMaxAttempts =
    typeof retryInfo.configuredMaxAttempts === 'number' &&
    Number.isFinite(retryInfo.configuredMaxAttempts)
      ? Math.max(1, Math.round(retryInfo.configuredMaxAttempts))
      : typeof configuredMaxRetries === 'number'
        ? configuredMaxRetries + 1
        : undefined
  if (
    typeof retryInfo.attemptedRetries !== 'number' ||
    !Number.isFinite(retryInfo.attemptedRetries) ||
    retryInfo.attemptedRetries <= 0 ||
    typeof configuredMaxAttempts !== 'number' ||
    configuredMaxAttempts <= 0
  ) {
    return undefined
  }

  return {
    attemptedRetries: Math.round(retryInfo.attemptedRetries),
    configuredMaxRetries,
    configuredMaxAttempts,
    stage:
      retryInfo.stage === 'response' ||
      retryInfo.stage === 'finalization' ||
      retryInfo.stage === 'recovery'
        ? retryInfo.stage
        : undefined,
    stageLabel: typeof retryInfo.stageLabel === 'string' ? retryInfo.stageLabel : undefined,
    recovered: retryInfo.recovered === true,
  }
}

function mergeProviderRetryInfo(...entries) {
  const validEntries = entries.filter(
    entry =>
      entry &&
      typeof entry.attemptedRetries === 'number' &&
      Number.isFinite(entry.attemptedRetries) &&
      entry.attemptedRetries > 0,
  )

  if (validEntries.length === 0) {
    return undefined
  }

  return validEntries.reduce((selected, entry) => {
    if (!selected) {
      return { ...entry }
    }

    if (selected.stage && entry.stage && selected.stage !== entry.stage) {
      return {
        ...entry,
        recovered: selected.recovered === true || entry.recovered === true,
      }
    }

    return {
      ...selected,
      ...entry,
      attemptedRetries: Math.max(selected.attemptedRetries, entry.attemptedRetries),
      configuredMaxRetries: Math.max(
        selected.configuredMaxRetries || 0,
        entry.configuredMaxRetries || 0,
      ),
      configuredMaxAttempts: Math.max(
        selected.configuredMaxAttempts || 0,
        entry.configuredMaxAttempts || 0,
      ),
      recovered: selected.recovered === true || entry.recovered === true,
    }
  }, undefined)
}

function normalizeFinalAnswer(message) {
  return (message || '').trim()
}

function resultClaimsExecution(message) {
  const normalized = normalizeFinalAnswer(message).toLowerCase()
  if (!normalized) {
    return false
  }

  return [
    'done',
    'completed',
    'already done',
    'installed',
    'configured',
    'created',
    'updated',
    'downloaded',
    'enabled',
    'wrote',
    'fixed',
    '已完成',
    '已经为你',
    '已经帮你',
    '完成',
    '已为你',
    '已帮你',
    '装好了',
    '配置好了',
    '创建了',
    '写入了',
    '修复了',
    '启用了',
  ].some(keyword => normalized.includes(keyword))
}

function enforceEvidencePolicy(result, toolEvents, routeState) {
  const requiresExecutionEvidence = routeState?.answerMode === 'execute'

  if (!requiresExecutionEvidence || toolEvents.length > 0) {
    return result
  }

  if (!resultClaimsExecution(result.message)) {
    return result
  }

  return {
    ...result,
    message:
      '我还没有执行任何工具，所以现在不能确认这项实际操作已经完成。要完成这类任务，我需要先运行相应工具并验证结果，然后再向你确认完成。',
  }
}

function shouldRunFinalization(result) {
  const finalMessage = normalizeFinalAnswer(result.message)
  const providerReasoning = extractProviderReasoning(result.reasoning || [])
  const hasToolContext = (result.toolEvents || []).length > 0
  if (!hasToolContext) {
    return false
  }
  if (!finalMessage || finalMessage === '模型没有返回文本内容。') {
    return true
  }
  if (finalMessage.length >= 120) {
    return false
  }
  return providerReasoning.length > 200 && !/[。！？!?\n]/u.test(finalMessage.slice(60))
}

function normalizeAgentError(error) {
  return normalizeRuntimeError(error, {
    source: 'system',
    operationLabel: '本轮任务',
  })
}

function summarizeToolOutput(output, maxLength = 220) {
  const normalized = String(output || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function buildPartialRecoveryMessage(toolEvents, normalized, partialMessage = '') {
  const successfulEvents = toolEvents.filter(event => event.status === 'success')
  const recentSuccessful = successfulEvents.slice(-3)
  const completedSteps = recentSuccessful
    .map((event, index) => {
      const summary = summarizeToolOutput(event.output) || event.summary || event.name
      return `${index + 1}. ${event.name}: ${summary}`
    })
    .join('\n')

  const recentFailures = toolEvents
    .filter(event => event.status === 'error')
    .slice(-2)
    .map((event, index) => {
      const detail =
        event.errorInfo?.summary ||
        summarizeToolOutput(event.error || event.output, 160) ||
        event.summary ||
        event.name
      return `${index + 1}. ${event.name}: ${detail}`
    })
    .join('\n')

  return [
    '执行在模型生成最终回答时中断了，但我先把已经保留下来的内容和已完成进展整理给你。',
    partialMessage ? `模型中断前已经写出的内容：\n${partialMessage.slice(0, 6000)}` : null,
    completedSteps
      ? `已完成的步骤：\n${completedSteps}`
      : toolEvents.length > 0
        ? '本轮已经执行过工具步骤，但还没来得及整理成完整结论。'
        : '这次中断发生在模型整理最终回答时，还没有额外的工具步骤可供复盘。',
    recentFailures ? `中断前最近看到的问题：\n${recentFailures}` : null,
    normalized?.errorInfo?.suggestedAction
      ? `建议：${normalized.errorInfo.suggestedAction}`
      : '如果你愿意，我可以基于这些已完成步骤继续重试，而不用从头再来。',
  ]
    .filter(Boolean)
    .join('\n\n')
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

export async function runAgent(request) {
  const { settings, messages, runtime = {}, hooks = {}, capabilities } = request
  hooks?.onPhaseChange?.('preparing')
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
    appControl: hooks.appControl,
    todoState: runtime.todoState || { items: [] },
  }
  const taskTracker =
    runtime.taskTracker || createTaskTracker(hooks, summarizeMessages(messages))
  const currentTaskId = runtime.currentTaskId || taskTracker.rootId
  taskTracker.setStatus(currentTaskId, 'running')

  const skillCatalog = await loadSkillCatalog(
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
  const availableTools = [
    ...builtinTools,
    ...advancedTools,
    ...pluginTools,
    ...mcp.tools,
  ]
  const routeState = inferRouteState(messages)
  const routedTools = applyRouteToolBudgets(
    filterToolsForRouteState(availableTools, routeState),
    routeState,
  )
  const selectedCapabilities = selectTurnCapabilities({
    messages,
    runtimeCapabilities: capabilities,
    skillEntries: skillCatalog,
    tools: routedTools,
  })
  const skillPrompt = buildSkillPrompt(selectedCapabilities.selectedSkills)
  const exposureNote = buildAgentCapabilityExposureNote(
    selectedCapabilities.capabilitySnapshot,
    routeState,
  )
  const systemPrompt = buildRouteFirstSystemPrompt(
    settings,
    skillPrompt,
    exposureNote,
    routeState,
  )
  const allTools = selectedCapabilities.selectedTools

  try {
    if (settings.provider === 'google') {
      hooks?.onPhaseChange?.('model_connecting')
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
      result = enforceEvidencePolicy(result, toolEvents, routeState)
      const resolvedMessages = result.messages || messages

      if (shouldRunFinalization(result)) {
        try {
          hooks?.onPhaseChange?.('finalizing')
          const finalized = await finalizeGoogleAnswer({
            settings,
            systemPrompt,
            messages: resolvedMessages,
            toolEvents,
            reasoningText: extractProviderReasoning(result.reasoning || []),
            draftMessage: result.message,
            stage: 'finalization',
          })
          if (finalized.message.trim()) {
            result = {
              ...result,
              message: finalized.message,
              retryInfo: finalized.retryInfo || result.retryInfo,
            }
          }
        } catch {
          // 如果收尾补答失败，回退到原始结果，避免把整轮执行直接打成失败。
        }
      }

      const summaryReasoning = summarizeReasoning(
        resolvedMessages,
        toolEvents,
        result.message,
      )
      hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
        blockId: summaryReasoning[0].id,
        kind: summaryReasoning[0].kind,
      })
      const reasoning = [...summaryReasoning, ...(result.reasoning || [])]
      taskTracker.completeTask(currentTaskId, '生成最终回答')
      return {
        ...result,
        capabilitySnapshot: selectedCapabilities.capabilitySnapshot,
        reasoning,
        retryInfo: result.retryInfo,
        status: 'completed',
        taskTree: taskTracker.getTree(),
      }
    }

    if (settings.provider === 'openai' || settings.provider === 'custom') {
      hooks?.onPhaseChange?.('model_connecting')
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
      result = enforceEvidencePolicy(result, toolEvents, routeState)
      const resolvedMessages = result.messages || messages

      if (shouldRunFinalization(result)) {
        try {
          hooks?.onPhaseChange?.('finalizing')
          const finalized = await finalizeOpenAiCompatibleAnswer({
            settings,
            systemPrompt,
            messages: resolvedMessages,
            toolEvents,
            reasoningText: extractProviderReasoning(result.reasoning || []),
            draftMessage: result.message,
            stage: 'finalization',
          })
          if (finalized.message.trim()) {
            result = {
              ...result,
              message: finalized.message,
              retryInfo: finalized.retryInfo || result.retryInfo,
            }
          }
        } catch {
          // 如果收尾补答失败，回退到原始结果，避免把整轮执行直接打成失败。
        }
      }

      const summaryReasoning = summarizeReasoning(
        resolvedMessages,
        toolEvents,
        result.message,
      )
      hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
        blockId: summaryReasoning[0].id,
        kind: summaryReasoning[0].kind,
      })
      const reasoning = [...summaryReasoning, ...(result.reasoning || [])]
      taskTracker.completeTask(currentTaskId, '生成最终回答')
      return {
        ...result,
        capabilitySnapshot: selectedCapabilities.capabilitySnapshot,
        reasoning,
        retryInfo: result.retryInfo,
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
    const partialMessage = extractPartialProviderMessage(normalized)
    const partialReasoning = extractPartialProviderReasoning(normalized)
    const retryInfo = extractProviderRetryInfo(normalized)
    const hasRecoveryContext =
      toolEvents.length > 0 || partialMessage.length > 0

    if (
      settings.enableProviderFailureRecovery !== false &&
      normalized.source === 'provider' &&
      hasRecoveryContext
    ) {
      let recoveryRetryInfo
      try {
        hooks?.onPhaseChange?.('recovering')
        const recovered =
          settings.provider === 'google'
            ? await finalizeGoogleAnswer({
                settings,
                systemPrompt,
                messages,
                toolEvents,
                reasoningText: partialReasoning,
                draftMessage: partialMessage,
                stage: 'recovery',
              })
            : await finalizeOpenAiCompatibleAnswer({
                settings,
                systemPrompt,
                messages,
                toolEvents,
                reasoningText: partialReasoning,
                draftMessage: partialMessage,
                stage: 'recovery',
              })

        if (recovered.message.trim()) {
          const summaryReasoning = summarizeReasoning(messages, toolEvents, recovered.message)
          hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
            blockId: summaryReasoning[0].id,
            kind: summaryReasoning[0].kind,
          })
          taskTracker.completeTask(currentTaskId, '生成最终回答')
          return {
            message: recovered.message,
            toolEvents,
            capabilitySnapshot: selectedCapabilities.capabilitySnapshot,
            reasoning: summaryReasoning,
            retryInfo: recovered.retryInfo
              ? {
                  ...recovered.retryInfo,
                  recovered: true,
                }
              : undefined,
            usage: undefined,
            status: 'completed',
            taskTree: taskTracker.getTree(),
          }
        }
      } catch (recoveryError) {
        recoveryRetryInfo = extractProviderRetryInfo(recoveryError)
        // Recovery finalization is best-effort only. Preserve the original failure if it also fails.
      }

      const fallbackMessage = buildPartialRecoveryMessage(
        toolEvents,
        normalized,
        partialMessage,
      )
      const summaryReasoning = summarizeReasoning(messages, toolEvents, fallbackMessage)
      hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
        blockId: summaryReasoning[0].id,
        kind: summaryReasoning[0].kind,
      })
      taskTracker.completeTask(currentTaskId, '生成部分恢复回答')
      return {
        message: fallbackMessage,
        toolEvents,
        capabilitySnapshot: selectedCapabilities.capabilitySnapshot,
        reasoning: summaryReasoning,
        retryInfo: recoveryRetryInfo || retryInfo,
        usage: undefined,
        status: 'completed',
        taskTree: taskTracker.getTree(),
      }
    }

    taskTracker.setStatus(currentTaskId, 'failed', normalized.message)
    const enriched = new Error(normalized.message)
    enriched.code = normalized.code
    enriched.source = normalized.source
    enriched.rawMessage = normalized.rawMessage
    enriched.errorInfo = normalized.errorInfo
    enriched.retryInfo = retryInfo
    throw enriched
  } finally {
    await closeHeadlessBrowserSession().catch(() => {})
    await mcp.close()
  }
}
