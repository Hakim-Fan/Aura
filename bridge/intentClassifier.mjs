import { guardedFetch } from './web/net/guardedFetch.mjs'
import { normalizeBaseUrl } from './utils.mjs'

const INTENT_CLASSIFIER_TIMEOUT_MS = 5_000
const MAX_CLASSIFIER_MESSAGES = 4

const ANSWER_MODES = new Set(['advise', 'diagnose', 'execute'])
const COMPLEXITY_LEVELS = new Set(['low', 'medium', 'high'])
const PLAN_DEPTHS = new Set(['single_step', 'multi_step', 'long_horizon'])
const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high'])

function resolveIntentClassifierSettings(settings) {
  const profiles = Array.isArray(settings?.providerProfiles)
    ? settings.providerProfiles
    : []
  const requestedProfileId =
    typeof settings?.analysisProviderProfileId === 'string'
      ? settings.analysisProviderProfileId.trim()
      : ''
  const requestedModel =
    typeof settings?.analysisModel === 'string' ? settings.analysisModel.trim() : ''

  if (requestedProfileId && requestedModel) {
    const profile = profiles.find(entry => entry?.id === requestedProfileId)
    const modelEnabled = Array.isArray(profile?.models)
      ? profile.models.some(model => model?.enabled !== false && model?.id === requestedModel)
      : false

    if (profile && modelEnabled) {
      return {
        provider: profile.provider || settings.provider,
        apiKey: profile.apiKey || settings.apiKey,
        baseUrl: profile.baseUrl || settings.baseUrl,
        model: requestedModel,
      }
    }
  }

  return {
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
  }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function flattenOpenAiMessageContent(content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
      if (!block || typeof block !== 'object') {
        return ''
      }
      if (typeof block.text === 'string') {
        return block.text
      }
      if (typeof block?.text?.value === 'string') {
        return block.text.value
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function buildClassifierTranscript(messages) {
  return messages
    .slice(-MAX_CLASSIFIER_MESSAGES)
    .map(message => {
      const parts = Array.isArray(message?.parts)
        ? message.parts
            .map(part => {
              if (part.type === 'text') {
                return part.text || ''
              }
              if (part.type === 'image' || part.type === 'file') {
                return [part.name, part.path].filter(Boolean).join(' ')
              }
              return ''
            })
            .filter(Boolean)
            .join('\n')
        : ''

      const content = normalizeText([message.content, parts].filter(Boolean).join('\n'))
      return `${message.role || 'user'}: ${content || '(empty)'}`
    })
    .join('\n')
}

function buildClassifierSystemPrompt() {
  return [
    'You classify the user intent for a local-first coding agent.',
    'Return exactly one JSON object and nothing else.',
    'Do not output markdown fences.',
    'Do not decide system behavior, tools, budgets, or route tiers.',
    'Only classify semantic intent using this schema:',
    JSON.stringify(
      {
        answerMode: 'advise | diagnose | execute',
        needsExternalFacts: true,
        webInteractionRequired: false,
        workspaceRelated: true,
        isCapabilityAdmin: false,
        systemBrowserRequested: false,
        taskComplexity: 'low | medium | high',
        planDepth: 'single_step | multi_step | long_horizon',
        confidence: 'low | medium | high',
      },
      null,
      2,
    ),
    'Interpretation rules:',
    '- needsExternalFacts: true only when the task depends on current external facts, online documentation, live data, news, prices, schedules, or public web sources.',
    '- If the user provides a public URL or asks to read, summarize, inspect, or analyze a linked page/article/post, treat that as needsExternalFacts: true unless they are only editing local code/config that happens to contain the URL.',
    '- Reading or summarizing a linked webpage is not browser interaction by itself. Keep webInteractionRequired: false unless the user explicitly wants manual browser actions such as clicking, logging in, filling forms, submitting, solving CAPTCHA, or operating the system browser.',
    '- webInteractionRequired: true only when the user wants browser interaction like open, click, login, fill, submit, navigate, or other page actions.',
    '- workspaceRelated: true when the task concerns the local repo, workspace files, project code, logs, configs, tests, or attached local files.',
    '- answerMode: advise for explanation/recommendation, diagnose for analysis/debug/review, execute for making changes or taking actions.',
    '- isCapabilityAdmin: true only for enabling, disabling, importing, editing, or managing skills, plugins, MCP, or agent capabilities.',
    '- systemBrowserRequested: true only when the user explicitly requests the system browser or the frontmost browser window.',
    '- taskComplexity: high only for clearly multi-stage or cross-system work; medium for moderate coordination; low for straightforward work.',
    '- planDepth: single_step for one-pass tasks, multi_step for several dependent steps, long_horizon for extended staged execution or automation.',
    '- confidence should reflect semantic certainty from the messages only.',
  ].join('\n')
}

function buildOpenAiClassifierMessages(messages) {
  return [
    {
      role: 'system',
      content: buildClassifierSystemPrompt(),
    },
    {
      role: 'user',
      content: `Conversation transcript:\n${buildClassifierTranscript(messages)}`,
    },
  ]
}

function buildGeminiClassifierPayload(messages) {
  return {
    system_instruction: {
      parts: [{ text: buildClassifierSystemPrompt() }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Conversation transcript:\n${buildClassifierTranscript(messages)}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 220,
    },
  }
}

async function parseJsonResponse(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Invalid provider JSON: ${text}`)
  }
}

function extractJsonObject(text) {
  const normalized = String(text || '').trim()
  if (!normalized) {
    throw new Error('Empty classifier response.')
  }

  const withoutFence = normalized
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim()

  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new Error(`Classifier response does not contain a JSON object: ${withoutFence}`)
  }

  return withoutFence.slice(start, end + 1)
}

export function parseAndValidateClassification(rawValue) {
  const parsed =
    typeof rawValue === 'string' ? JSON.parse(extractJsonObject(rawValue)) : rawValue

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Classifier response must be a JSON object.')
  }

  const classification = {
    answerMode: parsed.answerMode,
    needsExternalFacts: parsed.needsExternalFacts,
    webInteractionRequired: parsed.webInteractionRequired,
    workspaceRelated: parsed.workspaceRelated,
    isCapabilityAdmin: parsed.isCapabilityAdmin,
    systemBrowserRequested: parsed.systemBrowserRequested,
    taskComplexity: parsed.taskComplexity,
    planDepth: parsed.planDepth,
    confidence: parsed.confidence,
  }

  if (!ANSWER_MODES.has(classification.answerMode)) {
    throw new Error(`Invalid answerMode: ${classification.answerMode}`)
  }
  if (!COMPLEXITY_LEVELS.has(classification.taskComplexity)) {
    throw new Error(`Invalid taskComplexity: ${classification.taskComplexity}`)
  }
  if (!PLAN_DEPTHS.has(classification.planDepth)) {
    throw new Error(`Invalid planDepth: ${classification.planDepth}`)
  }
  if (!CONFIDENCE_LEVELS.has(classification.confidence)) {
    throw new Error(`Invalid confidence: ${classification.confidence}`)
  }

  for (const key of [
    'needsExternalFacts',
    'webInteractionRequired',
    'workspaceRelated',
    'isCapabilityAdmin',
    'systemBrowserRequested',
  ]) {
    if (typeof classification[key] !== 'boolean') {
      throw new Error(`Invalid boolean field: ${key}`)
    }
  }

  return classification
}

async function classifyWithOpenAiCompatible(settings, messages) {
  const classifierSettings = resolveIntentClassifierSettings(settings)
  const apiBase = normalizeBaseUrl(classifierSettings.baseUrl, 'https://api.openai.com/v1')
  const response = await guardedFetch(
    `${apiBase}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${classifierSettings.apiKey}`,
      },
      body: JSON.stringify({
        model: classifierSettings.model,
        messages: buildOpenAiClassifierMessages(messages),
        stream: false,
        temperature: 0,
        max_tokens: 220,
      }),
    },
    {
      settings,
      proxyMode: 'provider-explicit',
      timeoutMs: INTENT_CLASSIFIER_TIMEOUT_MS,
      timeoutMessage: 'Timed out while classifying intent.',
    },
  )

  if (!response.ok) {
    const data = await parseJsonResponse(response).catch(() => ({}))
    throw new Error(data?.error?.message || `Intent classifier request failed with ${response.status}`)
  }

  const data = await parseJsonResponse(response)
  return flattenOpenAiMessageContent(data?.choices?.[0]?.message?.content)
}

async function classifyWithGoogle(settings, messages) {
  const classifierSettings = resolveIntentClassifierSettings(settings)
  const apiBase = normalizeBaseUrl(
    classifierSettings.baseUrl,
    'https://generativelanguage.googleapis.com/v1beta',
  )
  const response = await guardedFetch(
    `${apiBase}/models/${classifierSettings.model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': classifierSettings.apiKey,
      },
      body: JSON.stringify(buildGeminiClassifierPayload(messages)),
    },
    {
      settings,
      proxyMode: 'provider-explicit',
      timeoutMs: INTENT_CLASSIFIER_TIMEOUT_MS,
      timeoutMessage: 'Timed out while classifying intent.',
    },
  )

  if (!response.ok) {
    const data = await parseJsonResponse(response).catch(() => ({}))
    throw new Error(data?.error?.message || `Intent classifier request failed with ${response.status}`)
  }

  const data = await parseJsonResponse(response)
  return (data?.candidates?.[0]?.content?.parts || [])
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

export async function classifyIntent(messages, settings) {
  const classifierSettings = resolveIntentClassifierSettings(settings)

  if (!classifierSettings.apiKey?.trim() || !classifierSettings.model?.trim()) {
    throw new Error('Missing provider API key for intent classification.')
  }

  const recentMessages = Array.isArray(messages)
    ? messages.filter(message => message?.role === 'user' || message?.role === 'assistant').slice(-MAX_CLASSIFIER_MESSAGES)
    : []

  if (recentMessages.length === 0) {
    throw new Error('No conversation messages available for intent classification.')
  }

  const rawText =
    classifierSettings.provider === 'google'
      ? await classifyWithGoogle(settings, recentMessages)
      : await classifyWithOpenAiCompatible(settings, recentMessages)

  return parseAndValidateClassification(rawText)
}
