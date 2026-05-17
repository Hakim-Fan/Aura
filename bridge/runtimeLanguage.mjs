const DEFAULT_LOCALE = 'zh-CN'

const LOCALE_LABELS = new Map([
  ['zh-cn', '简体中文'],
  ['zh-hans', '简体中文'],
  ['zh-tw', '繁體中文'],
  ['zh-hant', '繁體中文'],
  ['en-us', 'English'],
  ['en-gb', 'English'],
])

const TASK_LABELS = {
  'zh-CN': {
    planTitle: '执行计划',
    understandGoal: '理解需求和执行条件',
    inspectWorkspace: '查看相关文件和项目状态',
    applyWorkspaceChanges: '完成需要的项目修改',
    executeRequest: '执行用户请求',
    gatherCurrentContext: '获取所需的最新信息',
    verifyCompletion: '确认结果并整理最终回复',
    verifyPrevious: '确认上一步执行结果',
    verifyPreviousSummary: '确认上一步已经产生有效结果；如果发现问题，会先修复再继续后续步骤。',
    observableProgressSummary: '这一步需要产生可观察的进展，或明确说明无法继续的原因。',
    finalResponseSummary: '确认完成状态，整理可直接给用户阅读的最终回复。',
    recoverFailed: '尝试修复执行中遇到的问题',
    continueExecution: '继续执行',
  },
  'en-US': {
    planTitle: 'Execution Plan',
    understandGoal: 'Understand the request and constraints',
    inspectWorkspace: 'Review relevant files and project state',
    applyWorkspaceChanges: 'Make the required project changes',
    executeRequest: 'Complete the user request',
    gatherCurrentContext: 'Gather the latest required information',
    verifyCompletion: 'Confirm the result and prepare the final response',
    verifyPrevious: 'Confirm the previous step result',
    verifyPreviousSummary: 'Confirm the previous step produced a usable result; if an issue is found, fix it before continuing.',
    observableProgressSummary: 'This step should produce visible progress or clearly explain why it cannot continue.',
    finalResponseSummary: 'Confirm completion and prepare the final user-facing response.',
    recoverFailed: 'Try to fix the issue encountered during execution',
    continueExecution: 'Continue execution',
  },
}

function canonicalizeLocale(locale) {
  const normalized = String(locale || '').trim()
  if (!normalized) {
    return DEFAULT_LOCALE
  }

  const lower = normalized.toLowerCase().replace('_', '-')
  if (lower === 'zh-cn' || lower === 'zh-hans') return 'zh-CN'
  if (lower === 'zh-tw' || lower === 'zh-hant') return 'zh-TW'
  if (lower === 'en-us') return 'en-US'
  if (lower === 'en-gb') return 'en-GB'
  return normalized
}

export function normalizeRuntimeLocale(locale) {
  const normalized = canonicalizeLocale(locale)
  return normalized || DEFAULT_LOCALE
}

export function getLocaleDisplayName(locale) {
  const normalized = normalizeRuntimeLocale(locale)
  return LOCALE_LABELS.get(normalized.toLowerCase()) || normalized
}

export function buildLanguagePolicyInstruction(settings = {}) {
  const locale = normalizeRuntimeLocale(settings.locale)
  const localeLabel = getLocaleDisplayName(locale)
  return [
    `Language policy: all user-facing answers, plan previews, step titles, progress updates, summaries, and verification narration must be written in ${localeLabel} (${locale}).`,
    'Keep JSON keys, ids, code, file paths, command names, and tool identifiers in their original technical form.',
    'Do not switch languages mid-response unless the user explicitly asks for another language.',
  ].join('\n')
}

export function getRuntimeTaskLabels(localeOrSettings = {}) {
  const locale =
    typeof localeOrSettings === 'string'
      ? normalizeRuntimeLocale(localeOrSettings)
      : normalizeRuntimeLocale(localeOrSettings?.locale)
  return TASK_LABELS[locale] || TASK_LABELS['zh-CN']
}
