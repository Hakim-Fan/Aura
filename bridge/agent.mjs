import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectTurnCapabilities } from './capabilitySelector.mjs'
import { createAdvancedTools } from './advancedTools.mjs'
import {
  buildCapabilityExposureNote as buildAgentCapabilityExposureNote,
  buildRouteFirstSystemPrompt,
} from './agentPrompting.mjs'
import {
  applyHardSignalIntentOverrides,
  applyRouteToolBudgets,
  deriveHardSignals,
  escalateRouteState,
  getRouteEscalationTargets,
  inferRouteState,
  selectAgentStrategy,
} from './agentRouting.mjs'
import {
  buildSkillPrompt,
  loadPluginToolInventory,
  loadSkillCatalog,
} from './extensions.mjs'
import {
  resolveIntentClassification,
} from './intentClassifier.mjs'
import { loadMcpToolInventory } from './mcp.mjs'
import {
  finalizeGoogleAnswer,
  finalizeOpenAiCompatibleAnswer,
  runGoogleAgent,
  runOpenAiCompatibleAgent,
} from './providers.mjs'
import { createStructuredError, normalizeRuntimeError } from './runtimeErrors.mjs'
import { createBuiltinTools } from './tools.mjs'
import {
  buildRouteStopMessage,
  determineRouteStopReason,
  summarizeRouteTurn,
} from './agentGovernor.mjs'
import {
  buildDeliveryPolicy,
  collectEvidenceFromToolEvents,
  deriveCompletionState,
  enforceEvidencePolicy,
} from './agentEvidence.mjs'
import { applyCompletionGate } from './completionGate.mjs'
import { evaluateRuntimeCapabilityContract } from './runtimeCapabilityContract.mjs'
import { createToolRegistry } from './toolRegistry.mjs'
import { createToolRouter } from './toolRouter.mjs'
import {
  ORCHESTRATED_AGENT_AVAILABLE,
  runOrchestratedAgent,
} from './agentModes/orchestrated.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROUTE_ESCALATION_TOOL_NAME = 'route_request_escalation'
const ROUTE_ESCALATION_REQUEST_CODE = 'ROUTE_ESCALATION_REQUEST'
const MAX_ROUTE_RUNTIME_PASSES = 5

function createId(prefix = 'task') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function truncateText(value, maxLength = 280) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function createRouteEscalationError({ targetTier, reason, routeState }) {
  const detail = [
    `Route escalation requested from "${routeState?.capabilityTier}" to "${targetTier}".`,
    reason ? `Reason: ${truncateText(reason)}` : null,
  ]
    .filter(Boolean)
    .join(' ')
  const error = createStructuredError(`请求升级到 ${targetTier} 能力层级。`, {
    source: 'system',
    category: 'execution_failed',
    code: ROUTE_ESCALATION_REQUEST_CODE,
    detail,
    suggestedAction: '重新挂载更高一层能力后继续完成本轮任务。',
  })
  error.routeEscalation = {
    targetTier,
    reason: typeof reason === 'string' ? reason.trim() : '',
    fromTier: routeState?.capabilityTier,
  }
  return error
}

function extractRouteEscalationRequest(error) {
  if (
    error &&
    typeof error === 'object' &&
    error.code === ROUTE_ESCALATION_REQUEST_CODE &&
    error.routeEscalation &&
    typeof error.routeEscalation === 'object'
  ) {
    return error.routeEscalation
  }
  return null
}

function buildRouteEscalationEvidence(toolEvents) {
  const evidenceLines = (toolEvents || [])
    .slice(-4)
    .map((event, index) => {
      const detail =
        summarizeToolOutput(event.output) ||
        event.errorInfo?.summary ||
        summarizeToolOutput(event.error, 180) ||
        event.summary ||
        event.name
      return `${index + 1}. ${event.name}: ${detail}`
    })

  if (evidenceLines.length === 0) {
    return 'No concrete tool evidence was produced before this escalation.'
  }

  return `Evidence already collected in the previous tier:\n${evidenceLines.join('\n')}`
}

