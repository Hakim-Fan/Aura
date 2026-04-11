import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectTurnCapabilities } from './capabilitySelector.mjs'
import { createAdvancedTools } from './advancedTools.mjs'
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
  if (
    typeof retryInfo.attemptedRetries !== 'number' ||
    !Number.isFinite(retryInfo.attemptedRetries) ||
    retryInfo.attemptedRetries <= 0 ||
    typeof retryInfo.configuredMaxAttempts !== 'number' ||
    !Number.isFinite(retryInfo.configuredMaxAttempts) ||
    retryInfo.configuredMaxAttempts <= 0
  ) {
    return undefined
  }

  return {
    attemptedRetries: Math.round(retryInfo.attemptedRetries),
    configuredMaxAttempts: Math.round(retryInfo.configuredMaxAttempts),
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

  return {
    attemptedRetries: validEntries.reduce((sum, entry) => sum + entry.attemptedRetries, 0),
    configuredMaxAttempts: validEntries.reduce(
      (max, entry) => Math.max(max, entry.configuredMaxAttempts || 0),
      0,
    ),
    recovered: validEntries.some(entry => entry.recovered === true),
  }
}

function normalizeFinalAnswer(message) {
  return (message || '').trim()
}

function latestUserIntent(messages) {
  return [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content?.toLowerCase() || ''
}

function taskNeedsExecution(messages) {
  const intent = latestUserIntent(messages)
  if (!intent) {
    return false
  }

  return [
    'install',
    'configure',
    'setup',
    'set up',
    'download',
    'create',
    'update',
    'modify',
    'edit',
    'write',
    'fix',
    'enable',
    'disable',
    'remove',
    'delete',
    'add',
    'run',
    'repair',
    '安装',
    '配置',
    '接入',
    '下载',
    '创建',
    '修改',
    '编辑',
    '写入',
    '修复',
    '启用',
    '关闭',
    '删除',
    '增加',
    '运行',
    '新增',
  ].some(keyword => intent.includes(keyword))
}

function resultClaimsExecution(message) {
  const normalized = normalizeFinalAnswer(message).toLowerCase()
  if (!normalized) {
    return false
  }

  return [
    'done',
    'completed',
    'installed',
    'configured',
    'created',
    'updated',
    'downloaded',
    'enabled',
    'wrote',
    'fixed',
    '完成',
    '已经',
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

function enforceEvidencePolicy(messages, result, toolEvents) {
  if (!taskNeedsExecution(messages) || toolEvents.length > 0) {
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

function buildCapabilityExposureNote(snapshot) {
  const lines = ['Only task-relevant optional capabilities are exposed for this turn.']
  const items = [
    snapshot?.skills?.length ? `skills ${snapshot.skills.length}` : null,
    snapshot?.plugins?.length ? `plugins ${snapshot.plugins.length}` : null,
    snapshot?.mcpServers?.length ? `mcp ${snapshot.mcpServers.length}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  if (items) {
    lines.push(`Selected optional capabilities: ${items}.`)
  }

  return lines.join('\n')
}

function getBrowserSourceLabel(source) {
  switch (source) {
    case 'managed-chrome':
      return 'Aura managed browser'
    case 'custom-executable':
      return 'custom browser executable'
    case 'system-chrome':
    default:
      return 'system Chrome'
  }
}

function isBrowserSourceAvailable(settings) {
  const source = settings.browser?.source
  const status = settings.browserRuntimeStatus
  if (!status || !source) {
    return null
  }

  switch (source) {
    case 'managed-chrome':
      return status.managedChromeInstalled === true
    case 'custom-executable':
      return status.customExecutableValid === true
    case 'system-chrome':
    default:
      return status.systemChromeDetected === true
  }
}

function buildSystemPrompt(settings, skillPrompt, exposureNote) {
  const sections = [
    'You are Aura, a local-first desktop coding agent.',
    `The active workspace is: ${settings.cwd}`,
    'Use tools when they reduce uncertainty or let you act directly inside the workspace.',
    'Prefer concrete changes and verification steps over abstract advice.',
    'If the user asks for any real-world action such as editing files, changing configuration, installing capabilities, or downloading assets, you must use tools and verify the result before claiming success.',
    'Do not say that something is done, installed, configured, created, or fixed unless tool output in this run gives direct evidence.',
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
  if (settings.browser?.enabled) {
    capabilities.push(
      '- Prefer browser_* tools for normal web tasks. They run inside the Aura browser runtime with an isolated profile and do not need the frontmost Chrome window.',
    )
  }
  if (settings.enableChromeAutomation) {
    capabilities.push(
      settings.browser?.allowChromeAutomationFallback
        ? '- chrome_* tools are a backup mode for interacting with the user\'s frontmost Google Chrome window on macOS. Use them only when the user explicitly requests system Chrome, or when browser_* fails because the Aura browser runtime is unavailable.'
        : '- chrome_* tools are only for explicit requests to interact with the user\'s frontmost Google Chrome window on macOS. Do not use them as an automatic fallback.',
    )
  }
  if (capabilities.length > 0) {
    sections.push(`Available advanced capabilities:\n${capabilities.join('\n')}`)
  }

  if (settings.browser?.enabled) {
    const browserSource = settings.browser.source || 'system-chrome'
    const availability = isBrowserSourceAvailable(settings)
    const statusLabel =
      availability === null ? 'unknown' : availability ? 'available' : 'unavailable'
    const browserRoutingPolicy = [
      `Aura browser source: ${getBrowserSourceLabel(browserSource)} (${statusLabel}).`,
      'Routing policy: use browser_* for all normal web work. Do not switch to chrome_* just because a site needs login, MFA, CAPTCHA, consent, or other interactive steps; use browser_takeover_visible instead.',
    ]

    if (settings.enableChromeAutomation) {
      browserRoutingPolicy.push(
        settings.browser.allowChromeAutomationFallback
          ? 'Fallback rule: chrome_* is allowed only after the Aura browser runtime is unavailable/disabled/missing, or when the user explicitly asks to operate system Chrome.'
          : 'Fallback rule: if the Aura browser runtime is unavailable, do not switch to chrome_* unless the user explicitly asks to operate system Chrome.',
      )
    }

    sections.push(browserRoutingPolicy.join('\n'))
    sections.push(
      'When a browser_* tool output includes blocker.detected=true, treat that as a real user-blocking state. Prefer calling browser_takeover_visible when the workflow cannot continue headlessly, then wait for user confirmation before proceeding.',
    )
  }

  if (skillPrompt.trim()) {
    sections.push('Selected skill summaries:\n' + skillPrompt)
    sections.push(
      'If one of these selected skills is relevant and you need its exact instructions, read it on demand with aura_read_skill instead of guessing from the summary.',
    )
  }

  if (exposureNote?.trim()) {
    sections.push(exposureNote)
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
  const selectedCapabilities = selectTurnCapabilities({
    messages,
    runtimeCapabilities: capabilities,
    skillEntries: skillCatalog,
    tools: availableTools,
  })
  const skillPrompt = buildSkillPrompt(selectedCapabilities.selectedSkills)
  const systemPrompt = buildSystemPrompt(
    settings,
    skillPrompt,
    buildCapabilityExposureNote(selectedCapabilities.capabilitySnapshot),
  )
  const allTools = selectedCapabilities.selectedTools

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
      result = enforceEvidencePolicy(messages, result, toolEvents)
      const resolvedMessages = result.messages || messages

      if (shouldRunFinalization(result)) {
        try {
          const finalized = await finalizeGoogleAnswer({
            settings,
            systemPrompt,
            messages: resolvedMessages,
            toolEvents,
            reasoningText: extractProviderReasoning(result.reasoning || []),
            draftMessage: result.message,
          })
          if (finalized.message.trim()) {
            result = {
              ...result,
              message: finalized.message,
              retryInfo: mergeProviderRetryInfo(result.retryInfo, finalized.retryInfo),
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
      result = enforceEvidencePolicy(messages, result, toolEvents)
      const resolvedMessages = result.messages || messages

      if (shouldRunFinalization(result)) {
        try {
          const finalized = await finalizeOpenAiCompatibleAnswer({
            settings,
            systemPrompt,
            messages: resolvedMessages,
            toolEvents,
            reasoningText: extractProviderReasoning(result.reasoning || []),
            draftMessage: result.message,
          })
          if (finalized.message.trim()) {
            result = {
              ...result,
              message: finalized.message,
              retryInfo: mergeProviderRetryInfo(result.retryInfo, finalized.retryInfo),
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
      toolEvents.length > 0 || partialMessage.length > 0 || partialReasoning.length > 0

    if (
      settings.enableProviderFailureRecovery !== false &&
      normalized.source === 'provider' &&
      hasRecoveryContext
    ) {
      try {
        const recovered =
          settings.provider === 'google'
            ? await finalizeGoogleAnswer({
                settings,
                systemPrompt,
                messages,
                toolEvents,
                reasoningText: partialReasoning,
                draftMessage: partialMessage,
              })
            : await finalizeOpenAiCompatibleAnswer({
                settings,
                systemPrompt,
                messages,
                toolEvents,
                reasoningText: partialReasoning,
                draftMessage: partialMessage,
              })

        if (recovered.message.trim()) {
          const mergedRetryInfo = mergeProviderRetryInfo(
            retryInfo,
            recovered.retryInfo
              ? {
                  ...recovered.retryInfo,
                  recovered: true,
                }
              : undefined,
          )
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
            retryInfo: mergedRetryInfo,
            usage: undefined,
            status: 'completed',
            taskTree: taskTracker.getTree(),
          }
        }
      } catch {
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
        retryInfo,
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
    await mcp.close()
  }
}
