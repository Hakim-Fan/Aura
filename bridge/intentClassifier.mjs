import { deriveHardSignals } from './agentRouting.mjs'
import { guardedFetch } from './web/net/guardedFetch.mjs'
import { normalizeBaseUrl } from './utils.mjs'

const INTENT_CLASSIFIER_TIMEOUT_MS = 5_000
const MAX_CLASSIFIER_MESSAGES = 4

const ANSWER_MODES = new Set(['advise', 'diagnose', 'execute'])
const COMPLEXITY_LEVELS = new Set(['low', 'medium', 'high'])
const PLAN_DEPTHS = new Set(['single_step', 'multi_step', 'long_horizon'])
const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high'])
const PATH_REFERENCE_PATTERN =
  /(?:^|[\s`"'(])(?:\.{0,2}\/[^\s`"'():,]+|[a-z0-9_./-]+\.[a-z0-9]{1,8})(?=$|[\s`"'),:])/giu
const WORKSPACE_HINT_PATTERN =
  /\b(?:workspace|repo|repository|project|code|file|files|folder|directory|git|commit|branch|diff|status|test|config|stack trace|log)\b|工作区|仓库|项目|代码|文件|目录|提交|分支|测试|配置|日志|报错|错误/iu
const LOCAL_WRITE_HINT_PATTERN =
  /\b(?:write|create|add|update|edit|modify|fix|implement|refactor|rewrite|rename|remove|delete|patch)\b|写入|创建|新增|更新|编辑|修改|修复|实现|重构|重写|重命名|删除|补丁/iu
const LOCAL_DIAGNOSE_HINT_PATTERN =
  /\b(?:review|debug|diagnose|analyze|check|verify|inspect|explain|why)\b|审查|调试|排查|诊断|分析|检查|验证|查看|解释|为什么/iu
const LOCAL_READ_HINT_PATTERN =
  /\b(?:read|open|show|summarize|describe)\b|读取|打开|查看|总结|概述|说明/iu
const CAPABILITY_ADMIN_HINT_PATTERN =
  /\b(?:skill|plugin|mcp|capability)\b|技能|插件|能力/iu
const CAPABILITY_ADMIN_ACTION_PATTERN =
  /\b(?:enable|disable|import|install|remove|uninstall|configure|edit|update|manage)\b|启用|禁用|导入|安装|移除|卸载|配置|编辑|更新|管理/iu
const EXTERNAL_FACT_HINT_PATTERN =
  /\b(?:latest|current|today|news|price|official|online|website|article|source|sources|public web)\b|最新|当前|今天|新闻|价格|官网|在线|网站|文章|来源/iu
const MULTI_STEP_HINT_PATTERN =
  /\b(?:and then|then|after that|step by step|multiple|several|workflow|end-to-end|across files|across the repo|phase|phases)\b|然后|接着|分步骤|多步|多个|跨文件|整个仓库|阶段|流程/iu
const LONG_HORIZON_HINT_PATTERN =
  /\b(?:automation|autonomous|planner|controller|orchestrated|long horizon|cross system)\b|自动化|自主执行|规划器|编排|长链路|跨系统/iu

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

function normalizeFastPathText(value) {
  return normalizeText(value).toLowerCase()
}

function collectMessageText(message) {
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

  return [message?.content, parts].filter(Boolean).join('\n')
}

function getRecentConversationMessages(messages) {
  return Array.isArray(messages)
    ? messages
        .filter(message => message?.role === 'user' || message?.role === 'assistant')
        .slice(-MAX_CLASSIFIER_MESSAGES)
    : []
}

function getLatestUserMessage(messages) {
  return [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find(message => message?.role === 'user')
}

function countPathReferences(text) {
  const matches = String(text || '').match(PATH_REFERENCE_PATTERN) || []
  return new Set(
    matches
      .map(match => match.trim().replace(/^[`"'(]+|[`"'):,]+$/gu, ''))
      .filter(Boolean),
  ).size
}

function countLatestUserFileParts(message) {
  return Array.isArray(message?.parts)
    ? message.parts.filter(part => part?.type === 'file').length
    : 0
}

function resolveFastPathPlanningHints({
  rawIntent,
  normalizedIntent,
  pathReferenceCount,
  fileAttachmentCount,
}) {
  if (
    LONG_HORIZON_HINT_PATTERN.test(normalizedIntent) ||
    pathReferenceCount + fileAttachmentCount >= 4
  ) {
    return {
      taskComplexity: 'high',
      planDepth: 'long_horizon',
      confidence: 'medium',
    }
  }

  if (
    MULTI_STEP_HINT_PATTERN.test(normalizedIntent) ||
    pathReferenceCount + fileAttachmentCount >= 2 ||
    String(rawIntent || '').split(/\r?\n/u).filter(Boolean).length >= 3
  ) {
    return {
      taskComplexity: 'medium',
      planDepth: 'multi_step',
      confidence: 'high',
    }
  }

  return {
    taskComplexity: 'low',
    planDepth: 'single_step',
    confidence: 'high',
  }
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

function buildFastPathClassification(base) {
  return parseAndValidateClassification(base)
}

function resolveWorkspaceAnswerMode(normalizedIntent, fileAttachmentCount, pathReferenceCount) {
  if (LOCAL_WRITE_HINT_PATTERN.test(normalizedIntent)) {
    return 'execute'
  }

  if (LOCAL_DIAGNOSE_HINT_PATTERN.test(normalizedIntent)) {
    return 'diagnose'
  }

  if (
    LOCAL_READ_HINT_PATTERN.test(normalizedIntent) ||
    fileAttachmentCount > 0 ||
    pathReferenceCount > 0
  ) {
    return 'advise'
  }

  return null
}

function resolveExternalAnswerMode(normalizedIntent) {
  if (LOCAL_DIAGNOSE_HINT_PATTERN.test(normalizedIntent)) {
    return 'diagnose'
  }

  if (LOCAL_READ_HINT_PATTERN.test(normalizedIntent)) {
    return 'advise'
  }

  return 'advise'
}

function inferFallbackClassification(messages, options = {}) {
  const hardSignals = options.hardSignals || deriveHardSignals(messages)
  const latestUserMessage = getLatestUserMessage(messages)
  const rawIntent = collectMessageText(latestUserMessage)
  const normalizedIntent = normalizeFastPathText(rawIntent)
  const fileAttachmentCount = countLatestUserFileParts(latestUserMessage)
  const pathReferenceCount = countPathReferences(rawIntent)
  const workspaceSignal =
    fileAttachmentCount > 0 ||
    pathReferenceCount > 0 ||
    WORKSPACE_HINT_PATTERN.test(normalizedIntent)
  const planningHints = resolveFastPathPlanningHints({
    rawIntent,
    normalizedIntent,
    pathReferenceCount,
    fileAttachmentCount,
  })
  const needsExternalFacts =
    hardSignals?.explicitWebLookupRead === true ||
    hardSignals?.publicWebUrlReference === true ||
    EXTERNAL_FACT_HINT_PATTERN.test(normalizedIntent)
  const capabilityAdminRequested =
    CAPABILITY_ADMIN_HINT_PATTERN.test(normalizedIntent) &&
    CAPABILITY_ADMIN_ACTION_PATTERN.test(normalizedIntent)
  const workspaceAnswerMode = workspaceSignal
    ? resolveWorkspaceAnswerMode(normalizedIntent, fileAttachmentCount, pathReferenceCount)
    : null

  let answerMode = 'advise'
  let webInteractionRequired = false
  let workspaceRelated = workspaceSignal
  let isCapabilityAdmin = false
  let systemBrowserRequested = false
  let confidence = 'low'
  let reason = 'generic-default'

  if (hardSignals?.explicitWebInteraction === true) {
    answerMode = 'execute'
    webInteractionRequired = true
    systemBrowserRequested = hardSignals?.explicitSystemBrowserRequest === true
    confidence = 'medium'
    reason = 'explicit-browser-interaction'
  } else if (capabilityAdminRequested) {
    answerMode = 'execute'
    isCapabilityAdmin = true
    workspaceRelated = false
    confidence = 'medium'
    reason = 'capability-admin'
  } else if (workspaceAnswerMode) {
    answerMode = workspaceAnswerMode
    confidence = needsExternalFacts ? 'medium' : 'low'
    reason =
      needsExternalFacts === true
        ? `workspace-${workspaceAnswerMode}-with-external-facts`
        : `workspace-${workspaceAnswerMode}`
  } else if (needsExternalFacts) {
    answerMode = resolveExternalAnswerMode(normalizedIntent)
    workspaceRelated = workspaceSignal
    confidence = 'low'
    reason = 'external-facts'
  }

  return {
    classification: buildFastPathClassification({
      answerMode,
      needsExternalFacts,
      webInteractionRequired,
      workspaceRelated,
      isCapabilityAdmin,
      systemBrowserRequested,
      taskComplexity: planningHints.taskComplexity,
      planDepth: planningHints.planDepth,
      confidence,
    }),
    source: 'fallback',
    reason,
  }
}

export function inferDeterministicClassification(messages, options = {}) {
  if (options.settings?.disableIntentFastPath === true) {
    return null
  }

  const hardSignals = options.hardSignals || deriveHardSignals(messages)
  const latestUserMessage = getLatestUserMessage(messages)
  const rawIntent = collectMessageText(latestUserMessage)
  const normalizedIntent = normalizeFastPathText(rawIntent)
  const fileAttachmentCount = countLatestUserFileParts(latestUserMessage)
  const pathReferenceCount = countPathReferences(rawIntent)
  const workspaceSignal =
    fileAttachmentCount > 0 ||
    pathReferenceCount > 0 ||
    WORKSPACE_HINT_PATTERN.test(normalizedIntent)
  const planningHints = resolveFastPathPlanningHints({
    rawIntent,
    normalizedIntent,
    pathReferenceCount,
    fileAttachmentCount,
  })
  const hasExternalFactHint =
    hardSignals?.explicitWebLookupRead === true ||
    hardSignals?.publicWebUrlReference === true ||
    EXTERNAL_FACT_HINT_PATTERN.test(normalizedIntent)
  const capabilityAdminRequested =
    CAPABILITY_ADMIN_HINT_PATTERN.test(normalizedIntent) &&
    CAPABILITY_ADMIN_ACTION_PATTERN.test(normalizedIntent)
  const workspaceAnswerMode = workspaceSignal
    ? resolveWorkspaceAnswerMode(normalizedIntent, fileAttachmentCount, pathReferenceCount)
    : null
  const externalAnswerMode = resolveExternalAnswerMode(normalizedIntent)

  if (hardSignals?.explicitWebInteraction === true) {
    return {
      classification: buildFastPathClassification({
        answerMode: 'execute',
        needsExternalFacts: hasExternalFactHint,
        webInteractionRequired: true,
        workspaceRelated: workspaceSignal,
        isCapabilityAdmin: false,
        systemBrowserRequested: hardSignals?.explicitSystemBrowserRequest === true,
        taskComplexity: planningHints.taskComplexity,
        planDepth: planningHints.planDepth,
        confidence: 'high',
      }),
      source: 'fast-path',
      reason: 'explicit-browser-interaction',
    }
  }

  if (capabilityAdminRequested && hardSignals?.explicitWebLookupRead !== true) {
    return {
      classification: buildFastPathClassification({
        answerMode: 'execute',
        needsExternalFacts: false,
        webInteractionRequired: false,
        workspaceRelated: false,
        isCapabilityAdmin: true,
        systemBrowserRequested: false,
        taskComplexity: planningHints.taskComplexity,
        planDepth: planningHints.planDepth,
        confidence: 'high',
      }),
      source: 'fast-path',
      reason: 'capability-admin',
    }
  }

  if (workspaceSignal === true && capabilityAdminRequested !== true) {
    if (workspaceAnswerMode && hasExternalFactHint === true) {
      return {
        classification: buildFastPathClassification({
          answerMode: workspaceAnswerMode,
          needsExternalFacts: true,
          webInteractionRequired: false,
          workspaceRelated: true,
          isCapabilityAdmin: false,
          systemBrowserRequested: false,
          taskComplexity: planningHints.taskComplexity,
          planDepth: planningHints.planDepth,
          confidence: 'high',
        }),
        source: 'fast-path',
        reason: `obvious-${workspaceAnswerMode}-with-external-facts`,
      }
    }

    if (workspaceAnswerMode && hasExternalFactHint !== true) {
      return {
        classification: buildFastPathClassification({
          answerMode: workspaceAnswerMode,
          needsExternalFacts: false,
          webInteractionRequired: false,
          workspaceRelated: true,
          isCapabilityAdmin: false,
          systemBrowserRequested: false,
          taskComplexity: planningHints.taskComplexity,
          planDepth: planningHints.planDepth,
          confidence: planningHints.confidence,
        }),
        source: 'fast-path',
        reason: `obvious-local-${workspaceAnswerMode}`,
      }
    }
  }

  if (
    hasExternalFactHint === true &&
    workspaceSignal !== true &&
    capabilityAdminRequested !== true
  ) {
    return {
      classification: buildFastPathClassification({
        answerMode: externalAnswerMode,
        needsExternalFacts: true,
        webInteractionRequired: false,
        workspaceRelated: false,
        isCapabilityAdmin: false,
        systemBrowserRequested: false,
        taskComplexity: planningHints.taskComplexity,
        planDepth: planningHints.planDepth,
        confidence: 'high',
      }),
      source: 'fast-path',
      reason: 'obvious-external-facts',
    }
  }

  return null
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

  const recentMessages = getRecentConversationMessages(messages)

  if (recentMessages.length === 0) {
    throw new Error('No conversation messages available for intent classification.')
  }

  const rawText =
    classifierSettings.provider === 'google'
      ? await classifyWithGoogle(settings, recentMessages)
      : await classifyWithOpenAiCompatible(settings, recentMessages)

  return parseAndValidateClassification(rawText)
}

export async function resolveIntentClassification(messages, settings, options = {}) {
  const fastPath = inferDeterministicClassification(messages, options)
  if (fastPath) {
    return fastPath
  }

  try {
    return {
      classification: await classifyIntent(messages, settings),
      source: 'model',
      reason: 'model-classifier',
    }
  } catch {
    return inferFallbackClassification(messages, options)
  }
}