function buildRouteEscalationNote({ fromTier, toTier, reason, toolEvents }) {
  return [
    `Route runtime note: the previous tier ${fromTier} has been escalated to ${toTier}.`,
    truncateText(reason) ? `Escalation reason: ${truncateText(reason)}.` : null,
    buildRouteEscalationEvidence(toolEvents),
    'Continue from this evidence and avoid repeating identical inspection steps unless the new tier needs fresh verification.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function appendRouteNotesToPrompt(systemPrompt, routeNotes) {
  if (!Array.isArray(routeNotes) || routeNotes.length === 0) {
    return systemPrompt
  }

  return [systemPrompt, ...routeNotes.slice(-2)].join('\n\n')
}

function appendCarryoverContextToPrompt(systemPrompt, carryoverContext) {
  const normalized = typeof carryoverContext === 'string' ? carryoverContext.trim() : ''
  if (!normalized) {
    return systemPrompt
  }

  return [
    systemPrompt,
    'Carryover evidence from earlier turns is already available below. Reuse it before repeating the same web lookup unless fresh verification is clearly necessary.',
    normalized,
  ].join('\n\n')
}

function buildRuntimeBlocks(routeStopReason) {
  return {
    hasCapabilityBlock:
      routeStopReason === 'budget_exhausted' || routeStopReason === 'runtime_pass_limit',
  }
}

function reasoningEffortRank(value) {
  switch (value) {
    case 'max':
      return 4
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
    case 'off':
    default:
      return 0
  }
}

function maxReasoningEffort(currentValue, minimumValue) {
  return reasoningEffortRank(currentValue) >= reasoningEffortRank(minimumValue)
    ? currentValue
    : minimumValue
}

function buildEffectiveRunSettings(settings, routeState) {
  if (!routeState || typeof routeState !== 'object') {
    return settings
  }

  if (routeState.researchMode === 'deep') {
    return {
      ...settings,
      reasoningEffort: maxReasoningEffort(settings.reasoningEffort, 'high'),
      maxSteps: Math.max(Number(settings.maxSteps) || 8, 18),
    }
  }

  if (routeState.responseStyle === 'research-structured') {
    return {
      ...settings,
      reasoningEffort: maxReasoningEffort(settings.reasoningEffort, 'medium'),
      maxSteps: Math.max(Number(settings.maxSteps) || 8, 12),
    }
  }

  return settings
}

function shouldLoadRuntimeCapabilityLayers(routeState) {
  return true
}

function buildCompletionContext(routeState, toolEvents, runtimeBlocks = {}) {
  const evidenceSummary = collectEvidenceFromToolEvents(toolEvents)
  const mergedEvidenceSummary = {
    ...evidenceSummary,
    hasApprovalBlock:
      runtimeBlocks.hasApprovalBlock === true || evidenceSummary.hasApprovalBlock,
    hasCapabilityBlock:
      runtimeBlocks.hasCapabilityBlock === true || evidenceSummary.hasCapabilityBlock,
  }
  const completionState = deriveCompletionState(
    routeState,
    mergedEvidenceSummary,
    runtimeBlocks,
  )
  return {
    completionState,
    evidenceSummary: mergedEvidenceSummary,
    deliveryPolicy: buildDeliveryPolicy(completionState),
  }
}

function buildRouteDecisionSnapshot({
  routeState,
  selectedCapabilities,
  selectedTools,
  escalationCount,
  availableEscalations,
  tierHistory,
  stopReason,
  classification,
  classificationSource,
  classificationReason,
  strategy,
}) {
  return {
    strategyDecision: strategy
      ? {
          chain: strategy.chain,
          reason: strategy.reason,
          requestedChain: strategy.requestedChain,
        }
      : undefined,
    intentClassification: classification
      ? {
          answerMode: classification.answerMode,
          needsExternalFacts: classification.needsExternalFacts,
          webInteractionRequired: classification.webInteractionRequired,
          workspaceRelated: classification.workspaceRelated,
          isCapabilityAdmin: classification.isCapabilityAdmin,
          systemBrowserRequested: classification.systemBrowserRequested,
          taskComplexity: classification.taskComplexity,
          planDepth: classification.planDepth,
          confidence: classification.confidence,
        }
      : undefined,
    classificationSource: classificationSource || undefined,
    classificationReason: classificationReason || undefined,
    answerMode: routeState.answerMode,
    capabilityTier: routeState.capabilityTier,
    budgets: {
      searchesRemaining: routeState.budgets?.searchesRemaining ?? 0,
      browserEscalationsRemaining:
        routeState.budgets?.browserEscalationsRemaining ?? 0,
      writeEscalationsRemaining: routeState.budgets?.writeEscalationsRemaining ?? 0,
    },
    allowEscalationTo: Array.isArray(routeState.allowEscalationTo)
      ? [...routeState.allowEscalationTo]
      : [],
    availableEscalations: Array.isArray(availableEscalations)
      ? [...availableEscalations]
      : [],
    escalationCount,
    tierHistory: Array.isArray(tierHistory) ? [...tierHistory] : [],
    stopReason: stopReason || undefined,
    mountedCapabilities: {
      skills: (selectedCapabilities?.capabilitySnapshot?.skills || [])
        .map(entry => entry.name || entry.id)
        .filter(Boolean),
      plugins: (selectedCapabilities?.capabilitySnapshot?.plugins || [])
        .map(entry => entry.name || entry.id)
        .filter(Boolean),
      mcpServers: (selectedCapabilities?.capabilitySnapshot?.mcpServers || [])
        .map(entry => entry.name || entry.id)
        .filter(Boolean),
      tools: (selectedTools || [])
        .map(tool => tool?.name)
        .filter(Boolean),
    },
  }
}

function inferRouteEscalationFromMessage(message, availableEscalations) {
  return null
}

function createRouteEscalationTool(routeState, availableEscalations) {
  if (!Array.isArray(availableEscalations) || availableEscalations.length === 0) {
    return null
  }

  return {
    source: 'builtin',
    name: ROUTE_ESCALATION_TOOL_NAME,
    description:
      'Request a route-first capability upgrade when the current tier is genuinely insufficient for the user goal.',
    internalOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        targetTier: {
          type: 'string',
          enum: availableEscalations,
          description: 'The higher capability tier needed to continue.',
        },
        reason: {
          type: 'string',
          description:
            'Why the current tier cannot honestly complete the task and why the target tier would materially help.',
        },
      },
      required: ['targetTier', 'reason'],
      additionalProperties: false,
    },
    async run(args, runtime = {}) {
      runtime.throwIfAborted?.()
      const targetTier = typeof args?.targetTier === 'string' ? args.targetTier : ''
      const reason = typeof args?.reason === 'string' ? args.reason : ''

      if (!availableEscalations.includes(targetTier)) {
        return {
          granted: false,
          allowedTargets: availableEscalations,
          message:
            'The requested route escalation is not available in this turn. Continue within the current tier or finish with an honest bounded answer.',
        }
      }

      throw createRouteEscalationError({
        targetTier,
        reason,
        routeState,
      })
    },
  }
}

