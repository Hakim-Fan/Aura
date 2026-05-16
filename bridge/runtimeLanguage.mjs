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
    understandGoal: '理解目标与执行约束',
    inspectWorkspace: '检查相关工作区状态',
    applyWorkspaceChanges: '通过 route-first 运行时执行工作区修改',
    executeRequest: '通过 route-first 运行时执行请求',
    gatherCurrentContext: '收集当前外部上下文',
    verifyCompletion: '验证完成情况并合并最终结果',
    verifyPrevious: '验证上一次 route-first 执行',
    recoverFailed: '恢复失败的 route-first 执行',
    continueExecution: '继续执行',
  },
  'en-US': {
    planTitle: 'Execution Plan',
    understandGoal: 'Understand goal and execution constraints',
    inspectWorkspace: 'Inspect relevant workspace state',
    applyWorkspaceChanges: 'Apply requested workspace changes through route-first runtime',
    executeRequest: 'Execute requested work through route-first runtime',
    gatherCurrentContext: 'Gather current external context',
    verifyCompletion: 'Verify completion and merge final result',
    verifyPrevious: 'Verify previous route-first execution',
    recoverFailed: 'Recover failed route-first execution',
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
