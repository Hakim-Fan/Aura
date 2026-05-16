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
    'You are Aura Planning Runtime. Decide whether the user request should be answered directly or executed as a structured plan.',
    'Return ONLY valid JSON. Do not use markdown fences. Do not call tools.',
    `Primary response locale: ${localeLabel} (${locale}).`,
    'All human-readable string values in the JSON output, including answer, goal, descriptions, successCriteria, and notes, must use the configured locale.',
    '',
    'Direct answer is allowed only for pure conversation or general knowledge that needs no files, attachments, current information, tools, execution, or durable verification.',
    'Return a plan for file operations, attachments, document/spreadsheet/presentation work, code changes, web/current lookup, multi-step work, generation of artifacts, validation, shell execution, installs, or any task that needs tools.',
    '',
    'For a direct answer, return:',
    '{"type":"direct_answer","answer":"..."}',
    '',
    'For an executable plan, return:',
    '{"type":"plan","goal":"...","risk":"low|medium|high","requiresApproval":false,"steps":[{"id":"1","description":"short step"}],"successCriteria":["..."],"notes":"..."}',
    '',
    'Keep plan steps short and outcome-oriented. Describe WHAT should happen, not implementation code.',
    buildLanguagePolicyInstruction(settings),
  ].join('\n')
}

export function buildModelPlanningUserPrompt({ messages = [], settings = {} } = {}) {
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
    recentUserRequests: recentRequests,
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

  if (parsed.type === 'direct_answer') {
    return {
      type: 'direct_answer',
      answer: compactString(parsed.answer, 12_000),
      raw: parsed,
    }
  }

  const steps = safeArray(parsed.steps)
    .map((step, index) => ({
      id: compactString(step?.id || String(index + 1), 40) || String(index + 1),
      description: compactString(step?.description || step?.title || step?.summary, 220),
      kind: compactString(step?.kind || step?.type, 80),
      requiredCapability: compactString(step?.requiredCapability || step?.capability, 80),
    }))
    .filter(step => step.description)

  return {
    type: 'plan',
    goal: compactString(parsed.goal || parsed.title, 300) || 'Complete the user request',
    risk: ['low', 'medium', 'high'].includes(parsed.risk) ? parsed.risk : 'medium',
    requiresApproval: parsed.requiresApproval === true,
    steps: steps.length > 0 ? steps : [
      { id: '1', description: 'Execute the user request' },
      { id: '2', description: 'Verify the result' },
    ],
    successCriteria: safeArray(parsed.successCriteria)
      .map(entry => compactString(entry, 220))
      .filter(Boolean),
    notes: compactString(parsed.notes || parsed.note, 1000),
    raw: parsed,
  }
}
