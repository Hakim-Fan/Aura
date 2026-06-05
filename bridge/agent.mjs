import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectTurnCapabilities } from './capabilitySelector.mjs'
import { createAdvancedTools } from './advancedTools.mjs'
import {
  buildCapabilityExposureNote as buildAgentCapabilityExposureNote,
  buildDefaultAgentPromptBlocks,
  buildDefaultAgentSystemPrompt,
} from './agentPrompting.mjs'
import {
  diffPromptBlockSnapshots,
  promptBlockSnapshot as snapshotPromptBlocks,
  renderPromptBlocks,
} from './promptBlocks.mjs'
import {
  applyRouteToolBudgets,
  escalateRouteState,
  getRouteEscalationTargets,
} from './agentRouting.mjs'
import {
  buildSkillPrompt,
  loadPluginToolInventory,
  loadSkillCatalog,
} from './extensions.mjs'
import { loadMcpToolInventory } from './mcp.mjs'
import {
  compactMessagesWithProvider,
  finalizeGoogleAnswer,
  finalizeOpenAiCompatibleAnswer,
  runGoogleAgent,
  runOpenAiCompatibleAgent,
  stripInlineToolCallText,
} from './providers.mjs'
import {
  buildContextCompressionBudget,
  estimateTextTokens,
  shouldCompressMessages,
  estimateMessagesTokens,
} from './contextCompression.mjs'
import { createStructuredError, normalizeRuntimeError } from './runtimeErrors.mjs'
import {
  appendRuntimeExecutionContextToSystemPrompt,
  createBuiltinTools,
} from './tools.mjs'
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
import { evaluateRuntimeCapabilityContract } from './runtimeCapabilityContract.mjs'
import { createToolRegistry } from './toolRegistry.mjs'
import { createToolRouter } from './toolRouter.mjs'
import { createExecutionStepIdFactory } from './executionIds.mjs'
import {
  createCheckpointManager,
} from './checkpoint.mjs'
import {
  upsertWorkMemory,
} from './workMemory.mjs'
import {
  buildErrorDetails,
  buildMetricsSummaryDetails,
  buildRunFinishedDetails,
  createAgentRuntimeLogger,
  resolveAgentExecutionMode,
  wrapAgentRuntimeHooks,
} from './agentRuntimeLogs.mjs'
import {
  createProjectMemoryRuntime,
  isProjectMemoryEnabled,
  scheduleProjectMemoryIdleUpdate,
} from './projectMemory.mjs'
import { resolveTaskFrame } from './agent/taskFrame.mjs'
import { compactVisibleTaskTitle } from './taskTitles.mjs'
import {
  buildToolFailureContinuationNote,
  shouldContinueAfterToolFailure,
} from './agent/toolFailureContinuationGate.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROUTE_ESCALATION_TOOL_NAME = 'route_request_escalation'
const ROUTE_ESCALATION_REQUEST_CODE = 'ROUTE_ESCALATION_REQUEST'
const MAX_ROUTE_RUNTIME_PASSES = 5
const MAX_TOOL_FAILURE_CONTINUATION_ATTEMPTS = 2
const CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES = 6

function createId(prefix = 'task') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeMessageId(message) {
  const id = typeof message?.id === 'string' ? message.id.trim() : ''
  return id || ''
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

function normalizePersistedToolEvidence(memories = []) {
  const entries = []
  for (const memory of Array.isArray(memories) ? memories : []) {
    if (memory?.kind !== 'tool_evidence') {
      continue
    }
    const recentSuccesses = Array.isArray(memory?.content?.recentSuccesses)
      ? memory.content.recentSuccesses
      : []
    for (const entry of recentSuccesses) {
      if (!entry || typeof entry !== 'object' || !entry.tool) {
        continue
      }
      entries.push({
        ...entry,
        restoredFromWorkMemory: true,
        workMemoryId: memory.id,
      })
    }
  }
  return entries.slice(-12)
}

function attachmentObservationKey(attachment = {}) {
  return [
    attachment.path || attachment.filePath || '',
    attachment.name || attachment.filename || '',
    attachment.mimeType || attachment.type || '',
  ].join('::')
}

function summarizeAttachmentObservation(attachment = {}) {
  return {
    name: truncateText(attachment.name || attachment.filename || '', 120),
    path: truncateText(attachment.path || attachment.filePath || '', 320),
    type: truncateText(attachment.mimeType || attachment.type || '', 120),
  }
}

function collectAttachmentObservations(messages = []) {
  const seen = new Set()
  const observations = []
  const add = (attachment) => {
    const normalized = summarizeAttachmentObservation(attachment)
    if (!normalized.name && !normalized.path) {
      return
    }
    const key = attachmentObservationKey(normalized)
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    observations.push(normalized)
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      add(attachment)
    }
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type === 'file' || part?.type === 'image') {
        add(part)
      }
    }
  }
  return observations.slice(-12)
}

async function recordInitialContextObservations(request = {}, logger) {
  const hooks = request?.hooks || {}
  const logContext = request?.logContext || {}
  const sessionId = typeof logContext.sessionId === 'string' ? logContext.sessionId.trim() : ''
  if (!sessionId || typeof hooks.appControl !== 'function') {
    return []
  }

  const attachments = collectAttachmentObservations(request.messages)
  if (attachments.length === 0) {
    return []
  }

  const taskId = typeof logContext.taskId === 'string' ? logContext.taskId.trim() : ''
  const memory = {
    id: `work-memory-${sessionId || 'session'}-${taskId || 'task'}-attachment-observations`,
    sessionId,
    taskId,
    assistantMessageId: logContext.assistantMessageId || '',
    kind: 'file_observation',
    title: 'User attachment observations',
    summary: `Current or recent user messages include ${attachments.length} attachment(s): ${attachments
      .map(attachment => attachment.path || attachment.name)
      .filter(Boolean)
      .slice(0, 5)
      .join('; ')}.`,
    status: 'confirmed',
    content: {
      attachments,
    },
    sourceRefs: attachments.map(attachment => ({
      path: attachment.path,
      name: attachment.name,
      type: attachment.type,
    })),
    nextUse:
      'Use these attachment paths as recoverable task context. Read the file only when exact content is needed; otherwise reuse summaries and prior file observations.',
  }

  try {
    const stored = await hooks.appControl('record_work_memory', { memory })
    logger?.emit?.('agent.memory.attachment_observations_recorded', {
      memoryId: stored?.id || memory.id,
      attachmentCount: attachments.length,
    })
    return [stored || memory]
  } catch (error) {
    logger?.emit?.(
      'agent.memory.attachment_observations_failed',
      {
        attachmentCount: attachments.length,
        error: error?.message || String(error),
      },
      { level: 'warn' },
    )
    return []
  }
}

function buildPreflightSystemPromptEstimate({
  messages,
  settings,
  carryoverContext = '',
}) {
  const routeState = createDefaultAgentRouteState(settings)
  const promptRouteState = {
    ...routeState,
    availableEscalations: [],
  }
  const estimatedSystemPrompt = buildDefaultAgentSystemPrompt(
    buildEffectiveRunSettings(settings, promptRouteState),
    '',
    '',
    promptRouteState,
    summarizeMountedToolAvailability([]),
  )

  return appendCarryoverContextToPrompt(estimatedSystemPrompt, carryoverContext)
}

function findCompressedThroughMessageId(originalMessages, compactedMessages) {
  const originals = Array.isArray(originalMessages) ? originalMessages : []
  const compacted = Array.isArray(compactedMessages) ? compactedMessages : []
  if (originals.length === 0 || compacted.length <= 1) {
    return ''
  }

  const firstKeptRecentId = normalizeMessageId(compacted[1])
  if (firstKeptRecentId) {
    const firstKeptIndex = originals.findIndex(
      message => normalizeMessageId(message) === firstKeptRecentId,
    )
    if (firstKeptIndex > 0) {
      return normalizeMessageId(originals[firstKeptIndex - 1])
    }
    if (firstKeptIndex === 0) {
      return ''
    }
  }

  const recentCount = Math.max(0, compacted.length - 1)
  const compressedThroughIndex = originals.length - recentCount - 1
  if (compressedThroughIndex < 0) {
    return ''
  }
  return normalizeMessageId(originals[compressedThroughIndex])
}

function buildContextCompressionCheckpoint({
  messages,
  compactedMessages,
  settings,
  beforeTokens,
  afterTokens,
  budget,
  trigger,
  activePromptTokens,
  activePromptLimit,
  compressedActivePromptTokens,
  stage,
}) {
  const summary =
    typeof compactedMessages?.[0]?.content === 'string'
      ? compactedMessages[0].content.trim()
      : ''
  const compressedThroughMessageId = findCompressedThroughMessageId(
    messages,
    compactedMessages,
  )
  if (!summary || !compressedThroughMessageId) {
    return undefined
  }

  return {
    id: createId('auto-context-compression'),
    summary,
    compressedThroughMessageId,
    originalMessageCount: Array.isArray(messages) ? messages.length : 0,
    originalTokenEstimate: Math.max(
      0,
      Math.round(Number(activePromptTokens || beforeTokens) || 0),
    ),
    compressedTokenEstimate: Math.max(
      0,
      Math.round(Number(compressedActivePromptTokens || afterTokens) || 0),
    ),
    createdAt: Date.now(),
    kind: stage === 'preflight' ? 'agent_preflight' : 'agent_runtime',
    trigger: trigger || 'active_context',
    activePromptTokens: Math.max(0, Math.round(Number(activePromptTokens) || 0)),
    activePromptLimit: Math.max(0, Math.round(Number(activePromptLimit) || 0)),
    contextWindowTokens: Math.max(0, Math.round(Number(budget?.contextWindowTokens) || 0)),
    configuredContextWindowTokens: Math.max(
      0,
      Math.round(Number(budget?.configuredContextWindowTokens) || 0),
    ) || undefined,
    configuredThresholdTokens: Math.max(
      0,
      Math.round(Number(budget?.configuredThresholdTokens) || 0),
    ) || undefined,
    compressionThresholdTokens: Math.max(
      0,
      Math.round(Number(budget?.compressionThresholdTokens) || 0),
    ) || undefined,
    effectiveThresholdTokens: Math.max(
      0,
      Math.round(Number(budget?.effectiveThresholdTokens) || 0),
    ) || undefined,
    systemPromptTokens: Math.max(0, Math.round(Number(budget?.systemPromptTokens) || 0)),
    toolSchemaTokens: Math.max(0, Math.round(Number(budget?.toolSchemaTokens) || 0)),
    maxOutputTokens: Math.max(0, Math.round(Number(budget?.maxOutputTokens) || 0)),
    toolResultBufferTokens: Math.max(
      0,
      Math.round(Number(budget?.toolResultBufferTokens) || 0),
    ),
    summaryTokens: estimateTextTokens(summary, settings),
    windowSource: budget?.windowSource,
    preserved: ['compressed_summary', 'recent_messages', 'runtime_tool_evidence'],
    providerProfileId:
      typeof settings?.activeProviderProfileId === 'string'
        ? settings.activeProviderProfileId
        : undefined,
    model: typeof settings?.model === 'string' ? settings.model : undefined,
  }
}

