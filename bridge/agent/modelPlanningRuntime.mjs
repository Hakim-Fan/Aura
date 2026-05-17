import {
  buildLanguagePolicyInstruction,
  getLocaleDisplayName,
  normalizeRuntimeLocale,
} from '../runtimeLanguage.mjs'

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function compactString(value, maxLength = 1200) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function latestUserMessage(messages = []) {
  return [...safeArray(messages)].reverse().find(message => message?.role === 'user') || null
}

function messageText(message = {}, maxLength = 4000) {
  const partText = safeArray(message.parts)
    .filter(part => part?.type === 'text')
    .map(part => part?.text || '')
    .join('\n')
  return compactString(message?.content || partText, maxLength)
}

function attachmentKey(attachment = {}) {
  return [
    attachment.path || attachment.filePath || '',
    attachment.name || attachment.filename || '',
    attachment.type || attachment.mimeType || '',
  ].join('::')
}

function normalizeAttachmentSummary(attachment = {}, fallbackType = 'file') {
  return {
    name: compactString(attachment?.name || attachment?.filename || '', 120),
    type: compactString(attachment?.type || attachment?.mimeType || fallbackType, 80),
    path: compactString(attachment?.path || attachment?.filePath || '', 260),
  }
}

function summarizeMessageAttachments(message = {}) {
  const summaries = []
  const seen = new Set()
  const add = (attachment, fallbackType) => {
    const normalized = normalizeAttachmentSummary(attachment, fallbackType)
    if (!normalized.name && !normalized.path) return
    const key = attachmentKey(normalized)
    if (seen.has(key)) return
    seen.add(key)
    summaries.push(normalized)
  }

  for (const attachment of safeArray(message.attachments)) {
    add(attachment, 'file')
  }
  for (const part of safeArray(message.parts)) {
    if (part?.type === 'file' || part?.type === 'image') {
      add(part, part.type)
    }
  }

  return summaries
}

function recentUserMessages(messages = [], limit = 6) {
  return safeArray(messages)
    .filter(message => message?.role === 'user')
    .slice(-limit)
}

function summarizeRecentAttachments(messages = []) {
  const seen = new Set()
  const summaries = []
  for (const message of recentUserMessages(messages)) {
    for (const attachment of summarizeMessageAttachments(message)) {
      const key = attachmentKey(attachment)
      if (seen.has(key)) continue
      seen.add(key)
      summaries.push({
        index: summaries.length + 1,
        ...attachment,
      })
    }
  }
  return summaries
}

export function buildModelPlanningSystemPrompt(settings = {}) {
  const locale = normalizeRuntimeLocale(settings?.locale)
  const localeLabel = getLocaleDisplayName(locale)
  return [
    'You are Aura Planning Router. Decide task continuity, context needs, and whether the user request should be answered directly or executed as a structured plan.',
    'Return ONLY valid JSON. Do not use markdown fences. Do not call tools.',
    `Primary response locale: ${localeLabel} (${locale}).`,
    'All human-readable string values in the JSON output, including answer, goal, descriptions, successCriteria, and notes, must use the configured locale.',
    '',
    'First decide whether the latest request is a new task or a continuation. Do not use keyword matching alone; reason from the recent conversation, current task state, attachments, and prior work memory summaries.',
    'Use taskRelation.type values: new_task, continue_current, follow_up_current, switch_to_recent, clarification.',
    '',
    'Direct answer is allowed only for pure conversation or general knowledge that needs no files, attachments, current information, tools, execution, or durable verification.',
    'Return a plan for file operations, attachments, document/spreadsheet/presentation work, code changes, web/current lookup, multi-step work, generation of artifacts, validation, shell execution, installs, or any task that needs tools.',
    '',
    'Preferred output shape:',
    '{"taskRelation":{"type":"new_task|continue_current|follow_up_current|switch_to_recent|clarification","targetTaskId":null,"confidence":0.0,"reason":"..."},"executionMode":"direct_answer|plan_then_execute","contextRequest":{"includeRecentMessages":true,"includeCurrentTaskSummary":false,"includeWorkMemory":false,"includeArtifacts":false,"includeFileSummaries":false,"needsFreshFileRead":false,"reason":"..."},"response":{"type":"direct_answer","answer":"..."}}',
    '',
    'For an executable plan, set executionMode to plan_then_execute and make response:',
    '{"type":"plan","goal":"...","risk":"low|medium|high","requiresApproval":false,"steps":[{"id":"1","description":"short step","kind":"context|execute|verify|respond","acceptance":"what proves this step is done","requiredEvidence":["skill_read","file_parsed"]}],"successCriteria":["..."],"notes":"..."}',
    'Allowed requiredEvidence values: context_collected, skill_read, file_read, file_parsed, structured_output, command_output, file_mutation, artifact_present, test_pass, verification_passed, final_answer.',
    '',
    'Legacy outputs {"type":"direct_answer",...} and {"type":"plan",...} are accepted, but prefer the Planning Router shape above.',
    '',
    'Keep plan steps short and outcome-oriented. Describe WHAT should happen, not implementation code.',
    'Every plan step must include a user-readable acceptance field and a small requiredEvidence array. Use context/skill/file read evidence only for preparation steps; use execution evidence for steps that must actually produce, modify, parse, test, or generate something.',
    buildLanguagePolicyInstruction(settings),
  ].join('\n')
}