function summarizeMountedToolAvailability(tools = []) {
  const names = new Set(
    (Array.isArray(tools) ? tools : []).map(tool => tool?.name).filter(Boolean),
  )

  return {
    hasReadonlyWorkspaceTools:
      names.has('list_files') ||
      names.has('glob_files') ||
      names.has('read_file') ||
      names.has('search_code'),
    hasWorkspaceWriteTools:
      names.has('apply_patch') ||
      names.has('write_file') ||
      names.has('edit_file') ||
      names.has('multi_edit_file') ||
      names.has('exec_command') ||
      names.has('write_stdin') ||
      names.has('run_shell'),
    hasWebRetrievalTools:
      names.has('web_search') ||
      names.has('web_fetch') ||
      names.has('web_research'),
    hasInteractiveBrowserTools:
      names.has('system_browser_open') ||
      [...names].some(name => name.startsWith('computer_')),
    hasCapabilityAdminTools:
      [...names].some(name => name.startsWith('aura_')),
  }
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
    inProgress: retryInfo.inProgress === true,
    nextRetryDelayMs:
      typeof retryInfo.nextRetryDelayMs === 'number' &&
      Number.isFinite(retryInfo.nextRetryDelayMs)
        ? Math.max(0, Math.round(retryInfo.nextRetryDelayMs))
        : undefined,
    nextAttemptNumber:
      typeof retryInfo.nextAttemptNumber === 'number' &&
      Number.isFinite(retryInfo.nextAttemptNumber)
        ? Math.max(1, Math.round(retryInfo.nextAttemptNumber))
        : undefined,
    lastErrorSummary:
      typeof retryInfo.lastErrorSummary === 'string'
        ? retryInfo.lastErrorSummary
        : undefined,
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

function hasTerminalPunctuation(value) {
  return /[。！？.!?]["')\]]*\s*$/u.test(String(value || '').trim())
}

function looksLikeStructuredUserAnswer(value) {
  const normalized = normalizeFinalAnswer(value)
  if (!normalized) {
    return false
  }

  if (/\n[-*]\s/u.test(normalized) || /\n\d+\.\s/u.test(normalized)) {
    return true
  }

  const sentenceCount = (normalized.match(/[。！？.!?]+/gu) || []).length
  return sentenceCount >= 2 || hasTerminalPunctuation(normalized)
}

function looksLikeExecutionCompletionClaim(value) {
  const normalized = normalizeFinalAnswer(value).toLowerCase()
  if (!normalized) {
    return false
  }

  return (
    /\b(done|completed|finished|fixed|resolved|implemented|updated|created|written|saved|patched|modified)\b/u.test(
      normalized,
    ) ||
    /(已完成|已经完成|搞定了|已修复|已经修复|已实现|已经实现|已更新|已经更新|已创建|已经创建|已写好|已经写好|保存到|存到|写到|修改了|改好了)/u.test(
      normalized,
    )
  )
}

function shouldRunFinalization(
  result,
  recentToolEvents,
  routeState,
  completionContext = null,
) {
  const finalMessage = normalizeFinalAnswer(result.message)
  const providerReasoning = extractProviderReasoning(result.reasoning || [])
  const hasToolContext = Array.isArray(recentToolEvents) && recentToolEvents.length > 0
  const completionState = completionContext?.completionState || result?.completionState
  if (!hasToolContext) {
    return (
      providerReasoning.length >= 140 &&
      (!finalMessage || finalMessage === '模型没有返回文本内容。')
    )
  }
  if (!finalMessage || finalMessage === '模型没有返回文本内容。') {
    return true
  }

  if (
    completionState === 'executed_verified' &&
    finalMessage.length >= 80 &&
    (looksLikeStructuredUserAnswer(finalMessage) || hasTerminalPunctuation(finalMessage))
  ) {
    return false
  }

  if (
    completionState &&
    completionState !== 'executed_verified' &&
    finalMessage.length >= 90 &&
    looksLikeStructuredUserAnswer(finalMessage) &&
    !looksLikeExecutionCompletionClaim(finalMessage)
  ) {
    return false
  }

  if (
    routeState?.responseStyle === 'research-structured' &&
    finalMessage.length < 140
  ) {
    return true
  }

  if (routeState?.answerMode === 'execute' && finalMessage.length < 90) {
    return true
  }

  if (finalMessage.length >= 140 && looksLikeStructuredUserAnswer(finalMessage)) {
    return false
  }

  if (finalMessage.length >= 110 && hasTerminalPunctuation(finalMessage)) {
    return false
  }

  return (
    providerReasoning.length > 200 &&
    finalMessage.length < 120 &&
    !looksLikeStructuredUserAnswer(finalMessage)
  )
}

async function runProviderTurn({
  settings,
  systemPrompt,
  messages,
  tools,
  toolEvents,
  routeState,
  hooks,
  taskTracker,
  currentTaskId,
}) {
  const startingToolEventCount = toolEvents.length
  const providerHooks = {
    ...hooks,
    settings,
    routeState,
    researchMode: routeState?.researchMode || 'auto',
    taskTracker,
    currentTaskId,
  }

  if (settings.provider === 'google') {
    hooks?.onPhaseChange?.('model_connecting')
    let result = await runGoogleAgent({
      settings,
      systemPrompt,
      messages,
      tools,
      toolEvents,
      hooks: providerHooks,
    })
    const resolvedMessages = result.messages || messages
    const recentToolEvents = toolEvents.slice(startingToolEventCount)
    const completionContext = buildCompletionContext(routeState, toolEvents)

    if (shouldRunFinalization(result, recentToolEvents, routeState, completionContext)) {
      try {
        hooks?.onPhaseChange?.('finalizing')
        const finalized = await finalizeGoogleAnswer({
          settings,
          systemPrompt,
          messages: resolvedMessages,
          toolEvents: recentToolEvents,
          reasoningText: extractProviderReasoning(result.reasoning || []),
          draftMessage: result.message,
          completionState: completionContext.completionState,
          deliveryPolicy: completionContext.deliveryPolicy,
          responseStyle: routeState?.responseStyle,
          stage: 'finalization',
          hooks: providerHooks,
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

    return {
      result,
      resolvedMessages,
    }
  }

  if (settings.provider === 'openai' || settings.provider === 'custom') {
    hooks?.onPhaseChange?.('model_connecting')
    let result = await runOpenAiCompatibleAgent({
      settings,
      systemPrompt,
      messages,
      tools,
      toolEvents,
      hooks: providerHooks,
    })
    const resolvedMessages = result.messages || messages
    const recentToolEvents = toolEvents.slice(startingToolEventCount)
    const completionContext = buildCompletionContext(routeState, toolEvents)

    if (shouldRunFinalization(result, recentToolEvents, routeState, completionContext)) {
      try {
        hooks?.onPhaseChange?.('finalizing')
        const finalized = await finalizeOpenAiCompatibleAnswer({
          settings,
          systemPrompt,
          messages: resolvedMessages,
          toolEvents: recentToolEvents,
          reasoningText: extractProviderReasoning(result.reasoning || []),
          draftMessage: result.message,
          completionState: completionContext.completionState,
          deliveryPolicy: completionContext.deliveryPolicy,
          responseStyle: routeState?.responseStyle,
          stage: 'finalization',
          hooks: providerHooks,
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

    return {
      result,
      resolvedMessages,
    }
  }

  throw createStructuredError(`模型调用失败，当前 Provider "${settings.provider}" 不受支持。`, {
    source: 'provider',
    category: 'unsupported',
    code: 'UNSUPPORTED_PROVIDER',
    detail: `Unsupported provider: ${settings.provider}`,
    suggestedAction: '请切换到已支持的 Provider 后再试。',
  })
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

export async function runRouteFirstAgent(request) {
  const {
    settings,
    messages,
    runtime = {},
    hooks = {},
    capabilities,
    carryoverContext = '',
  } = request
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
    settings,
    cleanupHandlers: [],
  }
  const taskTracker =
    runtime.taskTracker || createTaskTracker(hooks, summarizeMessages(messages))
  const currentTaskId = runtime.currentTaskId || taskTracker.rootId
  taskTracker.setStatus(currentTaskId, 'running')
  const hardSignals = deriveHardSignals(messages)
  const initialNormalizedClassification = null
  const initialRouteState = inferRouteState(messages, {
    classification: initialNormalizedClassification,
    hardSignals,
    settings,
  })
  const shouldLoadCapabilityLayers = shouldLoadRuntimeCapabilityLayers(initialRouteState)

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
  const [classificationResult, skillCatalog, pluginInventory, mcpInventory] = await Promise.all([
    resolveIntentClassification(messages, settings, {
      hardSignals,
      settings,
    }).catch(() => null),
    shouldLoadCapabilityLayers
      ? loadSkillCatalog(appRoot, capabilities?.skills || settings.enabledSkillIds || [])
      : Promise.resolve([]),
    shouldLoadCapabilityLayers
      ? loadPluginToolInventory(
          appRoot,
          capabilities?.plugins || settings.enabledPluginIds || [],
          context,
        )
      : Promise.resolve({
          activeTools: [],
          discoverableTools: [],
        }),
    shouldLoadCapabilityLayers
      ? loadMcpToolInventory({
          activeServers: capabilities?.mcpServers || settings.mcpServers || [],
          configuredServers: settings.mcpServers || [],
        })
      : Promise.resolve({
          activeTools: [],
          discoverableTools: [],
          async close() {},
        }),
  ])
  const toolRegistry = createToolRegistry({
    builtinTools,
    advancedTools,
    pluginTools: pluginInventory.activeTools,
    mcpTools: mcpInventory.activeTools,
    discoverableTools: [
      ...pluginInventory.discoverableTools,
      ...mcpInventory.discoverableTools,
    ],
  })
  const classification = classificationResult?.classification || null
  const normalizedClassification = classification
    ? applyHardSignalIntentOverrides(classification, hardSignals)
    : null
  const strategy = selectAgentStrategy(normalizedClassification, hardSignals, {
    orchestratedAvailable: ORCHESTRATED_AGENT_AVAILABLE,
  })

  if (strategy.chain === 'orchestrated' && ORCHESTRATED_AGENT_AVAILABLE) {
    await mcpInventory.close().catch(() => {})
    return runOrchestratedAgent(request)
  }

  let routeState = normalizedClassification
    ? inferRouteState(messages, {
        classification: normalizedClassification,
        hardSignals,
        settings,
      })
    : initialRouteState
  const visitedTiers = new Set([routeState.capabilityTier])
  const routeNotes = []
  const routeHistory = []
  let routeEscalationCount = 0
  let lastSelectedCapabilities = null
  let lastSystemPrompt = ''
  let lastRouteDecision = {
    strategyDecision: strategy,
    intentClassification: normalizedClassification || undefined,
    classificationSource: classificationResult?.source || undefined,
    classificationReason: classificationResult?.reason || undefined,
    answerMode: routeState.answerMode,
    capabilityTier: routeState.capabilityTier,
    budgets: {
      searchesRemaining: routeState.budgets?.searchesRemaining ?? 0,
      browserEscalationsRemaining: routeState.budgets?.browserEscalationsRemaining ?? 0,
      writeEscalationsRemaining: routeState.budgets?.writeEscalationsRemaining ?? 0,
    },
    allowEscalationTo: Array.isArray(routeState.allowEscalationTo)
      ? [...routeState.allowEscalationTo]
      : [],
    availableEscalations: [],
    escalationCount: routeEscalationCount,
    tierHistory: [routeState.capabilityTier],
  }

  try {
    for (let pass = 0; pass < MAX_ROUTE_RUNTIME_PASSES; pass += 1) {
      const availableEscalations = getRouteEscalationTargets(routeState, {
        visitedTiers,
      })
      const promptRouteState = {
        ...routeState,
        availableEscalations,
      }
      const effectiveRunSettings = buildEffectiveRunSettings(settings, promptRouteState)
      const toolRouter = createToolRouter(toolRegistry, routeState)
      const routedTools = applyRouteToolBudgets(
        toolRouter.modelVisibleTools,
        routeState,
      )
      const selectedCapabilities = selectTurnCapabilities({
        messages,
        runtimeCapabilities: capabilities,
        skillEntries: skillCatalog,
        tools: routedTools,
        classification: normalizedClassification,
        routeState,
      })
      const mountedToolAvailability = summarizeMountedToolAvailability(
        selectedCapabilities.selectedTools,
      )
      lastSelectedCapabilities = selectedCapabilities
      const skillPrompt = buildSkillPrompt(selectedCapabilities.selectedSkills)
      const exposureNote = buildAgentCapabilityExposureNote(
        selectedCapabilities.capabilitySnapshot,
        promptRouteState,
        {
          deferredToolCount: toolRouter.deferredTools.length,
          discoverableToolCount: toolRouter.discoverableToolCount,
          discoverableOnlyToolCount: toolRouter.discoverableOnlyToolCount,
          ...mountedToolAvailability,
        },
      )
      lastSystemPrompt = appendCarryoverContextToPrompt(
        appendRouteNotesToPrompt(
          buildRouteFirstSystemPrompt(
            effectiveRunSettings,
            skillPrompt,
            exposureNote,
            promptRouteState,
            mountedToolAvailability,
          ),
          routeNotes,
        ),
        carryoverContext,
      )
      const escalationTool = createRouteEscalationTool(
        promptRouteState,
        availableEscalations,
      )
      const allTools = escalationTool
        ? [...selectedCapabilities.selectedTools, escalationTool]
        : selectedCapabilities.selectedTools
      lastRouteDecision = buildRouteDecisionSnapshot({
        routeState: promptRouteState,
        selectedCapabilities,
        selectedTools: selectedCapabilities.selectedTools,
        escalationCount: routeEscalationCount,
        availableEscalations,
        tierHistory: [...routeHistory.map(entry => entry.capabilityTier), routeState.capabilityTier],
        classification: normalizedClassification,
        classificationSource: classificationResult?.source,
        classificationReason: classificationResult?.reason,
        strategy,
      })
      const turnToolEventStart = toolEvents.length

      let turnResult
      try {
        turnResult = await runProviderTurn({
          settings: effectiveRunSettings,
          systemPrompt: lastSystemPrompt,
          messages,
          tools: allTools,
          toolEvents,
          routeState: promptRouteState,
          hooks: {
            ...hooks,
            rethrowToolError(error) {
              return extractRouteEscalationRequest(error) !== null
            },
          },
          taskTracker,
          currentTaskId,
        })
      } catch (error) {
        const escalationRequest = extractRouteEscalationRequest(error)
        if (escalationRequest) {
          const nextRouteState = escalateRouteState(
            routeState,
            escalationRequest.targetTier,
          )
          routeNotes.push(
            buildRouteEscalationNote({
              fromTier: routeState.capabilityTier,
              toTier: nextRouteState.capabilityTier,
              reason: escalationRequest.reason,
              toolEvents: toolEvents.slice(turnToolEventStart),
            }),
          )
          routeEscalationCount += 1
          routeState = nextRouteState
          visitedTiers.add(routeState.capabilityTier)
          taskTracker.setStatus(
            currentTaskId,
            'running',
            `能力升级到 ${routeState.capabilityTier}`,
          )
          hooks?.onPhaseChange?.('preparing')
          continue
        }
        throw error
      }

      let result = turnResult.result
      const capabilityContract = evaluateRuntimeCapabilityContract({
        routeState: promptRouteState,
        selectedTools: selectedCapabilities.selectedTools,
        toolEvents,
        message: result.message,
      })

      if (capabilityContract) {
        if (routeNotes.at(-1) !== capabilityContract.note) {
          routeNotes.push(capabilityContract.note)
        }
        taskTracker.setStatus(
          currentTaskId,
          'running',
          capabilityContract.retrySummary,
        )
        hooks?.onPhaseChange?.('preparing')
        continue
      }

      const desiredEscalation = inferRouteEscalationFromMessage(
        result.message,
        routeState.allowEscalationTo,
      )
      const turnSummary = summarizeRouteTurn({
        routeState: promptRouteState,
        resultMessage: result.message,
        toolEvents,
        eventStartIndex: turnToolEventStart,
      })
      const routeStopReason = determineRouteStopReason({
        routeHistory,
        currentTurn: turnSummary,
        desiredEscalationTarget: desiredEscalation,
        availableEscalations,
      })

      if (routeStopReason) {
        result = {
          ...result,
          message: buildRouteStopMessage({
            stopReason: routeStopReason,
            message: result.message,
            routeState,
            desiredEscalationTarget: desiredEscalation,
          }),
        }
      }

      const runtimeBlocks = buildRuntimeBlocks(routeStopReason)
      result = enforceEvidencePolicy(result, toolEvents, promptRouteState, runtimeBlocks)
      result = applyCompletionGate(result, promptRouteState)

      routeHistory.push(turnSummary)
      lastRouteDecision = buildRouteDecisionSnapshot({
        routeState: promptRouteState,
        selectedCapabilities,
        selectedTools: selectedCapabilities.selectedTools,
        escalationCount: routeEscalationCount,
        availableEscalations,
        tierHistory: routeHistory.map(entry => entry.capabilityTier).filter(Boolean),
        classification: normalizedClassification,
        classificationSource: classificationResult?.source,
        classificationReason: classificationResult?.reason,
        strategy,
        stopReason:
          routeStopReason ||
          (result.completionState === 'executed_verified' &&
          routeState.completionPolicy?.requiresEvidenceForDone
            ? 'completed_with_evidence'
            : 'completed'),
      })

      const inferredEscalation = inferRouteEscalationFromMessage(
        result.message,
        availableEscalations,
      )

      if (inferredEscalation && !routeStopReason) {
        const nextRouteState = escalateRouteState(routeState, inferredEscalation)
        routeNotes.push(
          buildRouteEscalationNote({
            fromTier: routeState.capabilityTier,
            toTier: nextRouteState.capabilityTier,
            reason: result.message,
            toolEvents: toolEvents.slice(turnToolEventStart),
          }),
        )
        routeEscalationCount += 1
        routeState = nextRouteState
        visitedTiers.add(routeState.capabilityTier)
        taskTracker.setStatus(
          currentTaskId,
          'running',
          `能力升级到 ${routeState.capabilityTier}`,
        )
        hooks?.onPhaseChange?.('preparing')
        continue
      }

      const summaryReasoning = summarizeReasoning(
        turnResult.resolvedMessages,
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
        agentMode: 'route-first',
        routeDecision: lastRouteDecision,
        capabilitySnapshot: selectedCapabilities.capabilitySnapshot,
        reasoning,
        retryInfo: result.retryInfo,
        status: 'completed',
        taskTree: taskTracker.getTree(),
      }
    }

    throw createStructuredError('Route-first 执行在多次能力升级后仍未收敛到最终回答。', {
      source: 'system',
      category: 'execution_failed',
      code: 'ROUTE_RUNTIME_EXHAUSTED',
      detail: `Route runtime exceeded ${MAX_ROUTE_RUNTIME_PASSES} passes without converging.`,
      suggestedAction: '请缩小任务范围，或调整任务指令后再试。',
    })
  } catch (error) {
    const normalized = normalizeAgentError(error)
    const partialMessage = extractPartialProviderMessage(normalized)
    const partialReasoning = extractPartialProviderReasoning(normalized)
    const retryInfo = extractProviderRetryInfo(normalized)
    const hasRecoveryContext =
      toolEvents.length > 0 || partialMessage.length > 0

    if (normalized.source === 'provider' && hasRecoveryContext) {
      let recoveryRetryInfo
      const recoveryCompletionContext = buildCompletionContext(
        routeState,
        toolEvents,
        buildRuntimeBlocks(lastRouteDecision?.stopReason),
      )
      try {
        hooks?.onPhaseChange?.('recovering')
        const recovered =
          settings.provider === 'google'
            ? await finalizeGoogleAnswer({
                settings: buildEffectiveRunSettings(settings, routeState),
                systemPrompt: lastSystemPrompt,
                messages,
                toolEvents,
                reasoningText: partialReasoning,
                draftMessage: partialMessage,
                completionState: recoveryCompletionContext.completionState,
                deliveryPolicy: recoveryCompletionContext.deliveryPolicy,
                responseStyle: routeState?.responseStyle,
                stage: 'recovery',
                hooks,
              })
            : await finalizeOpenAiCompatibleAnswer({
                settings: buildEffectiveRunSettings(settings, routeState),
                systemPrompt: lastSystemPrompt,
                messages,
                toolEvents,
                reasoningText: partialReasoning,
                draftMessage: partialMessage,
                completionState: recoveryCompletionContext.completionState,
                deliveryPolicy: recoveryCompletionContext.deliveryPolicy,
                responseStyle: routeState?.responseStyle,
                stage: 'recovery',
                hooks,
              })

        if (recovered.message.trim()) {
          let recoveredResult = enforceEvidencePolicy(
            recovered,
            toolEvents,
            routeState,
            buildRuntimeBlocks(lastRouteDecision?.stopReason),
          )
          recoveredResult = applyCompletionGate(recoveredResult, routeState)
          const summaryReasoning = summarizeReasoning(
            messages,
            toolEvents,
            recoveredResult.message,
          )
          hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
            blockId: summaryReasoning[0].id,
            kind: summaryReasoning[0].kind,
          })
          taskTracker.completeTask(currentTaskId, '生成最终回答')
          return {
            ...recoveredResult,
            toolEvents,
            agentMode: 'route-first',
            routeDecision: lastRouteDecision,
            capabilitySnapshot: lastSelectedCapabilities?.capabilitySnapshot,
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
      let fallbackResult = enforceEvidencePolicy(
        { message: fallbackMessage },
        toolEvents,
        routeState,
        buildRuntimeBlocks(lastRouteDecision?.stopReason),
      )
      fallbackResult = applyCompletionGate(fallbackResult, routeState)
      const summaryReasoning = summarizeReasoning(
        messages,
        toolEvents,
        fallbackResult.message,
      )
      hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
        blockId: summaryReasoning[0].id,
        kind: summaryReasoning[0].kind,
      })
      taskTracker.completeTask(currentTaskId, '生成部分恢复回答')
      return {
        ...fallbackResult,
        toolEvents,
        agentMode: 'route-first',
        routeDecision: lastRouteDecision,
        capabilitySnapshot: lastSelectedCapabilities?.capabilitySnapshot,
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
    enriched.agentMode = 'route-first'
    enriched.routeDecision = {
      ...lastRouteDecision,
      stopReason:
        lastRouteDecision?.stopReason ||
        (normalized.code === 'ROUTE_RUNTIME_EXHAUSTED'
          ? 'runtime_pass_limit'
          : lastRouteDecision?.stopReason),
    }
    throw enriched
  } finally {
    await Promise.allSettled(
      (Array.isArray(context.cleanupHandlers) ? context.cleanupHandlers : []).map(handler =>
        Promise.resolve().then(() => handler?.()),
      ),
    )
    await mcpInventory.close()
  }
}

function resolveAgentMode(settings) {
  return settings?.agentArchitectureMode === 'orchestrated'
    ? 'orchestrated'
    : 'route-first'
}

export async function runAgent(request) {
  const agentMode = resolveAgentMode(request?.settings)
  if (agentMode === 'orchestrated') {
    return runOrchestratedAgent(request)
  }
  return runRouteFirstAgent(request)
}