async function maybeCompressMessagesForContext({
  messages,
  settings,
  systemPrompt = '',
  toolSchemaTokens = 0,
  latestInputTokens = 0,
  hooks,
  stage,
}) {
  const compressionState = shouldCompressMessages(messages, settings, {
    systemPrompt,
    toolSchemaTokens,
    keepRecentCount: CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES,
    latestInputTokens,
  })

  if (!compressionState.shouldCompress) {
    return {
      messages,
      compressed: false,
      beforeTokens: compressionState.estimatedTokens,
      afterTokens: compressionState.estimatedTokens,
      budget: compressionState.budget,
    }
  }

  const compactedMessages = await compactMessagesWithProvider({
    settings,
    messages,
    targetTokens: compressionState.budget.targetConversationTokens,
    keepRecentCount: CONTEXT_COMPRESSION_KEEP_RECENT_MESSAGES,
    maxInputBatchTokens: compressionState.budget.compactionInputBatchTokens,
    hooks,
  })
  const afterTokens = estimateMessagesTokens(compactedMessages, settings)
  const recomputedActiveContextTokens =
    compressionState.budget.systemPromptTokens +
    compressionState.budget.toolSchemaTokens +
    afterTokens
  const contextCompression = buildContextCompressionCheckpoint({
    messages,
    compactedMessages,
    settings,
    beforeTokens: compressionState.estimatedTokens,
    afterTokens,
    budget: compressionState.budget,
    trigger: compressionState.trigger,
    activePromptTokens: compressionState.activePromptTokens,
    activePromptLimit: compressionState.activePromptLimit,
    compressedActivePromptTokens: recomputedActiveContextTokens,
    stage,
  })
  if (contextCompression) {
    hooks?.onContextCompression?.(contextCompression)
  }
  hooks?.onActiveContextEstimate?.({
    latestInputTokens: recomputedActiveContextTokens,
    contextWindow: compressionState.budget.contextWindowTokens,
    allowDecrease: true,
    reason: 'context_compression',
  })
  hooks?.onReasoningDelta?.(
    [
      `Context compression (${stage || 'runtime'}):`,
      `${compressionState.activePromptTokens} active tokens -> ${recomputedActiveContextTokens} active tokens.`,
      compressionState.trigger === 'provider_usage'
        ? `Triggered by provider usage (${compressionState.latestInputTokens} active tokens).`
        : '',
    ].filter(Boolean).join(' '),
    {
      blockId: `context-compression-${stage || 'runtime'}`,
      kind: 'summary',
      order: -100,
    },
  )

  return {
    messages: compactedMessages,
    compressed: true,
    beforeTokens: compressionState.estimatedTokens,
    afterTokens,
    budget: compressionState.budget,
    contextCompression,
  }
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

function createDefaultAgentRouteState(settings = {}) {
  const computerUseEnabled =
    process.platform === 'darwin' &&
    (settings?.browser?.interactive?.enabled === true ||
      settings?.enableComputerUse === true)
  return {
    modelDirected: true,
    capabilityTier: computerUseEnabled ? 'browser-interactive' : 'default-agent',
    researchMode: 'auto',
    webRetrievalAvailable: true,
    needsExternalFacts: false,
    webInteractionRequired: computerUseEnabled,
    workspaceRelated: true,
    responseStyle: 'adaptive-default',
    taskComplexity: 'model_directed',
    planDepth: 'model_directed',
    executionMode: settings?.executionMode === 'long-task' ? 'long-task' : 'bounded',
    allowEscalationTo: [],
    budgets: {},
    isCapabilityAdminTask: false,
    explicitSystemBrowserRequest: false,
  }
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

const EXPLORER_READ_ONLY_TOOL_NAMES = new Set([
  'list_files',
  'glob_files',
  'read_file',
  'read_block',
  'search_code',
  'read_artifact_slice',
  'summarize_artifact',
  'todo_write',
  'aura_list_capabilities',
  'aura_read_skill',
  'web_search',
  'web_fetch',
  'web_research',
])

const VERIFICATION_TOOL_NAMES = new Set([
  'list_files',
  'glob_files',
  'read_file',
  'read_block',
  'search_code',
  'verify_artifact',
  'exec_command',
  'write_stdin',
  'run_shell',
])

export function filterToolsForSubagentRole(tools = [], runtime = {}) {
  const role = String(runtime?.subagentRole || '').trim().toLowerCase()
  if (role === 'project_memory_retriever' || role === 'project_memory_organizer') {
    return []
  }
  if (role !== 'explorer' && role !== 'verification') {
    return Array.isArray(tools) ? tools : []
  }

  const allowedNames =
    role === 'verification'
      ? VERIFICATION_TOOL_NAMES
      : EXPLORER_READ_ONLY_TOOL_NAMES

  return (Array.isArray(tools) ? tools : []).filter(tool => {
    if (!tool?.name || tool.approvalCategory) {
      return role === 'verification' && allowedNames.has(tool?.name)
    }
    if (tool.source && tool.source !== 'builtin') {
      return false
    }
    return allowedNames.has(tool.name)
  })
}

function isCompletionStateIncompleteForExecution(result = {}, routeState = {}, taskFrame = {}) {
  if (
    result?.completionState === 'failed_after_execution' ||
    result?.completionState === 'blocked_by_capability' ||
    result?.completionState === 'blocked_by_approval'
  ) {
    return true
  }

  return false
}

function completeCurrentTaskWithResult(taskTracker, currentTaskId, routeState, result) {
  if (isCompletionStateIncompleteForExecution(result, routeState)) {
    taskTracker.completeTask(
      currentTaskId,
      result?.deliveryPolicy?.deliveryNote || '执行未完成，未标记为完成',
      'failed',
    )
    return
  }
  taskTracker.completeTask(currentTaskId, '生成最终回答')
}

function buildRouteDecisionSnapshot({
  routeState,
  selectedCapabilities,
  selectedTools,
  contextEstimate,
  promptBlocks,
  promptBlockDiff,
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
    contextEstimate,
    promptBlocks: Array.isArray(promptBlocks) ? promptBlocks : undefined,
    promptBlockDiff: promptBlockDiff || undefined,
  }
}

function findLatestPromptBlockSnapshot(messages = []) {
  const candidates = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (Array.isArray(message?.routeDecision?.promptBlocks)) {
      candidates.push(message.routeDecision.promptBlocks)
    }
    for (const variant of Array.isArray(message?.versions) ? message.versions : []) {
      if (Array.isArray(variant?.routeDecision?.promptBlocks)) {
        candidates.push(variant.routeDecision.promptBlocks)
      }
    }
  }
  const latest = candidates.at(-1)
  if (!Array.isArray(latest)) {
    return []
  }
  return latest
    .filter(block =>
      block &&
      typeof block.id === 'string' &&
      typeof block.hash === 'string',
    )
    .map(block => ({
      id: block.id,
      role: typeof block.role === 'string' ? block.role : undefined,
      kind: typeof block.kind === 'string' ? block.kind : undefined,
      hash: block.hash,
      stable: block.stable === true,
    }))
}

function estimateMountedToolSchemaTokens(tools = [], settings = {}) {
  const toolDefs = (Array.isArray(tools) ? tools : []).map(tool => ({
    type: 'function',
    function: {
      name: tool?.name || '',
      description: tool?.description || '',
      parameters:
        tool?.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : {},
    },
  }))

  return estimateTextTokens(JSON.stringify(toolDefs), settings)
}

function buildPromptContextSnapshot(
  settings,
  systemPrompt,
  tools,
  conversationTokens = 0,
  toolSchemaTokensOverride,
) {
  const toolSchemaTokens =
    typeof toolSchemaTokensOverride === 'number' && Number.isFinite(toolSchemaTokensOverride)
      ? Math.max(0, Math.round(toolSchemaTokensOverride))
      : estimateMountedToolSchemaTokens(tools, settings)
  const budget = buildContextCompressionBudget(settings, {
    systemPrompt,
    toolSchemaTokens,
  })
  const normalizedConversationTokens = Math.max(
    0,
    Math.round(Number(conversationTokens) || 0),
  )
  const promptEnvelopeTokens = budget.systemPromptTokens + toolSchemaTokens

  return {
    systemPromptTokens: budget.systemPromptTokens,
    toolSchemaTokens,
    promptEnvelopeTokens,
    conversationTokens: normalizedConversationTokens,
    promptTokens: promptEnvelopeTokens + normalizedConversationTokens,
    contextWindowTokens: budget.contextWindowTokens,
    configuredContextWindowTokens: budget.configuredContextWindowTokens,
    windowSource: budget.windowSource,
    compressionThresholdTokens: budget.compressionThresholdTokens,
    effectiveThresholdTokens: budget.effectiveThresholdTokens,
  }
}

function normalizeUsage(usage) {
  const inputTokens = Math.max(0, Math.round(Number(usage?.inputTokens) || 0))
  const outputTokens = Math.max(0, Math.round(Number(usage?.outputTokens) || 0))
  const cachedInputTokens = Math.max(
    0,
    Math.round(Number(usage?.cachedInputTokens) || 0),
  )
  if (inputTokens <= 0 && outputTokens <= 0) {
    return undefined
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    estimatedInputTokens: Math.max(
      0,
      Math.round(Number(usage?.estimatedInputTokens) || 0),
    ),
    contextWindow: Math.max(0, Math.round(Number(usage?.contextWindow) || 0)),
  }
}

function createUsageTrackingHooks(baseHooks = {}) {
  let totals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  }
  let latest = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  }
  let latestContext = {
    inputTokens: 0,
    outputTokens: 0,
  }
  let latestContextWindow = 0
  let latestContextCompression

  function publishUsage() {
    const latestActiveTokens = latest.inputTokens + latest.outputTokens
    const activeInputTokens = latestContext.inputTokens || latestActiveTokens
    baseHooks?.onUsage?.({
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      latestInputTokens: activeInputTokens,
      latestOutputTokens: latest.outputTokens,
      latestCachedInputTokens: latest.cachedInputTokens,
      contextWindow: latestContextWindow || undefined,
    })
  }

  return {
    hooks: {
      ...baseHooks,
      onContextCompression(contextCompression) {
        if (contextCompression) {
          latestContextCompression = contextCompression
        }
        baseHooks?.onContextCompression?.(contextCompression)
      },
      onUsage(usage) {
        const normalized = normalizeUsage(usage)
        if (!normalized) {
          return
        }
        latest = {
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
          cachedInputTokens: normalized.cachedInputTokens,
        }
        if (normalized.estimatedInputTokens > 0 || latestContext.inputTokens <= 0) {
          const latestActiveTokens = latest.inputTokens + latest.outputTokens
          latestContext = {
            inputTokens: Math.max(latestContext.inputTokens, latestActiveTokens),
            outputTokens: latest.outputTokens,
          }
        }
        if (normalized.contextWindow > 0) {
          latestContextWindow = normalized.contextWindow
        }
        totals = {
          inputTokens: totals.inputTokens + normalized.inputTokens,
          outputTokens: totals.outputTokens + normalized.outputTokens,
          cachedInputTokens: totals.cachedInputTokens + normalized.cachedInputTokens,
        }
        publishUsage()
      },
      onActiveContextEstimate(estimate = {}) {
        const latestInputTokens = Math.max(
          0,
          Math.round(Number(estimate.latestInputTokens || estimate.inputTokens) || 0),
        )
        if (latestInputTokens > 0) {
          const allowDecrease = estimate.allowDecrease === true
          latestContext = {
            inputTokens: allowDecrease
              ? latestInputTokens
              : Math.max(latestContext.inputTokens, latestInputTokens),
            outputTokens: 0,
          }
        }
        const contextWindow = Math.max(
          0,
          Math.round(Number(estimate.contextWindow) || 0),
        )
        if (contextWindow > 0) {
          latestContextWindow = contextWindow
        }
        publishUsage()
        baseHooks?.onActiveContextEstimate?.(estimate)
      },
    },
    getAccumulatedUsage() {
      const normalizedTotals = normalizeUsage(totals)
      if (!normalizedTotals) {
        return undefined
      }
      const latestInputTokens = Math.max(
        0,
        Math.round(
          Number(
            latestContext.inputTokens ||
              latest.inputTokens + latest.outputTokens,
          ) || 0,
        ),
      )
      return {
        ...normalizedTotals,
        cachedInputTokens: totals.cachedInputTokens,
        latestInputTokens,
        latestOutputTokens: Math.max(0, Math.round(Number(latest.outputTokens) || 0)),
        latestCachedInputTokens: Math.max(
          0,
          Math.round(Number(latest.cachedInputTokens) || 0),
        ),
        contextWindow: latestContextWindow || undefined,
      }
    },
    getLatestContextCompression() {
      return latestContextCompression
    },
    getLatestActiveInputTokens() {
      return Math.max(
        0,
        Math.round(
          Number(
            latestContext.inputTokens ||
              latest.inputTokens + latest.outputTokens,
          ) || 0,
        ),
      )
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
      'Request a runtime capability upgrade when the current mounted tool set is genuinely insufficient for the user goal.',
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
    hasMultiAgentTools:
      names.has('spawn_agent'),
    hasProjectMemoryTools:
      names.has('spawn_memory_agent') || names.has('update_project_memory'),
  }
}