function summarizeAssistantExecution(message = {}) {
  if (!message || message.role !== 'assistant') {
    return null
  }
  const steps = safeArray(message.steps)
    .slice(-8)
    .map(step => ({
      id: compactString(step?.id || '', 80),
      title: compactString(step?.title || step?.summary || step?.description || '', 160),
      status: compactString(step?.status || '', 40),
    }))
    .filter(step => step.title || step.status)
  const events = safeArray(message.events)
    .slice(-6)
    .map(event => ({
      toolName: compactString(event?.toolName || event?.name || '', 80),
      status: compactString(event?.status || '', 40),
      summary: compactString(event?.summary || event?.error || event?.output || '', 220),
    }))
    .filter(event => event.toolName || event.summary)

  const summary = compactString(message.content, 900)
  const completionState = compactString(message.completionState || '', 80)
  const routeStopReason = compactString(message.routeDecision?.stopReason || '', 120)
  if (!summary && !completionState && !routeStopReason && steps.length === 0 && events.length === 0) {
    return null
  }

  return {
    id: compactString(message.id || '', 80),
    summary,
    completionState,
    routeStopReason,
    steps,
    recentToolEvents: events,
  }
}

function summarizeRecentAssistantExecutions(messages = []) {
  return safeArray(messages)
    .filter(message => message?.role === 'assistant')
    .slice(-3)
    .map(summarizeAssistantExecution)
    .filter(Boolean)
}

function summarizeCarryoverContext(carryoverContext = '') {
  const normalized = compactString(carryoverContext, 3200)
  if (!normalized) {
    return ''
  }
  return normalized
}

export function buildModelPlanningUserPrompt({
  messages = [],
  settings = {},
  carryoverContext = '',
  logContext = {},
} = {}) {
  const latest = latestUserMessage(messages)
  const text = messageText(latest, 4000)
  const recentUsers = recentUserMessages(messages)
  const recentRequests = recentUsers
    .map((message, index) => ({
      index: index + 1,
      id: compactString(message?.id || '', 80),
      content: messageText(message, index === recentUsers.length - 1 ? 4000 : 900),
      attachmentCount: summarizeMessageAttachments(message).length,
    }))
    .filter(entry => entry.content || entry.attachmentCount > 0)
  const latestAttachments = summarizeMessageAttachments(latest).map((attachment, index) => ({
    index: index + 1,
    ...attachment,
  }))
  const attachments = summarizeRecentAttachments(messages)
  const locale = normalizeRuntimeLocale(settings?.locale)
  const localeLabel = getLocaleDisplayName(locale)
  return JSON.stringify({
    latestUserRequest: text,
    logContext: {
      sessionId: compactString(logContext?.sessionId || '', 120),
      taskId: compactString(logContext?.taskId || '', 120),
      assistantMessageId: compactString(logContext?.assistantMessageId || '', 120),
      userMessageId: compactString(logContext?.userMessageId || '', 120),
    },
    recentUserRequests: recentRequests,
    recentAssistantExecutions: summarizeRecentAssistantExecutions(messages),
    priorWorkMemoryAndCarryover: summarizeCarryoverContext(carryoverContext),
    latestAttachments,
    attachments,
    hasAttachments: attachments.length > 0,
    locale,
    localeLabel,
  }, null, 2)
}