function summarizeMessages(messages) {
  const latestUser =
    [...messages].reverse().find(message => message.role === 'user')?.content || 'Agent task'
  return latestUser.length > 80 ? `${latestUser.slice(0, 80)}...` : latestUser
}

function summarizeReasoning(messages, toolEvents, finalMessage, hooks = {}) {
  const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')
  const latestUserContent = String(latestUserMessage?.content || '')
  const currentSubtask =
    latestUserContent.match(/当前子任务[:：]\s*([^\n]+)/)?.[1]?.trim() ||
    latestUserContent.match(/Current subtask[:：]\s*([^\n]+)/i)?.[1]?.trim()
  const userIntent = (currentSubtask || latestUserContent)
    .replace(/\s+/g, ' ')
    .trim() || '处理当前任务'
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
      id:
        typeof hooks.createExecutionStepId === 'function'
          ? hooks.createExecutionStepId('reasoning', 'summary')
          : 'summary',
      kind: 'summary',
      content: lines.join('\n'),
      order:
        typeof hooks.nextTimelineOrder === 'function'
          ? hooks.nextTimelineOrder(1)
          : undefined,
      createdAt: Date.now(),
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
    ? stripInlineToolCallText(normalized.errorInfo.partialMessage).trim()
    : ''
}

function extractPartialProviderReasoning(normalized) {
  return typeof normalized?.errorInfo?.partialReasoning === 'string'
    ? normalized.errorInfo.partialReasoning.trim()
    : ''
}

function extractPartialProviderToolCalls(normalized) {
  const entries = normalized?.errorInfo?.partialToolCalls
  if (!Array.isArray(entries)) {
    return []
  }
  return entries
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => ({
      id: typeof entry.id === 'string' ? entry.id : undefined,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      path: typeof entry.path === 'string' ? entry.path : undefined,
      artifactHint: typeof entry.artifactHint === 'string' ? entry.artifactHint : undefined,
      argumentsChars: Number.isFinite(Number(entry.argumentsChars))
        ? Math.max(0, Math.round(Number(entry.argumentsChars)))
        : undefined,
      contentChars: Number.isFinite(Number(entry.contentChars))
        ? Math.max(0, Math.round(Number(entry.contentChars)))
        : undefined,
      completeJson: entry.completeJson === true,
      argumentsPreview: typeof entry.argumentsPreview === 'string'
        ? entry.argumentsPreview.slice(0, 900)
        : undefined,
    }))
    .slice(0, 8)
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

function markRecoveredRetryInfo(...entries) {
  const merged = mergeProviderRetryInfo(...entries) || {}
  return {
    ...merged,
    attemptedRetries:
      typeof merged.attemptedRetries === 'number' && merged.attemptedRetries > 0
        ? merged.attemptedRetries
        : 1,
    configuredMaxAttempts:
      typeof merged.configuredMaxAttempts === 'number' && merged.configuredMaxAttempts > 0
        ? merged.configuredMaxAttempts
        : 1,
    stage: merged.stage || 'recovery',
    recovered: true,
  }
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

function looksLikeProceduralDraft(value) {
  const normalized = normalizeFinalAnswer(value)
  if (!normalized) {
    return false
  }
  return /(?:我(?:需要|会|将|先|再|正在|准备)|让我|接下来|下一步|先(?:读取|检查|提取|解析|确认|执行)|需要先|将使用|准备使用|I\s+(?:need|will|am going)|Let me|Next,?\s+I)/iu.test(
    normalized,
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

  if (finalMessage.length < 140 && looksLikeProceduralDraft(finalMessage)) {
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
    result = sanitizeResultMessage(result, recentToolEvents)

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
    result = sanitizeResultMessage(result, recentToolEvents)

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

const DEFAULT_AGENT_CHECKPOINT_TOOLS = new Set([
  'apply_patch',
  'edit_file',
  'multi_edit_file',
  'replace_line_range',
  'verify_artifact',
  'write_file',
])

function parseCheckpointOutput(output) {
  if (!output) {
    return null
  }
  if (typeof output === 'object') {
    return output
  }
  try {
    return JSON.parse(String(output))
  } catch {
    return null
  }
}

function compactCheckpointToolEvent(event = {}) {
  return {
    id: event.id,
    toolCallId: event.toolCallId,
    name: event.name,
    source: event.source,
    status: event.status,
    summary: summarizeToolOutput(event.summary || event.error || event.output, 500),
    input: summarizeToolOutput(event.input, 500),
    riskLevel: event.riskLevel,
    permissionScope: event.permissionScope,
    approvalCategory: event.approvalCategory,
    errorInfo: event.errorInfo
      ? {
          code: event.errorInfo.code,
          category: event.errorInfo.category,
          retryable: event.errorInfo.retryable,
        }
      : undefined,
    structuredOutput: event.structuredOutput
      ? {
          operation: event.structuredOutput.operation,
          summary: summarizeToolOutput(event.structuredOutput.summary, 500),
          path: event.structuredOutput.path,
          files: Array.isArray(event.structuredOutput.files)
            ? event.structuredOutput.files.slice(0, 12).map(file => ({
                path: file?.path || file?.relativePath,
                operation: file?.operation || file?.kind,
              }))
            : undefined,
        }
      : undefined,
  }
}

function summarizeRuntimeArtifacts(context = {}) {
  const artifacts = Array.isArray(context.artifactStore?.artifacts)
    ? context.artifactStore.artifacts
    : []
  return artifacts.slice(-20).map(artifact => ({
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    chunkCount: Array.isArray(artifact.chunks) ? artifact.chunks.length : 0,
    itemCount: Array.isArray(artifact.chunks)
      ? artifact.chunks.reduce(
          (total, chunk) => total + Math.max(0, Math.round(Number(chunk?.itemCount) || 0)),
          0,
        )
      : 0,
    metadata: artifact.metadata
      ? {
          toolName: artifact.metadata.toolName,
          stage: artifact.metadata.stage,
          tokenEstimate: artifact.metadata.tokenEstimate,
          charCount: artifact.metadata.charCount,
        }
      : undefined,
    updatedAt: artifact.updatedAt,
  }))
}

function extractCheckpointArtifactsFromEvent(event = {}) {
  const parsed = parseCheckpointOutput(event.output)
  const candidates = [
    parsed?.artifact,
    parsed?.appendedChunk?.artifact,
    parsed?.checkpoint?.artifact,
    ...(Array.isArray(parsed?.artifacts) ? parsed.artifacts : []),
  ].filter(Boolean)

  return candidates
    .map(artifact => {
      if (typeof artifact === 'string') {
        return { id: artifact }
      }
      if (!artifact || typeof artifact !== 'object' || !artifact.id) {
        return null
      }
      return {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        chunkCount: artifact.chunkCount,
      }
    })
    .filter(Boolean)
}

function extractCheckpointFilesFromEvent(event = {}) {
  const files = []
  const parsed = parseCheckpointOutput(event.output)
  const structured = event.structuredOutput

  for (const value of [
    parsed?.path,
    parsed?.filePath,
    parsed?.outputPath,
    structured?.path,
    structured?.filePath,
    structured?.outputPath,
  ]) {
    if (typeof value === 'string' && value.trim()) {
      files.push(value.trim())
    }
  }

  for (const source of [parsed?.files, parsed?.paths, structured?.files, structured?.paths]) {
    if (!Array.isArray(source)) continue
    for (const item of source) {
      const value =
        typeof item === 'string'
          ? item
          : item?.path || item?.relativePath || item?.filePath || item?.outputPath
      if (typeof value === 'string' && value.trim()) {
        files.push(value.trim())
      }
    }
  }

  return [...new Set(files)].slice(0, 20)
}

function checkpointReasonForToolEvent(event = {}) {
  if (event.status !== 'success') {
    return ''
  }
  const name = String(event.name || '')
  if (DEFAULT_AGENT_CHECKPOINT_TOOLS.has(name)) {
    return name === 'verify_artifact'
      ? 'verification_passed'
      : name.includes('artifact')
        ? 'artifact_updated'
        : 'durable_tool_completed'
  }
  if (/(convert|export|generate|render|build|write|verify|artifact)/iu.test(name)) {
    return 'durable_tool_completed'
  }
  const summary = `${event.summary || ''} ${summarizeToolOutput(event.output, 1000)}`
  return /(generated|created|converted|exported|verified|wrote|saved as artifact)/iu.test(summary)
    ? 'durable_tool_completed'
    : ''
}

function collectDefaultAgentCheckpointTriggers({
  context,
  toolEvents = [],
  startIndex = 0,
} = {}) {
  const triggers = []
  const hints = Array.isArray(context?.checkpointHints)
    ? context.checkpointHints.splice(0)
    : []

  for (const hint of hints) {
    if (!hint?.recommended) continue
    triggers.push({
      reason: hint.reason || 'runtime_checkpoint_hint',
      stage: hint.stage,
      toolName: hint.toolName,
      toolCallId: hint.toolCallId,
      artifacts: Array.isArray(hint.artifacts) ? hint.artifacts : [],
      files: Array.isArray(hint.files) ? hint.files : [],
      nextAction: hint.nextAction,
      tokenEstimate: hint.tokenEstimate,
      charCount: hint.charCount,
    })
  }

  for (const event of toolEvents.slice(startIndex)) {
    const reason = checkpointReasonForToolEvent(event)
    if (!reason) continue
    triggers.push({
      reason,
      toolEventId: event.id,
      toolName: event.name,
      artifacts: extractCheckpointArtifactsFromEvent(event),
      files: extractCheckpointFilesFromEvent(event),
      summary: summarizeToolOutput(event.summary || event.output, 500),
    })
  }

  return triggers
}

function compactCheckpointTrigger(trigger = {}) {
  return {
    reason: trigger.reason,
    stage: trigger.stage,
    toolName: trigger.toolName,
    toolEventId: trigger.toolEventId,
    artifacts: Array.isArray(trigger.artifacts)
      ? trigger.artifacts.slice(0, 8).map(artifact => ({
          id: artifact?.id,
          type: artifact?.type,
          title: artifact?.title,
          chunkCount: artifact?.chunkCount,
        }))
      : [],
    files: Array.isArray(trigger.files) ? trigger.files.slice(0, 12) : [],
    summary: summarizeToolOutput(trigger.summary, 500),
    nextAction: trigger.nextAction,
    tokenEstimate: trigger.tokenEstimate,
    charCount: trigger.charCount,
  }
}

function recordPhaseHandoffMemory(context, triggers = [], reason = 'phase_handoff') {
  if (!context || !Array.isArray(triggers) || triggers.length === 0) {
    return null
  }
  const compactTriggers = triggers.map(compactCheckpointTrigger)
  const artifacts = compactTriggers.flatMap(trigger => trigger.artifacts || [])
  const files = [...new Set(compactTriggers.flatMap(trigger => trigger.files || []))]
  const stage =
    compactTriggers.find(trigger => trigger.stage)?.stage ||
    compactTriggers.find(trigger => trigger.reason)?.reason ||
    reason
  const toolNames = [...new Set(compactTriggers.map(trigger => trigger.toolName).filter(Boolean))]
  const summary = [
    `Phase handoff recorded for ${stage}.`,
    toolNames.length > 0 ? `Tools: ${toolNames.slice(0, 6).join(', ')}.` : '',
    artifacts.length > 0 ? `Artifacts: ${artifacts.map(artifact => artifact.id).filter(Boolean).slice(0, 6).join(', ')}.` : '',
    files.length > 0 ? `Files: ${files.slice(0, 6).join(', ')}.` : '',
    'Continue from these compact references instead of replaying older detailed tool output.',
  ].filter(Boolean).join(' ')
  const logContext = context.logContext || {}
  const memory = {
    id: `work-memory-${logContext.sessionId || 'session'}-${logContext.taskId || 'task'}-phase-${Date.now().toString(36)}`,
    sessionId: logContext.sessionId,
    taskId: logContext.taskId,
    assistantMessageId: logContext.assistantMessageId,
    kind: 'phase_handoff',
    title: `Phase handoff: ${stage}`,
    summary,
    status: 'draft',
    content: {
      reason,
      stage,
      artifacts,
      files,
      triggers: compactTriggers,
    },
    sourceRefs: [
      ...artifacts.map(artifact => ({ artifactId: artifact.id, type: artifact.type })).filter(ref => ref.artifactId),
      ...files.map(file => ({ path: file })),
    ].slice(0, 12),
    nextUse:
      'Use this compact phase handoff for the next step. Read artifact slices or files only when exact content is needed.',
  }
  context.workMemories = upsertWorkMemory(context.workMemories || [], memory)
  return memory
}

function isProviderStreamStallError(normalized = {}, retryInfo = {}) {
  const values = [
    normalized.code,
    normalized.errorInfo?.code,
    normalized.message,
    normalized.rawMessage,
    retryInfo?.lastErrorSummary,
  ]
    .filter(value => typeof value === 'string')
    .join('\n')
  return (
    values.includes('PROVIDER_STREAM_STALLED') ||
    values.includes('模型服务流式输出长时间没有继续') ||
    values.includes('Streaming response stalled')
  )
}

function buildCheckpointContinuationPrompt({
  checkpoint,
  context,
  toolEvents = [],
  partialMessage = '',
  partialReasoning = '',
  partialToolCalls = [],
  error,
} = {}) {
  const checkpointSummary = checkpoint
    ? {
        id: checkpoint.id,
        stepId: checkpoint.stepId,
        metadata: checkpoint.metadata,
        createdAt: checkpoint.createdAt,
      }
    : null
  const artifacts = summarizeRuntimeArtifacts(context)
  const recentTools = toolEvents.slice(-8).map(compactCheckpointToolEvent)
  const partialToolCallSummaries = Array.isArray(partialToolCalls)
    ? partialToolCalls.slice(0, 8)
    : []
  const stalledDuringMutationTool = partialToolCallSummaries.some(entry =>
    ['write_file', 'apply_patch', 'edit_file', 'multi_edit_file', 'replace_line_range']
      .includes(String(entry?.name || '')),
  )
  const workMemories = Array.isArray(context?.workMemories)
    ? context.workMemories.slice(-8).map(memory => ({
        id: memory?.id,
        kind: memory?.kind,
        title: memory?.title,
        summary: summarizeToolOutput(memory?.summary || memory?.content, 700),
        status: memory?.status,
        nextUse: memory?.nextUse,
      }))
    : []

  return [
    '上一次模型流式输出在长时间无新 chunk 后中断。不要从头开始，基于最近 checkpoint 和已完成成果继续。',
    '',
    '恢复规则：',
    '- 先复用已完成工具结果、runtime artifacts、已写文件和 work memory。',
    '- 不要重新执行已经成功且仍可复用的转换、生成、导出或验证步骤。',
    '- 如果需要精确的大输出内容，优先调用 read_artifact_slice 读取必要片段。',
    '- 继续执行下一个最小可观察步骤；如果用户要求文件/代码产物，优先调用写入、编辑或验证工具，不要只更新 todo 或继续解释计划。',
    stalledDuringMutationTool
      ? '- 注意：上次中断时模型已经开始生成写入工具调用但没有闭合执行。不要重试一次性生成完整大文件参数；这次先调用 write_file 写一个小而可检查的骨架，然后用 apply_patch/edit_file 分块补全。'
      : null,
    '- 如果成果已经足够，整理最终回答；否则不要用普通文字假装完成。',
    '',
    checkpointSummary ? `最近 checkpoint:\n${JSON.stringify(checkpointSummary, null, 2)}` : null,
    artifacts.length > 0 ? `可复用 artifacts:\n${JSON.stringify(artifacts, null, 2)}` : null,
    recentTools.length > 0 ? `最近工具结果摘要:\n${JSON.stringify(recentTools, null, 2)}` : null,
    workMemories.length > 0 ? `可复用 work memory:\n${JSON.stringify(workMemories, null, 2)}` : null,
    partialToolCallSummaries.length > 0
      ? `中断前已开始但未完成执行的工具调用摘要:\n${JSON.stringify(partialToolCallSummaries, null, 2)}`
      : null,
    partialMessage.trim()
      ? `中断前模型已写出的草稿片段:\n${partialMessage.slice(0, 4000)}`
      : null,
    partialReasoning.trim()
      ? `中断前 provider reasoning 摘要片段:\n${partialReasoning.slice(0, 1800)}`
      : null,
    error?.message ? `中断原因: ${error.message}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildCheckpointContinuationMessages({
  messages = [],
  checkpoint,
  context,
  toolEvents,
  partialMessage,
  partialReasoning,
  partialToolCalls,
  error,
} = {}) {
  const nextMessages = [...messages]
  const cleanedPartial = stripInlineToolCallText(partialMessage || '').trim()
  if (cleanedPartial) {
    nextMessages.push({
      role: 'assistant',
      content: cleanedPartial.slice(0, 6000),
    })
  }
  nextMessages.push({
    role: 'user',
    content: buildCheckpointContinuationPrompt({
      checkpoint,
      context,
      toolEvents,
      partialMessage: cleanedPartial,
      partialReasoning,
      partialToolCalls,
      error,
    }),
  })
  return nextMessages
}

export const __testInternals = {
  buildCheckpointContinuationMessages,
}

function buildToolCallOnlyFallbackMessage(toolEvents) {
  const recentSuccessful = toolEvents
    .filter(event => event.status === 'success')
    .slice(-3)
    .map((event, index) => {
      const summary = summarizeToolOutput(event.output) || event.summary || event.name
      return `${index + 1}. ${event.name}: ${summary}`
    })
    .join('\n')

  return [
    '模型输出了工具调用标记，系统已经将它转换为实际工具执行，但模型没有继续返回可展示的最终结论。',
    recentSuccessful
      ? `已完成的步骤：\n${recentSuccessful}`
      : '本轮还没有拿到足够的工具结果来整理完整结论。',
    '我没有把这一步标记为完成；需要继续执行后才能给出可靠结果。',
  ].join('\n\n')
}

function detectProtocolLeak(message) {
  const value = String(message || '')
  const hasToolCall = /<tool_call>|<\|tool_calls_section_begin\|>/iu.test(value)
  const hasToolResult = /<tool_result>/iu.test(value)
  if (!hasToolCall && !hasToolResult) {
    return null
  }
  return {
    hasToolCall,
    hasToolResult,
    originalMessageLength: value.length,
  }
}

function sanitizeResultMessage(result, toolEvents = []) {
  const originalMessage = typeof result?.message === 'string' ? result.message : ''
  const protocolLeak = detectProtocolLeak(originalMessage)
  const strippedMessage = stripInlineToolCallText(originalMessage).trim()
  if (strippedMessage) {
    return strippedMessage === originalMessage
      ? result
      : { ...result, message: strippedMessage, protocolLeak }
  }
  if (originalMessage.trim() && originalMessage !== strippedMessage) {
    return {
      ...result,
      message: buildToolCallOnlyFallbackMessage(toolEvents),
      protocolLeak,
    }
  }
  return result
}

function buildPartialRecoveryMessage(toolEvents, normalized, partialMessage = '') {
  const displayPartialMessage = stripInlineToolCallText(partialMessage).trim()
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
    displayPartialMessage ? `模型中断前已经写出的内容：\n${displayPartialMessage.slice(0, 6000)}` : null,
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
    id:
      typeof hooks?.createExecutionStepId === 'function'
        ? hooks.createExecutionStepId('task', 'main')
        : createId('main'),
    title: rootTitle,
    summary: '',
    kind: 'main',
    status: 'running',
    children: [],
    errors: [],
    retryAttempts: 0,
    checkpoint: null,
  }

  function sanitizeTaskIdPart(value, fallback = 'step') {
    const normalized = String(value || fallback)
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return (normalized || fallback).slice(0, 96)
  }

  function todoStatusToTaskStatus(status) {
    switch (status) {
      case 'in_progress':
        return 'running'
      case 'completed':
        return 'completed'
      case 'failed':
        return 'failed'
      case 'blocked':
        return 'blocked'
      default:
        return 'queued'
    }
  }

  function todoNodeId(todo, index, parentId = root.id) {
    return `${parentId}-todo-${sanitizeTaskIdPart(todo?.id || index + 1)}`
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

  function markInterruptedDescendants(node, summary, status) {
    if (!node?.children?.length) {
      return 0
    }
    let changed = 0
    for (const child of node.children) {
      if (
        ['queued', 'running', 'awaiting_approval', 'awaiting_user_input'].includes(
          child.status,
        )
      ) {
        child.status = status
        child.summary = summary || child.summary
        if (!child.errors) child.errors = []
        child.errors.push({
          timestamp: Date.now(),
          message: summary || 'Task interrupted before completion.',
          code: 'TASK_INTERRUPTED',
        })
        changed += 1
      }
      changed += markInterruptedDescendants(child, summary, status)
    }
    return changed
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
    recordError(id, errorInfo) {
      const node = findNode(root, id)
      if (!node) return
      if (!node.errors) node.errors = []
      node.errors.push({
        timestamp: Date.now(),
        ...errorInfo,
      })
      emit()
    },
    recordRetry(id) {
      const node = findNode(root, id)
      if (!node) return
      node.retryAttempts = (node.retryAttempts || 0) + 1
      emit()
    },
    getErrorChain(id) {
      const node = findNode(root, id)
      return node?.errors || []
    },
    saveCheckpoint(id, context) {
      const node = findNode(root, id)
      if (!node) return
      node.checkpoint = {
        timestamp: Date.now(),
        contextSnapshot: clone(context),
      }
      emit()
    },
    getCheckpoint(id) {
      const node = findNode(root, id)
      return node?.checkpoint || null
    },
    clearCheckpoint(id) {
      const node = findNode(root, id)
      if (!node) return
      node.checkpoint = null
      emit()
    },
    createChildTask({ parentId, title, summary }) {
      const parent = findNode(root, parentId || root.id)
      if (!parent) {
        return null
      }
      const child = {
        id:
          typeof hooks?.createExecutionStepId === 'function'
            ? hooks.createExecutionStepId('task', title || 'subagent')
            : createId('subagent'),
        title: title || 'Subagent task',
        summary: summary || '',
        kind: 'subagent',
        status: 'running',
        children: [],
        errors: [],
        retryAttempts: 0,
        checkpoint: null,
      }
      parent.children.push(child)
      emit()
      return child
    },
    syncTodoItems(items = [], explanation = '', parentId = root.id) {
      const parent = findNode(root, parentId) || root
      const previousById = new Map(parent.children.map(child => [child.id, child]))
      const visibleItems = Array.isArray(items)
        ? items
        : []
      parent.children = visibleItems.map((item, index) => {
        const id = todoNodeId(item, index, parent.id)
        const previous = previousById.get(id)
        const step = item.step || item.content
        const activeTitle =
          item.status === 'in_progress' && item.activeForm
            ? item.activeForm
            : step
        return {
          ...(previous || {}),
          id,
          title: compactVisibleTaskTitle(activeTitle, `步骤 ${index + 1}`),
          summary: explanation || previous?.summary || '',
          kind: 'execute',
          status: todoStatusToTaskStatus(item.status),
          children: [],
          errors: previous?.errors || [],
          retryAttempts: previous?.retryAttempts || 0,
          checkpoint: previous?.checkpoint || null,
          todoId: item.id,
          activeForm: item.activeForm || undefined,
          planExplanation: explanation || undefined,
        }
      })
      emit()
    },
    getActivePlanStep() {
      const node =
        root.children.find(child =>
          ['running', 'awaiting_approval', 'awaiting_user_input'].includes(child.status),
        ) ||
        root.children.find(child => ['failed', 'blocked'].includes(child.status)) ||
        root.children.find(child => child.status === 'queued') ||
        root.children[root.children.length - 1]
      if (!node) {
        return null
      }
      return {
        planId: root.id,
        subtaskId: node.id,
        subtaskTitle: node.title,
      }
    },
    completeTask(id, summary, status = 'completed', nestedChildren = []) {
      const node = findNode(root, id)
      if (!node) return
      node.status = status
      if (summary) {
        node.summary = summary
      }
      emit()
    },
    interruptRunningDescendants(id, summary, status = 'failed') {
      const node = findNode(root, id || root.id)
      if (!node) return 0
      const changed = markInterruptedDescendants(node, summary, status)
      if (changed > 0) {
        emit()
      }
      return changed
    },
    failRoot(message, errorInfo = {}) {
      root.status = 'failed'
      root.summary = message
      root.errors.push({
        timestamp: Date.now(),
        ...errorInfo,
      })
      emit()
    },
    completeRoot(message) {
      root.status = 'completed'
      root.summary = message
      emit()
    },
  }
}

export async function runDefaultAgent(request) {
  const {
    settings,
    messages: requestedMessages,
    runtime = {},
    hooks: incomingHooks = {},
    capabilities,
    carryoverContext = '',
  } = request
  const executionStepIds =
    runtime.executionStepIds || createExecutionStepIdFactory(request.logContext || {})
  const timelineOrderCursor =
    runtime.timelineOrderCursor && typeof runtime.timelineOrderCursor === 'object'
      ? runtime.timelineOrderCursor
      : { value: 0 }
  const baseHooks = {
    ...incomingHooks,
    executionMessageId: executionStepIds.messageId,
    createExecutionStepId(type, hint) {
      return executionStepIds.next(type, hint)
    },
    nextTimelineOrder(span = 1) {
      const currentOrder =
        typeof timelineOrderCursor.value === 'number' && Number.isFinite(timelineOrderCursor.value)
          ? timelineOrderCursor.value
          : 0
      const increment = Math.max(1, Math.round(Number(span) || 1))
      timelineOrderCursor.value = currentOrder + increment
      return currentOrder
    },
  }
  const {
    hooks,
    getAccumulatedUsage,
    getLatestContextCompression,
    getLatestActiveInputTokens,
  } = createUsageTrackingHooks(baseHooks)
  let messages = Array.isArray(requestedMessages) ? requestedMessages : []
  hooks?.onPhaseChange?.('preparing')
  if (settings?.provider !== 'custom' && !settings?.apiKey?.trim()) {
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

  const preflightSystemPrompt = buildPreflightSystemPromptEstimate({
    messages,
    settings,
    carryoverContext,
  })
  const preflightCompression = await maybeCompressMessagesForContext({
    messages,
    settings,
    systemPrompt: preflightSystemPrompt,
    latestInputTokens: getLatestActiveInputTokens(),
    hooks,
    stage: 'preflight',
  })
  messages = preflightCompression.messages
  const runNestedAgent = nestedRequest =>
    runAgent({
      ...nestedRequest,
      hooks: nestedRequest?.hooks || hooks,
    })

  const toolEvents = []
  const context = {
    cwd: settings.cwd,
    appRoot,
    appControl: hooks.appControl,
    toolEvents,
    logContext: request.logContext || {},
    activeCapabilityIds: {
      skills: new Set((capabilities?.skills || []).map(entry => entry?.id || entry).filter(Boolean)),
      plugins: new Set((capabilities?.plugins || []).map(entry => entry?.id || entry).filter(Boolean)),
      mcp: new Set((capabilities?.mcpServers || []).map(entry => entry?.id || entry).filter(Boolean)),
    },
    sessionCapabilityOverrides: {
      skills: {},
      plugins: {},
      mcp: {},
    },
    todoState: runtime.todoState || { items: [] },
    workMemories: runtime.workMemories || [],
    autoToolEvidence: normalizePersistedToolEvidence(runtime.persistedWorkMemories),
    settings,
    getMessages() {
      return messages
    },
    cleanupHandlers: [],
  }
  context.projectMemoryHooks = hooks
  context.projectMemoryRuntime = isProjectMemoryEnabled(settings)
    ? createProjectMemoryRuntime({
        settings,
        messages,
        hooks,
        runNestedAgent,
        scopeId: request.logContext?.sessionId,
      })
    : null
  async function drainProjectMemoryAsyncContext() {
    return context.projectMemoryRuntime?.drainReadyContext?.() || ''
  }
  const taskTracker =
    runtime.taskTracker || createTaskTracker(hooks, summarizeMessages(messages))
  const currentTaskId = runtime.currentTaskId || taskTracker.rootId
  taskTracker.setStatus(currentTaskId, 'running')
  const initialRouteState = createDefaultAgentRouteState(settings)
  const shouldLoadCapabilityLayers = shouldLoadRuntimeCapabilityLayers(initialRouteState)

  const builtinTools = createBuiltinTools(context)
  const advancedTools = createAdvancedTools({
    appRoot,
    settings,
    context,
    runtimeMeta: {
      ...runtime,
      executionStepIds,
    },
    runNestedAgent,
    taskTracker,
  })
  const [skillCatalog, pluginInventory, mcpInventory] = await Promise.all([
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
  hooks?.onToolCatalogEvent?.({
    totalToolCount: toolRegistry.entries.length,
    directToolCount: toolRegistry.directEntries.length,
    deferredToolCount: toolRegistry.deferredEntries.length,
    discoverableToolCount: toolRegistry.discoverableEntries.length,
    highRiskToolCount: toolRegistry.catalog?.highRiskCount || 0,
  })
  const taskFrame = resolveTaskFrame({ messages, runtime, settings })
  const normalizedClassification = null
  const strategy = {
    chain: 'default-agent',
    reason: 'model-directed',
  }

  let routeState = initialRouteState
  const visitedTiers = new Set([routeState.capabilityTier])
  const routeNotes = []
  const routeHistory = []
  let routeEscalationCount = 0
  let toolFailureContinuationCount = 0
  let lastSelectedCapabilities = null
  let lastEffectiveRunSettings = settings
  let lastPromptRouteState = routeState
  let lastAllTools = []
  let lastSystemPrompt = ''
  let previousPromptBlocks = findLatestPromptBlockSnapshot(messages)
  let lastRouteDecision = {
    strategyDecision: strategy,
    intentClassification: normalizedClassification || undefined,
    classificationSource: undefined,
    classificationReason: undefined,
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

  const checkpointManager = createCheckpointManager({
    hooks: {
      onCheckpointCreated: (checkpoint) => {
        hooks?.onProgress?.({ type: 'checkpoint', checkpoint })
      },
      onCheckpointCommitted: (checkpoint) => {
        hooks?.onProgress?.({ type: 'checkpoint_committed', checkpoint })
      },
    },
  })
  let checkpointId = null
  let checkpointCount = 0

  function createDefaultAgentCheckpoint(reason, metadata = {}) {
    const snapshot = checkpointManager.createSnapshot({
      messages,
      toolEvents: toolEvents.map(compactCheckpointToolEvent),
      routeState,
      workMemories: context.workMemories,
      taskTree: taskTracker.getTree(),
      runtime: {
        artifacts: summarizeRuntimeArtifacts(context),
        latestContextCompression: getLatestContextCompression(),
        reason,
        triggers: metadata.triggers,
      },
    })
    const checkpoint = checkpointManager.createCheckpoint(
      currentTaskId,
      metadata.stepId || reason,
      snapshot,
      {
        reason,
        checkpointKind: metadata.checkpointKind || 'default_agent_progress',
        pass: metadata.pass,
        phaseHandoffId: metadata.phaseHandoffId,
        triggerCount: Array.isArray(metadata.triggers) ? metadata.triggers.length : undefined,
        triggers: Array.isArray(metadata.triggers) ? metadata.triggers.slice(0, 12) : undefined,
        routeState: { capabilityTier: routeState.capabilityTier },
      },
    )
    checkpointId = checkpoint.id
    checkpointCount += 1
    const activePlanStep = taskTracker.getActivePlanStep?.()
    hooks?.onProgress?.({
      type: 'checkpoint_created',
      checkpointId,
      reason,
      checkpointCount,
      stepId: checkpoint.stepId,
      planId: activePlanStep?.planId,
      subtaskId: activePlanStep?.subtaskId,
      checkpointKind: checkpoint.metadata?.checkpointKind,
      phaseHandoffId: metadata.phaseHandoffId,
      triggerCount: Array.isArray(metadata.triggers) ? metadata.triggers.length : undefined,
    })
    return checkpoint
  }

  function createCheckpointForRecoverableProgress(reason, startIndex, extra = {}) {
    const triggers = collectDefaultAgentCheckpointTriggers({
      context,
      toolEvents,
      startIndex,
    })
    if (triggers.length === 0 && !extra.force) {
      return null
    }
    const phaseHandoff = recordPhaseHandoffMemory(context, triggers, reason)
    return createDefaultAgentCheckpoint(reason, {
      ...extra,
      triggers,
      phaseHandoffId: phaseHandoff?.id,
    })
  }

  try {
    const maxDefaultAgentPasses = MAX_ROUTE_RUNTIME_PASSES
    for (let pass = 0; pass < maxDefaultAgentPasses; pass += 1) {
      const availableEscalations = getRouteEscalationTargets(routeState, {
        visitedTiers,
      })
      const promptRouteState = {
        ...routeState,
        availableEscalations,
      }
      const effectiveRunSettings = buildEffectiveRunSettings(settings, promptRouteState)
      lastEffectiveRunSettings = effectiveRunSettings
      lastPromptRouteState = promptRouteState
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
      const roleFilteredTools = filterToolsForSubagentRole(
        selectedCapabilities.selectedTools,
        runtime,
      )
      const mountedToolAvailability = summarizeMountedToolAvailability(
        roleFilteredTools,
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
      const promptBlockList = buildDefaultAgentPromptBlocks(
        effectiveRunSettings,
        skillPrompt,
        exposureNote,
        promptRouteState,
        mountedToolAvailability,
      )
      const promptBlocks = snapshotPromptBlocks(promptBlockList)
      const promptBlockDiff = diffPromptBlockSnapshots(
        previousPromptBlocks,
        promptBlocks,
      )
      previousPromptBlocks = promptBlocks
      lastSystemPrompt = appendCarryoverContextToPrompt(
        appendRouteNotesToPrompt(
          renderPromptBlocks(promptBlockList),
          routeNotes,
        ),
        carryoverContext,
      )
      const readyProjectMemoryContext =
        context.projectMemoryRuntime?.drainReadyContext?.() || ''
      const promptWithProjectMemory = readyProjectMemoryContext
        ? `${lastSystemPrompt}\n\n${readyProjectMemoryContext}`
        : lastSystemPrompt
      const activeSystemPrompt = appendRuntimeExecutionContextToSystemPrompt(
        promptWithProjectMemory,
        context,
      )
      const allTools = roleFilteredTools
      lastAllTools = allTools
      const toolSchemaTokens = estimateMountedToolSchemaTokens(allTools, effectiveRunSettings)
      const runtimeCompression = await maybeCompressMessagesForContext({
        messages,
        settings: effectiveRunSettings,
        systemPrompt: activeSystemPrompt,
        toolSchemaTokens,
        latestInputTokens: getLatestActiveInputTokens(),
        hooks,
        stage: `pass-${pass + 1}`,
      })
      messages = runtimeCompression.messages
      const promptContextSnapshot = buildPromptContextSnapshot(
        effectiveRunSettings,
        activeSystemPrompt,
        allTools,
        runtimeCompression.afterTokens,
        toolSchemaTokens,
      )
      lastRouteDecision = buildRouteDecisionSnapshot({
        routeState: promptRouteState,
        selectedCapabilities,
        selectedTools: allTools,
        contextEstimate: promptContextSnapshot,
        promptBlocks,
        promptBlockDiff,
        escalationCount: routeEscalationCount,
        availableEscalations,
        tierHistory: [...routeHistory.map(entry => entry.capabilityTier), routeState.capabilityTier],
        classification: normalizedClassification,
        classificationSource: undefined,
        classificationReason: undefined,
        strategy,
      })
      hooks?.onRouteDecision?.(lastRouteDecision)
      const turnToolEventStart = toolEvents.length

      let turnResult
      try {
        turnResult = await runProviderTurn({
          settings: effectiveRunSettings,
          systemPrompt: promptWithProjectMemory,
          messages,
          tools: allTools,
          toolEvents,
          routeState: promptRouteState,
          hooks: {
            ...hooks,
            workMemoryContext: context,
            getActivePlanStep() {
              return taskTracker.getActivePlanStep?.()
            },
            onTodoWrite(items, explanation) {
              taskTracker.syncTodoItems?.(items, explanation, currentTaskId)
            },
            drainAsyncContext: drainProjectMemoryAsyncContext,
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

      createCheckpointForRecoverableProgress('after_recoverable_tool_progress', turnToolEventStart, {
        pass,
      })

      if (context.projectMemoryRuntime?.hasReadyContext?.()) {
        taskTracker.setStatus(
          currentTaskId,
          'running',
          '项目长期记忆已返回，准备合并到下一次模型调用',
        )
        hooks?.onPhaseChange?.('preparing')
        continue
      }

      let result = turnResult.result
      const latestPromptContextSnapshot = buildPromptContextSnapshot(
        effectiveRunSettings,
        appendRuntimeExecutionContextToSystemPrompt(promptWithProjectMemory, context),
        allTools,
        runtimeCompression.afterTokens,
        toolSchemaTokens,
      )
      const capabilityContract = evaluateRuntimeCapabilityContract({
        routeState: promptRouteState,
        selectedTools: allTools,
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

      const toolFailureContinuation = shouldContinueAfterToolFailure({
        result,
        toolEvents,
        routeState: promptRouteState,
        continuationAttempts: toolFailureContinuationCount,
        maxContinuationAttempts: MAX_TOOL_FAILURE_CONTINUATION_ATTEMPTS,
      })
      if (toolFailureContinuation.shouldContinue && !routeStopReason) {
        toolFailureContinuationCount += 1
        routeNotes.push(
          buildToolFailureContinuationNote({
            decision: toolFailureContinuation,
            tools: allTools,
          }),
        )
        taskTracker.setStatus(
          currentTaskId,
          'running',
          '检测到执行型工具失败，继续尝试修复或替代执行路径',
        )
        hooks?.onPhaseChange?.('preparing')
        continue
      }

      routeHistory.push(turnSummary)
      lastRouteDecision = buildRouteDecisionSnapshot({
        routeState: promptRouteState,
        selectedCapabilities,
        selectedTools: allTools,
        contextEstimate: latestPromptContextSnapshot,
        promptBlocks,
        promptBlockDiff,
        escalationCount: routeEscalationCount,
        availableEscalations,
        tierHistory: routeHistory.map(entry => entry.capabilityTier).filter(Boolean),
        classification: normalizedClassification,
        classificationSource: undefined,
        classificationReason: undefined,
        strategy,
        stopReason:
          routeStopReason ||
          (result.completionState === 'executed_verified'
            ? 'completed_with_evidence'
            : 'completed'),
      })
      hooks?.onRouteDecision?.(lastRouteDecision)

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
        hooks,
      )
      hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
        blockId: summaryReasoning[0].id,
        kind: summaryReasoning[0].kind,
        order: summaryReasoning[0].order,
        createdAt: summaryReasoning[0].createdAt,
      })
      const reasoning = [...summaryReasoning, ...(result.reasoning || [])]
      completeCurrentTaskWithResult(
        taskTracker,
        currentTaskId,
        promptRouteState,
        result,
      )
      return {
        ...result,
        usage: getAccumulatedUsage() || result.usage,
        contextCompression: getLatestContextCompression(),
        agentMode: 'default-agent',
        routeDecision: lastRouteDecision,
        capabilitySnapshot: selectedCapabilities.capabilitySnapshot,
        reasoning,
        workMemories: context.workMemories,
        retryInfo: result.retryInfo,
        status: 'completed',
        taskTree: taskTracker.getTree(),
        checkpointId,
        checkpointCount,
      }
    }

    throw createStructuredError('default-agent 执行结束前没有生成最终回答。', {
      source: 'system',
      category: 'execution_failed',
      code: 'ROUTE_RUNTIME_EXHAUSTED',
      detail: 'Default-agent finished without a converged final response.',
      suggestedAction: '请缩小任务范围，或调整任务指令后再试。',
    })
  } catch (error) {
    const normalized = normalizeAgentError(error)
    const partialMessage = extractPartialProviderMessage(normalized)
    const partialReasoning = extractPartialProviderReasoning(normalized)
    const partialToolCalls = extractPartialProviderToolCalls(normalized)
    const retryInfo = extractProviderRetryInfo(normalized)
    const hasRecoveryContext =
      checkpointId ||
      toolEvents.length > 0 ||
      partialMessage.length > 0 ||
      partialReasoning.length > 0 ||
      partialToolCalls.length > 0
    const interruptedSubtaskSummary =
      normalized.source === 'provider'
        ? `父任务被模型流中断：${normalized.message}`
        : `父任务中断：${normalized.message}`
    taskTracker.interruptRunningDescendants?.(
      currentTaskId,
      interruptedSubtaskSummary,
      'failed',
    )

    if (hasRecoveryContext) {
      createCheckpointForRecoverableProgress('interrupted_with_progress', 0, {
        force:
          Boolean(checkpointId) ||
          toolEvents.length > 0 ||
          partialMessage.length > 0 ||
          partialReasoning.length > 0 ||
          partialToolCalls.length > 0,
        errorCode: normalized.code,
        errorSource: normalized.source,
      })
    }

    if (
      normalized.source === 'provider' &&
      hasRecoveryContext &&
      isProviderStreamStallError(normalized, retryInfo)
    ) {
      let resumeErrorForAttempt = normalized
      let resumePartialMessage = partialMessage
      let resumePartialReasoning = partialReasoning
      let resumePartialToolCalls = partialToolCalls
      let resumeRetryInfo = retryInfo
      const maxCheckpointResumeAttempts = 3

      for (let resumeAttempt = 0; resumeAttempt < maxCheckpointResumeAttempts; resumeAttempt += 1) {
        const continuationToolEventStart = toolEvents.length
        try {
          hooks?.onPhaseChange?.('recovering', {
            reason: resumeAttempt === 0
              ? 'provider_stream_stalled_checkpoint_resume'
              : 'provider_stream_stalled_checkpoint_resume_retry',
            checkpointId,
            lastErrorSummary: resumeRetryInfo?.lastErrorSummary || resumeErrorForAttempt.message,
            resumeAttempt: resumeAttempt + 1,
          })
          const checkpoint = checkpointId
            ? checkpointManager.getCheckpoint(checkpointId)
            : checkpointManager.getLatestCheckpointForTask(currentTaskId)
          const continuationMessages = buildCheckpointContinuationMessages({
            messages,
            checkpoint,
            context,
            toolEvents,
            partialMessage: resumePartialMessage,
            partialReasoning: resumePartialReasoning,
            partialToolCalls: resumePartialToolCalls,
            error: resumeErrorForAttempt,
          })
          createDefaultAgentCheckpoint(
            resumeAttempt === 0 ? 'before_checkpoint_resume' : 'before_checkpoint_resume_retry',
            {
              checkpointKind: 'default_agent_checkpoint_resume',
              stepId: `checkpoint-resume-${resumeAttempt + 1}`,
              triggers: [
                {
                  reason: 'provider_stream_stalled',
                  checkpointId: checkpoint?.id || checkpointId,
                  toolEventCount: toolEvents.length,
                  hasPartialMessage: resumePartialMessage.length > 0,
                  hasPartialReasoning: resumePartialReasoning.length > 0,
                  hasPartialToolCalls: resumePartialToolCalls.length > 0,
                  resumeAttempt: resumeAttempt + 1,
                },
              ],
            },
          )
          const resumedTurn = await runProviderTurn({
            settings: lastEffectiveRunSettings,
            systemPrompt: lastSystemPrompt,
            messages: continuationMessages,
            tools: lastAllTools,
            toolEvents,
            routeState: lastPromptRouteState,
            hooks: {
              ...hooks,
              workMemoryContext: context,
              getActivePlanStep() {
                return taskTracker.getActivePlanStep?.()
              },
              onTodoWrite(items, explanation) {
                taskTracker.syncTodoItems?.(items, explanation, currentTaskId)
              },
              drainAsyncContext: drainProjectMemoryAsyncContext,
              rethrowToolError(error) {
                return extractRouteEscalationRequest(error) !== null
              },
            },
            taskTracker,
            currentTaskId,
          })
          createCheckpointForRecoverableProgress('after_checkpoint_resume_progress', continuationToolEventStart, {
            force: toolEvents.length > continuationToolEventStart,
          })
          let resumedResult = enforceEvidencePolicy(
            sanitizeResultMessage(resumedTurn.result, toolEvents),
            toolEvents,
            lastPromptRouteState,
            buildRuntimeBlocks(lastRouteDecision?.stopReason),
          )
          resumedResult = {
            ...resumedResult,
            recovered: true,
          }
          const summaryReasoning = summarizeReasoning(
            resumedTurn.resolvedMessages || continuationMessages,
            toolEvents,
            resumedResult.message,
            hooks,
          )
          hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
            blockId: summaryReasoning[0].id,
            kind: summaryReasoning[0].kind,
            order: summaryReasoning[0].order,
            createdAt: summaryReasoning[0].createdAt,
          })
          completeCurrentTaskWithResult(
            taskTracker,
            currentTaskId,
            lastPromptRouteState,
            resumedResult,
          )
          return {
            ...resumedResult,
            toolEvents,
            agentMode: 'default-agent',
            routeDecision: lastRouteDecision,
            capabilitySnapshot: lastSelectedCapabilities?.capabilitySnapshot,
            reasoning: summaryReasoning,
            workMemories: context.workMemories,
            retryInfo: markRecoveredRetryInfo(resumedTurn.result?.retryInfo, resumeRetryInfo || retryInfo),
            usage: getAccumulatedUsage() || resumedResult.usage,
            contextCompression: getLatestContextCompression(),
            status: 'completed',
            taskTree: taskTracker.getTree(),
            checkpointId,
            checkpointCount,
          }
        } catch (resumeError) {
          const resumeNormalized = normalizeAgentError(resumeError)
          const nextPartialMessage = extractPartialProviderMessage(resumeNormalized)
          const nextPartialReasoning = extractPartialProviderReasoning(resumeNormalized)
          const nextPartialToolCalls = extractPartialProviderToolCalls(resumeNormalized)
          const nextRetryInfo = extractProviderRetryInfo(resumeNormalized)
          const canRetryCheckpointResume =
            resumeAttempt + 1 < maxCheckpointResumeAttempts &&
            resumeNormalized.source === 'provider' &&
            isProviderStreamStallError(resumeNormalized, nextRetryInfo) &&
            (
              checkpointId ||
              toolEvents.length > continuationToolEventStart ||
              nextPartialMessage.length > 0 ||
              nextPartialReasoning.length > 0 ||
              nextPartialToolCalls.length > 0
            )
          if (!canRetryCheckpointResume) {
            break
          }
          createCheckpointForRecoverableProgress('resume_interrupted_with_progress', continuationToolEventStart, {
            force: true,
            errorCode: resumeNormalized.code,
            errorSource: resumeNormalized.source,
          })
          resumeErrorForAttempt = resumeNormalized
          resumePartialMessage = nextPartialMessage
          resumePartialReasoning = nextPartialReasoning
          resumePartialToolCalls = nextPartialToolCalls
          resumeRetryInfo = nextRetryInfo
        }
      }
    }

    if (normalized.source === 'provider' && hasRecoveryContext) {
      let recoveryRetryInfo
      const recoveryCompletionContext = buildCompletionContext(
        routeState,
        toolEvents,
        buildRuntimeBlocks(lastRouteDecision?.stopReason),
      )
      try {
        hooks?.onPhaseChange?.('recovering', {
          reason: normalized.message,
          code: normalized.code,
          stage: retryInfo?.stage,
          lastErrorSummary: retryInfo?.lastErrorSummary || normalized.message,
          providerStatus: normalized.errorInfo?.details?.providerStatus,
          providerErrorDetail: normalized.errorInfo?.detail,
          providerRawError:
            normalized.errorInfo?.details?.providerRawError ||
            normalized.rawMessage,
        })
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
            sanitizeResultMessage(recovered, toolEvents),
            toolEvents,
            routeState,
            buildRuntimeBlocks(lastRouteDecision?.stopReason),
          )
          recoveredResult = {
            ...recoveredResult,
            recovered: true,
          }
          const summaryReasoning = summarizeReasoning(
            messages,
            toolEvents,
            recoveredResult.message,
            hooks,
          )
          hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
            blockId: summaryReasoning[0].id,
            kind: summaryReasoning[0].kind,
            order: summaryReasoning[0].order,
            createdAt: summaryReasoning[0].createdAt,
          })
          completeCurrentTaskWithResult(
            taskTracker,
            currentTaskId,
            routeState,
            recoveredResult,
          )
          return {
            ...recoveredResult,
            toolEvents,
            agentMode: 'default-agent',
            routeDecision: lastRouteDecision,
            capabilitySnapshot: lastSelectedCapabilities?.capabilitySnapshot,
            reasoning: summaryReasoning,
            workMemories: context.workMemories,
            retryInfo: markRecoveredRetryInfo(recovered.retryInfo, retryInfo),
            usage: getAccumulatedUsage() || recovered.usage,
            contextCompression: getLatestContextCompression(),
            status: 'completed',
            taskTree: taskTracker.getTree(),
            checkpointId,
            checkpointCount,
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
      const summaryReasoning = summarizeReasoning(
        messages,
        toolEvents,
        fallbackResult.message,
        hooks,
      )
      hooks?.onReasoningDelta?.(summaryReasoning[0].content, {
        blockId: summaryReasoning[0].id,
        kind: summaryReasoning[0].kind,
        order: summaryReasoning[0].order,
        createdAt: summaryReasoning[0].createdAt,
      })
      completeCurrentTaskWithResult(
        taskTracker,
        currentTaskId,
        routeState,
        fallbackResult,
      )
      return {
        ...fallbackResult,
        toolEvents,
        agentMode: 'default-agent',
        routeDecision: lastRouteDecision,
        capabilitySnapshot: lastSelectedCapabilities?.capabilitySnapshot,
        reasoning: summaryReasoning,
        workMemories: context.workMemories,
        retryInfo: recoveryRetryInfo || retryInfo,
        usage: getAccumulatedUsage(),
        contextCompression: getLatestContextCompression(),
        status: 'completed',
        taskTree: taskTracker.getTree(),
        checkpointId,
        checkpointCount,
      }
    }

    taskTracker.setStatus(currentTaskId, 'failed', normalized.message)
    const enriched = new Error(normalized.message)
    enriched.code = normalized.code
    enriched.source = normalized.source
    enriched.rawMessage = normalized.rawMessage
    enriched.errorInfo = normalized.errorInfo
    enriched.retryInfo = retryInfo
    enriched.agentMode = 'default-agent'
    enriched.checkpointCount = checkpointCount
    enriched.routeDecision = {
      ...lastRouteDecision,
      stopReason:
        lastRouteDecision?.stopReason ||
        (normalized.code === 'ROUTE_RUNTIME_EXHAUSTED'
          ? 'runtime_pass_limit'
          : lastRouteDecision?.stopReason),
    }
    enriched.checkpointId = checkpointId
    if (checkpointId) {
      checkpointManager.commitCheckpoint(checkpointId)
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

async function runFastPathAgent(request, classification, taskFrame) {
  const {
    settings,
    messages: requestedMessages,
    hooks = {},
  } = request
  const messages = Array.isArray(requestedMessages) ? requestedMessages : []

  hooks?.onPhaseChange?.('model_connecting')
  if (settings?.provider !== 'custom' && !settings?.apiKey?.trim()) {
    throw createStructuredError('模型调用失败，当前缺少 API Key。', {
      source: 'provider',
      category: 'authentication',
      code: 'MISSING_API_KEY',
      detail: 'Missing API key.',
      suggestedAction: '请先在设置页填写可用的 Provider API Key。',
    })
  }

  const toolEvents = []
  const routeState = {
    capabilityTier: 'none',
    budgets: {},
    allowEscalationTo: [],
    responseStyle: 'concise',
  }
  const systemPrompt = [
    'You are Aura running the fast path for a simple request.',
    'Answer directly and concisely without using tools.',
    'Do not claim to inspect local files, run commands, browse the web, or use current external facts.',
    'If the user request actually requires local files, tools, web lookup, or current information, say that standard execution is required.',
  ].join('\n')

  const turnResult = await runProviderTurn({
    settings,
    systemPrompt,
    messages,
    tools: [],
    toolEvents,
    routeState,
    hooks,
  })

  const result = sanitizeResultMessage(turnResult.result, toolEvents)
  return {
    ...result,
    status: 'completed',
    completionState: 'not_executed',
    agentMode: 'default-agent',
    pathMode: 'fast',
    routeDecision: {
      capabilityTier: 'none',
      budgets: {},
      allowEscalationTo: [],
      availableEscalations: [],
      escalationCount: 0,
      tierHistory: ['none'],
      stopReason: 'completed',
      mountedCapabilities: {
        skills: [],
        plugins: [],
        mcpServers: [],
        tools: [],
      },
    },
    toolEvents,
    reasoning: result.reasoning || [],
    taskTree: [],
    classifier: classification,
    taskFrame,
  }
}

export async function runAgent(request) {
  const mode = resolveAgentExecutionMode(request?.settings)
  const runtimeLogger = createAgentRuntimeLogger({
    hooks: request?.hooks,
    settings: request?.settings,
    logContext: request?.logContext,
    mode,
  })
  const hooks = wrapAgentRuntimeHooks(request?.hooks || {}, runtimeLogger)
  const effectiveSettings = {
    ...(request?.settings || {}),
    agentArchitectureMode: 'default-agent',
  }
  const effectiveRequest = {
    ...request,
    hooks,
    settings: effectiveSettings,
  }
  const initialObservedMemories = await recordInitialContextObservations(
    effectiveRequest,
    runtimeLogger,
  )
  if (initialObservedMemories.length > 0) {
    effectiveRequest.runtime = {
      ...(effectiveRequest.runtime || {}),
      persistedWorkMemories: [
        ...((Array.isArray(effectiveRequest.runtime?.persistedWorkMemories)
          ? effectiveRequest.runtime.persistedWorkMemories
          : [])),
        ...initialObservedMemories,
      ],
      workMemories: [
        ...((Array.isArray(effectiveRequest.runtime?.workMemories)
          ? effectiveRequest.runtime.workMemories
          : [])),
        ...initialObservedMemories,
      ],
    }
  }
  let executionPathMode = mode.pathMode || 'default'
  runtimeLogger.setPathMode(executionPathMode)

  runtimeLogger.emit('agent.run.started', {
    model: request?.settings?.model,
    provider: request?.settings?.provider,
    cwd: request?.settings?.cwd,
    effectiveAgentMode: mode.effectiveAgentMode,
  })
  runtimeLogger.emit('agent.path.selected', {
    pathMode: executionPathMode,
    reason:
      'default-agent model-directed execution',
    confidence: 'model-directed',
    estimatedRisk: 'model-directed',
  })

  try {
    const result = await runDefaultAgent(effectiveRequest)
    if (result?.recovered === true || result?.retryInfo?.recovered === true) {
      runtimeLogger.emit('agent.recovery.event', {
        stage: 'completed',
        recovered: true,
        fallbackUsed: false,
      })
    }
    if (result?.protocolLeak) {
      runtimeLogger.emit(
        'agent.protocol_leak.detected',
        {
          hasToolCall: result.protocolLeak.hasToolCall,
          hasToolResult: result.protocolLeak.hasToolResult,
          originalMessageLength: result.protocolLeak.originalMessageLength,
          toolEventCount: Array.isArray(result?.toolEvents) ? result.toolEvents.length : 0,
          action: result.protocolLeak.hasToolResult
            ? 'discarded_simulated_tool_transcript'
            : 'stripped_inline_tool_markers',
        },
        { level: 'warn' },
      )
    }
    runtimeLogger.emit(
      'agent.completion.checked',
      {
        completionState: result?.completionState,
        isComplete:
          result?.status === 'completed' &&
          !isCompletionStateIncompleteForExecution(result, {}, {}),
        evidence: result?.evidenceSummary,
      },
    )
    runtimeLogger.emit(
      'agent.run.finished',
      buildRunFinishedDetails(result, runtimeLogger, result?.status || 'completed'),
    )
    runtimeLogger.emit(
      'agent.metrics.summary',
      buildMetricsSummaryDetails(result, runtimeLogger, result?.status || 'completed'),
    )
    if (
      effectiveRequest.runtime?.skipProjectMemoryIdleUpdate !== true &&
      !['project_memory_retriever', 'project_memory_organizer'].includes(
        String(effectiveRequest.runtime?.subagentRole || ''),
      )
    ) {
      scheduleProjectMemoryIdleUpdate({
        settings: effectiveSettings,
        messages: effectiveRequest.messages,
        result,
        hooks,
        runNestedAgent: nestedRequest =>
          runAgent({
            ...nestedRequest,
            hooks: nestedRequest?.hooks || hooks,
          }),
      })
    }
    return result
  } catch (error) {
    runtimeLogger.emit(
      'agent.error.classified',
      buildErrorDetails(error),
      { level: 'error' },
    )
    runtimeLogger.emit(
      'agent.run.finished',
      {
        status: 'failed',
        terminationReason:
          error?.code ||
          error?.routeDecision?.stopReason ||
          error?.completionState ||
          'failed',
        agentMode: error?.agentMode,
        completionState: error?.completionState,
        durationMs: runtimeLogger.elapsedMs(),
      },
      { level: 'error' },
    )
    runtimeLogger.emit(
      'agent.metrics.summary',
      buildMetricsSummaryDetails({
        status: 'failed',
        terminationReason:
          error?.code ||
          error?.routeDecision?.stopReason ||
          error?.completionState ||
          'failed',
        agentMode: error?.agentMode,
        completionState: error?.completionState,
        graphState: error?.graphState,
        graphCheckpoints: error?.graphCheckpoints,
        pathMode: executionPathMode,
      }, runtimeLogger, 'failed'),
      { level: 'error' },
    )
    throw error
  }
}