function extractJsonObject(text) {
  const value = String(text || '').trim()
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu)
    if (fenced) {
      try {
        return JSON.parse(fenced[1])
      } catch {
        // Fall through to brace extraction.
      }
    }
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

export function parseModelPlanningResult(text) {
  const parsed = extractJsonObject(text)
  if (!parsed || typeof parsed !== 'object') {
    return {
      type: 'plan',
      goal: compactString(text, 240) || 'Complete the user request',
      risk: 'medium',
      requiresApproval: false,
      steps: [
        { id: '1', description: 'Clarify and execute the request' },
        { id: '2', description: 'Verify the result' },
      ],
      notes: 'Planner response was not valid JSON, so Aura fell back to a conservative execution plan.',
      parseError: true,
    }
  }

  const taskRelation = normalizeTaskRelation(parsed.taskRelation || parsed.task_relation)
  const contextRequest = normalizeContextRequest(parsed.contextRequest || parsed.context_request)
  const executionMode = parsed.executionMode || parsed.execution_mode
  const response = parsed.response && typeof parsed.response === 'object'
    ? parsed.response
    : parsed.result && typeof parsed.result === 'object'
      ? parsed.result
      : parsed
  const responseType = response.type || (
    executionMode === 'direct_answer'
      ? 'direct_answer'
      : executionMode === 'plan_then_execute'
        ? 'plan'
        : parsed.type
  )

  if (responseType === 'direct_answer') {
    return {
      type: 'direct_answer',
      answer: compactString(response.answer, 12_000),
      taskRelation,
      contextRequest,
      executionMode: 'direct_answer',
      raw: parsed,
    }
  }

  const steps = safeArray(response.steps)
    .map((step, index) => ({
      id: compactString(step?.id || String(index + 1), 40) || String(index + 1),
      description: compactString(step?.description || step?.title || step?.summary, 220),
      kind: compactString(step?.kind || step?.type, 80),
      requiredCapability: compactString(step?.requiredCapability || step?.capability, 80),
      acceptance: compactString(
        step?.acceptance || step?.acceptanceCriteria || step?.validation || step?.successCriteria,
        260,
      ),
      requiredEvidence: safeArray(
        step?.requiredEvidence || step?.required_evidence || step?.evidence,
      )
        .map(entry => compactString(entry, 80))
        .filter(Boolean),
    }))
    .filter(step => step.description)

  return {
    type: 'plan',
    goal: compactString(response.goal || response.title, 300) || 'Complete the user request',
    risk: ['low', 'medium', 'high'].includes(response.risk) ? response.risk : 'medium',
    requiresApproval: response.requiresApproval === true,
    steps: steps.length > 0 ? steps : [
      { id: '1', description: 'Execute the user request' },
      { id: '2', description: 'Verify the result' },
    ],
    successCriteria: safeArray(response.successCriteria)
      .map(entry => compactString(entry, 220))
      .filter(Boolean),
    notes: compactString(response.notes || response.note, 1000),
    taskRelation,
    contextRequest,
    executionMode: 'plan_then_execute',
    raw: parsed,
  }
}

function normalizeTaskRelation(value = {}) {
  const allowed = new Set([
    'new_task',
    'continue_current',
    'follow_up_current',
    'switch_to_recent',
    'clarification',
  ])
  const type = allowed.has(value?.type) ? value.type : 'new_task'
  const confidence = Number(value?.confidence)
  return {
    type,
    targetTaskId: compactString(value?.targetTaskId || value?.target_task_id || '', 120) || null,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.5,
    reason: compactString(value?.reason, 420),
  }
}

function normalizeContextRequest(value = {}) {
  return {
    includeRecentMessages: value?.includeRecentMessages !== false && value?.include_recent_messages !== false,
    includeCurrentTaskSummary:
      value?.includeCurrentTaskSummary === true || value?.include_current_task_summary === true,
    includeWorkMemory: value?.includeWorkMemory === true || value?.include_work_memory === true,
    includeArtifacts: value?.includeArtifacts === true || value?.include_artifacts === true,
    includeFileSummaries:
      value?.includeFileSummaries === true || value?.include_file_summaries === true,
    needsFreshFileRead: value?.needsFreshFileRead === true || value?.needs_fresh_file_read === true,
    reason: compactString(value?.reason, 420),
  }
}
