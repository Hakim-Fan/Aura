import { createStructuredError } from './runtimeErrors.mjs'

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`#>*_[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasAny(text, patterns) {
  return patterns.some(pattern => text.includes(pattern))
}

function buildConversationText(messages) {
  return normalizeText(
    messages
      .slice(-8)
      .map(message => {
        const parts = Array.isArray(message.parts)
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
            .join('\n')
          : ''

        return [message.content, parts].filter(Boolean).join('\n')
      })
      .join('\n'),
  )
}

function latestUserIntent(messages) {
  return normalizeText(
    [...messages].reverse().find(message => message.role === 'user')?.content || '',
  )
}

function latestUserResearchMode(messages) {
  return [...messages].reverse().find(message => message.role === 'user')?.researchMode === 'deep'
    ? 'deep'
    : 'auto'
}

function detectExplicitWebInteraction(text) {
  const normalized = normalizeText(text)
  if (!normalized) {
    return false
  }

  if (hasAny(normalized, WEB_INTERACTION_KEYWORDS)) {
    return true
  }

  return hasAny(normalized, WEB_SURFACE_KEYWORDS) && hasAny(normalized, WEB_ACTION_KEYWORDS)
}

const EXECUTION_KEYWORDS = [
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
]

const DIAGNOSIS_KEYWORDS = [
  'why',
  'how',
  'explain',
  'analyze',
  'analysis',
  'diagnose',
  'debug',
  'review',
  'check',
  'verify',
  'error',
  'bug',
  'failure',
  'stack trace',
  'what happened',
  '为什么',
  '怎么',
  '解释',
  '分析',
  '排查',
  '定位',
  '检查',
  '验证',
  '报错',
  '错误',
  '异常',
  '问题',
  '原因',
  '看看',
]

const INFORMATIONAL_KEYWORDS = [
  '我想知道',
  '想知道',
  '请问',
  '是否可以',
  '可不可以',
  '能不能',
  '能否',
  '是不是',
  '有没有',
  '是什么',
  '什么意思',
  '怎么理解',
  'why ',
  'what is ',
  'can i ',
  'could i ',
  'whether ',
]

const EXTERNAL_FACT_KEYWORDS = [
  'latest',
  'current',
  'today',
  'news',
  'search',
  'search the web',
  'web search',
  'documentation',
  'docs',
  'document',
  'article',
  'articles',
  'source',
  'sources',
  'research',
  'finance',
  'earnings',
  'market',
  'investor relations',
  'stock market',
  'bullish',
  'bearish',
  'price',
  'stock',
  'quote',
  'release note',
  'changelog',
  'official docs',
  'official documentation',
  '官方文档',
  '官网',
  '最新',
  '当前',
  '今天',
  '新闻',
  '搜索',
  '搜一下',
  '查一下',
  '资料',
  '文档',
  '文章来源',
  '来源',
  '研究',
  '股票',
  '股市',
  '财报',
  '公告',
  '研报',
  '利好',
  '利空',
  '港股',
  '美股',
  '价格',
  '股价',
  '行情',
  '版本发布',
  '更新日志',
]

const WEB_INTERACTION_KEYWORDS = [
  'login',
  'sign in',
  'captcha',
  'consent',
  'click',
  'form',
  'browser takeover',
  '登录',
  '点击',
  '表单',
  '验证码',
]

const WEB_SURFACE_KEYWORDS = [
  'chrome',
  'browser',
  'website',
  'url',
  'page',
  'tab',
  '网页',
  '浏览器',
  '网址',
  '页面',
  '标签页',
]

const WEB_ACTION_KEYWORDS = [
  'open',
  'navigate',
  'visit',
  'go to',
  'log in',
  'login',
  'sign in',
  'click',
  'type',
  'fill',
  'submit',
  'scroll',
  'switch tab',
  'take over',
  '打开',
  '访问',
  '进入',
  '登录',
  '点击',
  '输入',
  '填写',
  '提交',
  '滚动',
  '切换标签',
]

const SYSTEM_CHROME_REQUEST_KEYWORDS = [
  'google chrome',
  'system chrome',
  'frontmost chrome',
  'chrome window',
  '系统 chrome',
  '系统chrome',
  '谷歌浏览器',
  '当前 chrome',
  '当前chrome',
  'chrome 窗口',
  'chrome窗口',
]

const FORCE_ORCHESTRATED_KEYWORDS = [
  'orchestrated',
  'planner-controller-reviewer',
  'plan then execute then verify',
  'multi-stage automation',
  'cross-system workflow',
  'long-horizon',
  '多阶段自动化',
  '分阶段执行',
  '先规划再执行再验收',
  '跨系统流程',
  '长链路自动化',
]

const WORKSPACE_KEYWORDS = [
  'workspace',
  'repo',
  'repository',
  'project',
  'code',
  'file',
  'files',
  'folder',
  'directory',
  'git',
  'commit',
  'branch',
  'diff',
  'status',
  'rebase',
  'merge',
  'build',
  'test',
  'config',
  'stack trace',
  '代码',
  '文件',
  '目录',
  '仓库',
  '项目',
  '提交',
  '分支',
  '构建',
  '测试',
  '配置',
  '日志',
  '报错',
  '错误',
  'bug',
]

const CAPABILITY_ADMIN_KEYWORDS = [
  'skill',
  'plugin',
  'mcp',
  'capability',
  '技能',
  '插件',
  '能力',
]

const READONLY_BUILTIN_TOOLS = new Set([
  'list_files',
  'glob_files',
  'read_file',
  'search_code',
  'todo_write',
  'aura_list_capabilities',
  'aura_read_skill',
])

const WRITE_BUILTIN_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'run_shell',
])

const AURA_MUTATION_TOOLS = new Set([
  'aura_enable_skill',
  'aura_enable_plugin',
  'aura_import_skill',
  'aura_import_plugin',
  'aura_upsert_mcp_server',
  'aura_remove_mcp_server',
])

const WEB_LOOKUP_TOOLS = new Set([
  'web_search',
  'web_fetch',
])

const BROWSER_LOOKUP_TOOLS = new Set([
  'browser_open',
  'browser_get_page',
  'browser_snapshot',
  'browser_inspect_element',
  'browser_screenshot',
  'browser_wait_for',
  'browser_run_javascript',
  'browser_list_sessions',
  'browser_storage_list',
  'browser_storage_get',
  'browser_console_get',
  'browser_network_get',
  'browser_trace_start',
])

const BROWSER_INTERACTIVE_ONLY_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_set_active_session',
  'browser_close_session',
  'browser_storage_set',
  'browser_storage_clear',
  'browser_storage_export_state',
  'browser_storage_import_state',
  'browser_trace_stop',
  'browser_video_start',
  'browser_video_stop',
  'browser_takeover_visible',
  'browser_resume_after_takeover',
])

const SEARCH_BUDGET_BY_TIER = {
  none: 0,
  'local-readonly': 0,
  'local-write': 0,
  'web-lookup': 3,
  'browser-interactive': 2,
}

const DEEP_RESEARCH_SEARCH_BUDGET_BY_TIER = {
  none: 0,
  'local-readonly': 0,
  'local-write': 0,
  'web-lookup': 6,
  'browser-interactive': 4,
}

function uniqueTargets(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function normalizeSearchRuntimeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:site|filetype|before|after|intitle|inurl):([^\s]+)/giu, ' ')
    .replace(/\b(?:and|or|not)\b/giu, ' ')
    .replace(/["'`]+/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff.]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeSearchDomains(domains) {
  if (!Array.isArray(domains)) {
    return []
  }

  return Array.from(
    new Set(
      domains
        .map(entry =>
          String(entry || '')
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/.*$/, '')
            .replace(/^\.+|\.+$/g, ''),
        )
        .filter(Boolean),
    ),
  )
}

function extractSearchRuntimeHostname(value) {
  try {
    return String(new URL(value || '').hostname)
      .toLowerCase()
      .replace(/^www\./, '')
  } catch {
    return ''
  }
}

function normalizeEvidenceComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`"'“”‘’()[\]{}]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff\s.%:-]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeEvidenceComparableText(value) {
  return Array.from(
    new Set(
      (
        normalizeEvidenceComparableText(value).match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/gu) || []
      ).filter(Boolean),
    ),
  )
}

function computeTokenOverlap(leftTokens, rightTokens) {
  const left = new Set(leftTokens || [])
  const right = new Set(rightTokens || [])
  if (left.size === 0 || right.size === 0) {
    return { overlapCount: 0, jaccard: 0 }
  }

  let overlapCount = 0
  for (const token of left) {
    if (right.has(token)) {
      overlapCount += 1
    }
  }

  const union = new Set([...left, ...right]).size
  return {
    overlapCount,
    jaccard: union > 0 ? overlapCount / union : 0,
  }
}

function detectDirectionalConflict(leftText, rightText) {
  const left = normalizeEvidenceComparableText(leftText)
  const right = normalizeEvidenceComparableText(rightText)
  if (!left || !right) {
    return false
  }

  const contradictionPairs = [
    ['increase', 'decrease'],
    ['rose', 'fell'],
    ['up', 'down'],
    ['growth', 'decline'],
    ['profit', 'loss'],
    ['beat', 'miss'],
    ['launch', 'cancel'],
    ['support', 'oppose'],
    ['approved', 'rejected'],
    ['增长', '下降'],
    ['上升', '下滑'],
    ['上涨', '下跌'],
    ['盈利', '亏损'],
    ['支持', '反对'],
    ['发布', '取消'],
    ['获批', '被拒'],
  ]

  return contradictionPairs.some(([positive, negative]) => {
    const leftPositiveRightNegative = left.includes(positive) && right.includes(negative)
    const leftNegativeRightPositive = left.includes(negative) && right.includes(positive)
    return leftPositiveRightNegative || leftNegativeRightPositive
  })
}

function normalizeFetchRuntimeRecord(output, fallbackUrl = '') {
  if (!output || typeof output !== 'object') {
    return null
  }

  const url =
    typeof output.finalUrl === 'string' && output.finalUrl.trim()
      ? output.finalUrl.trim()
      : typeof output.url === 'string' && output.url.trim()
        ? output.url.trim()
        : typeof fallbackUrl === 'string'
          ? fallbackUrl.trim()
          : ''
  if (!url) {
    return null
  }

  const title =
    typeof output.title === 'string' && output.title.trim()
      ? output.title.trim()
      : url
  const site =
    typeof output.site === 'string' && output.site.trim()
      ? output.site.trim()
      : extractSearchRuntimeHostname(url)
  const sourceAssessment =
    output.sourceAssessment && typeof output.sourceAssessment === 'object'
      ? output.sourceAssessment
      : {}
  const riskFlags = Array.isArray(output.riskFlags)
    ? output.riskFlags.filter(entry => typeof entry === 'string' && entry.trim())
    : []
  const evidenceBlocks = Array.isArray(output.evidenceBlocks)
    ? output.evidenceBlocks
        .filter(entry => entry && typeof entry === 'object')
        .map((entry, index) => {
          const claim =
            typeof entry.claim === 'string' && entry.claim.trim()
              ? entry.claim.trim()
              : typeof entry.supportingQuote === 'string' && entry.supportingQuote.trim()
                ? entry.supportingQuote.trim()
                : ''
          if (!claim) {
            return null
          }
          return {
            id:
              typeof entry.id === 'string' && entry.id.trim()
                ? entry.id.trim()
                : `claim-${index + 1}`,
            claim,
            kind: typeof entry.kind === 'string' ? entry.kind.trim() : '',
            evidenceScore:
              typeof entry.evidenceScore === 'number' && Number.isFinite(entry.evidenceScore)
                ? Math.round(entry.evidenceScore)
                : undefined,
            matchedKeywords: Array.isArray(entry.matchedKeywords)
              ? entry.matchedKeywords.filter(item => typeof item === 'string' && item.trim()).slice(0, 5)
              : [],
          }
        })
        .filter(Boolean)
    : []
  const keyPoints = Array.isArray(output.keyPoints)
    ? output.keyPoints.filter(entry => typeof entry === 'string' && entry.trim()).slice(0, 4)
    : []

  return {
    url,
    domain: extractSearchRuntimeHostname(url),
    title,
    site,
    publishedAt:
      typeof output.publishedAt === 'string' && output.publishedAt.trim()
        ? output.publishedAt.trim()
        : '',
    qualityScore:
      typeof sourceAssessment.qualityScore === 'number' && Number.isFinite(sourceAssessment.qualityScore)
        ? Math.round(sourceAssessment.qualityScore)
        : undefined,
    sourceCategory:
      typeof sourceAssessment.category === 'string' ? sourceAssessment.category.trim() : '',
    riskFlags,
    keyPoints,
    evidenceBlocks,
  }
}

function buildCrossSourceInsights(searchRuntime) {
  const fetches = Array.isArray(searchRuntime?.fetches) ? searchRuntime.fetches.slice(-6) : []
  const uniqueDomains = Array.from(new Set(fetches.map(entry => entry?.domain).filter(Boolean)))
  if (fetches.length < 2 || uniqueDomains.length < 2) {
    return null
  }

  const weakerSources = fetches
    .filter(entry =>
      entry?.sourceCategory === 'community' ||
      entry?.sourceCategory === 'low-signal' ||
      (Array.isArray(entry?.riskFlags) &&
        entry.riskFlags.some(flag => flag === 'community-source' || flag === 'low-signal-source')),
    )
    .map(entry => entry.site || entry.title || entry.url)
    .filter(Boolean)

  const corroboratingClaims = []
  const conflictingSignals = []
  const seenCorroborations = new Set()
  const seenConflicts = new Set()

  for (let leftIndex = 0; leftIndex < fetches.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < fetches.length; rightIndex += 1) {
      const leftSource = fetches[leftIndex]
      const rightSource = fetches[rightIndex]
      if (!leftSource || !rightSource || leftSource.domain === rightSource.domain) {
        continue
      }

      const leftClaims = Array.isArray(leftSource.evidenceBlocks) ? leftSource.evidenceBlocks : []
      const rightClaims = Array.isArray(rightSource.evidenceBlocks) ? rightSource.evidenceBlocks : []

      for (const leftClaim of leftClaims) {
        for (const rightClaim of rightClaims) {
          const leftText = leftClaim?.claim || ''
          const rightText = rightClaim?.claim || ''
          if (!leftText || !rightText) {
            continue
          }

          const overlap = computeTokenOverlap(
            tokenizeEvidenceComparableText(leftText),
            tokenizeEvidenceComparableText(rightText),
          )
          const sharedKeywords = Array.from(
            new Set([
              ...(Array.isArray(leftClaim?.matchedKeywords) ? leftClaim.matchedKeywords : []),
              ...(Array.isArray(rightClaim?.matchedKeywords) ? rightClaim.matchedKeywords : []),
            ]),
          ).slice(0, 5)
          const sources = [leftSource.site || leftSource.title, rightSource.site || rightSource.title]
            .filter(Boolean)
            .slice(0, 2)

          if (
            (overlap.overlapCount >= 2 || overlap.jaccard >= 0.26) &&
            !detectDirectionalConflict(leftText, rightText)
          ) {
            const key = normalizeEvidenceComparableText(sharedKeywords.join(' ') || leftText.slice(0, 120))
            if (!seenCorroborations.has(key)) {
              seenCorroborations.add(key)
              corroboratingClaims.push({
                summary: leftText.length <= rightText.length ? leftText : rightText,
                sharedKeywords,
                sources,
                confidenceScore: Math.round(
                  Math.min(
                    100,
                    ((leftClaim?.evidenceScore || 60) +
                      (rightClaim?.evidenceScore || 60)) / 2 +
                      overlap.overlapCount * 4,
                  ),
                ),
              })
            }
          } else if (
            (overlap.overlapCount >= 1 || overlap.jaccard >= 0.16) &&
            detectDirectionalConflict(leftText, rightText)
          ) {
            const key = `${normalizeEvidenceComparableText(leftText)}::${normalizeEvidenceComparableText(rightText)}`
            if (!seenConflicts.has(key)) {
              seenConflicts.add(key)
              conflictingSignals.push({
                summary: `${sources[0] || '来源 A'} 与 ${sources[1] || '来源 B'} 对同一主题的描述方向不一致。`,
                sources,
                leftClaim: leftText,
                rightClaim: rightText,
              })
            }
          }
        }
      }
    }
  }

  const uniqueWeakerSources = Array.from(new Set(weakerSources)).slice(0, 3)

  return {
    comparedSources: fetches.length,
    uniqueDomains: uniqueDomains.length,
    corroboratingClaims: corroboratingClaims.slice(0, 3),
    conflictingSignals: conflictingSignals.slice(0, 3),
    weakerSources: uniqueWeakerSources,
    overallSignal:
      conflictingSignals.length > 0
        ? 'mixed'
        : corroboratingClaims.length > 0
          ? 'corroborated'
          : 'limited',
  }
}

function getSearchRuntimeState(budgets) {
  if (!budgets || typeof budgets !== 'object') {
    return {
      attempts: [],
      fetches: [],
      lastResults: [],
    }
  }

  if (!budgets.searchRuntime || typeof budgets.searchRuntime !== 'object') {
    budgets.searchRuntime = {
      attempts: [],
      fetches: [],
      lastResults: [],
    }
  }

  if (!Array.isArray(budgets.searchRuntime.attempts)) {
    budgets.searchRuntime.attempts = []
  }

  if (!Array.isArray(budgets.searchRuntime.fetches)) {
    budgets.searchRuntime.fetches = []
  }

  if (!Array.isArray(budgets.searchRuntime.lastResults)) {
    budgets.searchRuntime.lastResults = []
  }

  return budgets.searchRuntime
}

function normalizeRecommendedSearchResult(result) {
  if (!result || typeof result !== 'object') {
    return null
  }

  const url = typeof result.url === 'string' ? result.url.trim() : ''
  if (!url) {
    return null
  }

  return {
    title:
      typeof result.title === 'string' && result.title.trim()
        ? result.title.trim()
        : url,
    url,
    site: typeof result.site === 'string' ? result.site.trim() : '',
    rankScore:
      typeof result.rankScore === 'number' && Number.isFinite(result.rankScore)
        ? Math.round(result.rankScore)
        : undefined,
    sourceQualityScore:
      typeof result.sourceQualityScore === 'number' && Number.isFinite(result.sourceQualityScore)
        ? Math.round(result.sourceQualityScore)
        : undefined,
    domainCategory:
      typeof result.domainCategory === 'string' ? result.domainCategory.trim() : '',
    rankingSignals: Array.isArray(result.rankingSignals)
      ? result.rankingSignals.filter(entry => typeof entry === 'string' && entry.trim()).slice(0, 4)
      : [],
    queryKey:
      typeof result.queryKey === 'string' && result.queryKey.trim()
        ? result.queryKey.trim()
        : '',
  }
}

function buildRecommendedFetchResults(searchRuntime, limit = 3, queryKey = '') {
  const fetchedUrls = new Set(
    (Array.isArray(searchRuntime?.fetches) ? searchRuntime.fetches : [])
      .map(entry => (typeof entry?.url === 'string' ? entry.url.trim() : ''))
      .filter(Boolean),
  )
  const usedDomains = new Set()
  const recommendations = []

  for (const entry of Array.isArray(searchRuntime?.lastResults) ? searchRuntime.lastResults : []) {
    const normalized = normalizeRecommendedSearchResult(entry)
    if (!normalized || fetchedUrls.has(normalized.url)) {
      continue
    }
    if (queryKey && normalized.queryKey && normalized.queryKey !== queryKey) {
      continue
    }

    const hostname = extractSearchRuntimeHostname(normalized.url)
    const strongEnough =
      typeof normalized.rankScore === 'number'
        ? normalized.rankScore >= 60
        : true

    if (!strongEnough) {
      continue
    }

    if (hostname && usedDomains.has(hostname) && recommendations.length < 2) {
      continue
    }

    if (hostname) {
      usedDomains.add(hostname)
    }
    recommendations.push(normalized)
    if (recommendations.length >= limit) {
      break
    }
  }

  return recommendations
}

function hasStrongReadCandidates(searchRuntime, queryKey = '') {
  const recommendations = buildRecommendedFetchResults(searchRuntime, 3, queryKey)
  if (recommendations.length === 0) {
    return false
  }

  const topScore = recommendations[0]?.rankScore || 0
  const multiSource = new Set(
    recommendations.map(entry => extractSearchRuntimeHostname(entry.url)).filter(Boolean),
  ).size >= 2

  return topScore >= 75 || (topScore >= 68 && multiSource)
}

function buildSearchAttemptSignature(args = {}) {
  const query = normalizeSearchRuntimeText(args.query)
  const domains = normalizeSearchDomains(args.domains)
  return {
    query,
    domains,
    comparableKey: `${query}::${domains.join(',')}`,
  }
}

function shouldStopSearchAttempts(searchRuntime, attemptSignature, routeState) {
  const attempts = Array.isArray(searchRuntime?.attempts)
    ? searchRuntime.attempts.slice(-4)
    : []
  const fetches = Array.isArray(searchRuntime?.fetches)
    ? searchRuntime.fetches.slice(-4)
    : []
  const deepResearch = routeState?.researchMode === 'deep'
  const enoughDiscoveryThreshold = deepResearch ? 4 : 3
  const enoughEvidenceFetchThreshold = deepResearch ? 3 : 2
  const preFetchSearchThreshold = deepResearch ? 3 : 2
  const sufficientDiscoveryAttemptThreshold = deepResearch ? 3 : 2
  const sufficientDiscoveryDomainThreshold = deepResearch ? 4 : 3

  if (attempts.length === 0) {
    return { shouldStop: false, reason: '' }
  }

  const successfulAttempts = attempts.filter(entry => entry?.noResults !== true && entry?.total > 0)
  const discoveredDomains = Array.from(
    new Set(successfulAttempts.flatMap(entry => entry.resultDomains || []).filter(Boolean)),
  )

  if (
    fetches.length === 0 &&
    successfulAttempts.length >= 1 &&
    hasStrongReadCandidates(searchRuntime, attemptSignature.comparableKey)
  ) {
    return {
      shouldStop: true,
      reason: 'read-recommended-results-first',
    }
  }

  if (successfulAttempts.length >= enoughDiscoveryThreshold) {
    return {
      shouldStop: true,
      reason: 'enough-discovery',
    }
  }

  if (fetches.length >= enoughEvidenceFetchThreshold && successfulAttempts.length >= 1) {
    return {
      shouldStop: true,
      reason: 'enough-evidence',
    }
  }

  if (successfulAttempts.length >= preFetchSearchThreshold && fetches.length === 0) {
    return {
      shouldStop: true,
      reason: 'fetch-before-more-search',
    }
  }

  if (
    successfulAttempts.length >= sufficientDiscoveryAttemptThreshold &&
    discoveredDomains.length >= sufficientDiscoveryDomainThreshold
  ) {
    return {
      shouldStop: true,
      reason: 'sufficient-discovery',
    }
  }

  const duplicateAttempt = attempts.find(
    entry => entry.comparableKey && entry.comparableKey === attemptSignature.comparableKey,
  )
  if (duplicateAttempt?.noResults) {
    return {
      shouldStop: true,
      reason: 'duplicate-no-results',
    }
  }

  const consecutiveNoResults = attempts
    .slice(-2)
    .every(entry => entry?.noResults === true)
  if (consecutiveNoResults) {
    return {
      shouldStop: true,
      reason: 'repeated-no-results',
    }
  }

  const duplicateSuccess = attempts.find(
    entry =>
      entry.comparableKey &&
      entry.comparableKey === attemptSignature.comparableKey &&
      entry.noResults !== true,
  )
  if (duplicateSuccess) {
    return {
      shouldStop: true,
      reason: 'duplicate-search-success',
    }
  }

  return { shouldStop: false, reason: '' }
}

function buildSearchStopPayload(reason, args, searchRuntime, attemptSignature = {}) {
  const query = typeof args?.query === 'string' ? args.query : ''
  const domains = normalizeSearchDomains(args?.domains)
  const recommendedResults = buildRecommendedFetchResults(
    searchRuntime,
    3,
    attemptSignature.comparableKey || '',
  )
  const summary =
    reason === 'read-recommended-results-first'
      ? '已经找到一组质量较高的候选来源，下一步应该先阅读这些页面，而不是继续扩展搜索。'
      : reason === 'fetch-before-more-search'
      ? '已经完成候选来源发现，下一步应该优先阅读已找到的页面，而不是继续机械改写搜索词。'
      : reason === 'enough-evidence'
        ? '已经读过一批相关来源，继续扩展搜索的增量很低，先基于现有证据收束回答更稳妥。'
        : reason === 'enough-discovery'
          ? '已经做过多轮来源发现，继续搜索的边际收益很低。'
      : reason === 'duplicate-no-results' || reason === 'repeated-no-results'
      ? '连续搜索都没有带来新结果，继续改写相似 query 的收益已经很低。'
      : reason === 'sufficient-discovery'
        ? '已经拿到足够的候选来源，继续广撒网搜索的增量很低。'
      : reason === 'budget-exhausted'
        ? '当前搜索阶段先收束到这里，优先基于已经找到的线索继续整理和回答。'
        : '相同方向的网页搜索已经拿到候选来源，继续重复搜索的增量很低。'

  return {
    query,
    domains,
    provider: 'route-search-controller',
    tookMs: 0,
    total: 0,
    results: [],
    searchStopped: true,
    code: 'ROUTE_SEARCH_DIMINISHING_RETURNS',
    summary,
    recommendedResults,
    suggestedAction:
      reason === 'read-recommended-results-first' ||
      reason === 'fetch-before-more-search' ||
      reason === 'enough-evidence' ||
      reason === 'duplicate-search-success' ||
      reason === 'sufficient-discovery' ||
      reason === 'enough-discovery' ||
      reason === 'budget-exhausted'
        ? recommendedResults.length > 0
          ? '优先改用 web_fetch 打开 recommendedResults 里的高分链接，再决定是否还需要补搜。'
          : '优先改用 web_fetch 打开 rankScore 更高、来源质量更好的链接，或直接基于已有来源收束回答。'
        : '不要继续机械地改写搜索词。可以放宽域名条件后再试一次；如果仍然没有结果，就直接说明没有找到足够公开信息。',
  }
}

function supportsWriteEscalation(capabilityTier) {
  return capabilityTier !== 'local-write' && capabilityTier !== 'browser-interactive'
}

function supportsBrowserEscalation(capabilityTier) {
  return capabilityTier !== 'browser-interactive'
}

function isWebCapableTier(capabilityTier) {
  return capabilityTier === 'web-lookup' || capabilityTier === 'browser-interactive'
}

function getSearchBudgetForRoute({
  capabilityTier,
  researchMode,
  needsExternalFacts,
  taskComplexity,
  planDepth,
}) {
  const baseBudget = SEARCH_BUDGET_BY_TIER[capabilityTier] || 0
  if (!isWebCapableTier(capabilityTier)) {
    return baseBudget
  }
  if (researchMode === 'deep') {
    return DEEP_RESEARCH_SEARCH_BUDGET_BY_TIER[capabilityTier] || baseBudget
  }
  if (
    needsExternalFacts === true &&
    (taskComplexity === 'high' || planDepth === 'long_horizon')
  ) {
    return baseBudget + 1
  }
  return baseBudget
}

function determineResponseStyle({
  researchMode,
  needsExternalFacts,
  webInteractionRequired,
  taskComplexity,
  planDepth,
}) {
  if (researchMode === 'deep') {
    return 'research-structured'
  }
  if (webInteractionRequired || needsExternalFacts !== true) {
    return 'adaptive-default'
  }
  if (taskComplexity === 'high' && planDepth !== 'single_step') {
    return 'research-structured'
  }
  if (planDepth === 'long_horizon') {
    return 'research-structured'
  }
  return 'adaptive-default'
}

function buildRouteStateFromSignals({
  answerMode,
  needsExternalFacts,
  webInteractionRequired,
  workspaceRelated,
  isCapabilityAdminTask,
  explicitSystemChromeRequest,
  researchMode = 'auto',
  taskComplexity = 'medium',
  planDepth = 'single_step',
}) {
  let capabilityTier = 'none'

  if (webInteractionRequired) {
    capabilityTier = 'browser-interactive'
  } else if (needsExternalFacts) {
    capabilityTier = 'web-lookup'
  } else if (answerMode === 'execute' && workspaceRelated) {
    capabilityTier = 'local-write'
  } else if (workspaceRelated) {
    capabilityTier = 'local-readonly'
  }

  const allowEscalationTo = []
  if (answerMode === 'execute' && workspaceRelated && supportsWriteEscalation(capabilityTier)) {
    allowEscalationTo.push('local-write')
  }
  if (!isWebCapableTier(capabilityTier) && needsExternalFacts) {
    allowEscalationTo.push('web-lookup')
  }
  if (supportsBrowserEscalation(capabilityTier) && webInteractionRequired) {
    allowEscalationTo.push('browser-interactive')
  }

  const responseStyle = determineResponseStyle({
    researchMode,
    needsExternalFacts,
    webInteractionRequired,
    taskComplexity,
    planDepth,
  })

  return {
    answerMode,
    capabilityTier,
    researchMode,
    responseStyle,
    taskComplexity,
    planDepth,
    allowEscalationTo: uniqueTargets(allowEscalationTo),
    budgets: {
      searchesRemaining: getSearchBudgetForRoute({
        capabilityTier,
        researchMode,
        needsExternalFacts,
        taskComplexity,
        planDepth,
      }),
      browserEscalationsRemaining:
        webInteractionRequired && supportsBrowserEscalation(capabilityTier) ? 1 : 0,
      writeEscalationsRemaining:
        answerMode === 'execute' && workspaceRelated && supportsWriteEscalation(capabilityTier)
          ? 1
          : 0,
    },
    completionPolicy: {
      canClaimDone: answerMode === 'execute',
      requiresEvidenceForDone: answerMode === 'execute',
    },
    isCapabilityAdminTask,
    explicitSystemChromeRequest,
  }
}

export function deriveHardSignals(messages) {
  const text = buildConversationText(messages)
  const intent = latestUserIntent(messages)

  return {
    explicitWebInteraction: detectExplicitWebInteraction(intent),
    explicitWorkspaceWrite:
      hasAny(intent, EXECUTION_KEYWORDS) && hasAny(text, WORKSPACE_KEYWORDS),
    explicitSystemChromeRequest: hasAny(text, SYSTEM_CHROME_REQUEST_KEYWORDS),
    forceOrchestrated: hasAny(intent, FORCE_ORCHESTRATED_KEYWORDS),
  }
}

export function inferRouteStateFromClassification(classification, hardSignals = {}) {
  if (!classification || typeof classification !== 'object') {
    throw createStructuredError('缺少有效的意图分类结果，无法基于分类推导路由状态。', {
      source: 'system',
      category: 'invalid_input',
      code: 'INVALID_INTENT_CLASSIFICATION',
      detail: 'inferRouteStateFromClassification received an invalid classification object.',
      suggestedAction: '请回退到关键字路由，或先完成意图分类。',
    })
  }

  let answerMode =
    classification.answerMode === 'execute' ||
    classification.answerMode === 'diagnose' ||
    classification.answerMode === 'advise'
      ? classification.answerMode
      : 'advise'

  const webInteractionRequired =
    classification.webInteractionRequired === true ||
    hardSignals.explicitWebInteraction === true
  const workspaceRelated =
    classification.workspaceRelated === true || hardSignals.explicitWorkspaceWrite === true

  if (webInteractionRequired || hardSignals.explicitWorkspaceWrite === true) {
    answerMode = 'execute'
  }

  return buildRouteStateFromSignals({
    answerMode,
    needsExternalFacts: classification.needsExternalFacts === true,
    webInteractionRequired,
    workspaceRelated,
    isCapabilityAdminTask: classification.isCapabilityAdmin === true,
    explicitSystemChromeRequest:
      classification.systemChromeRequested === true ||
      hardSignals.explicitSystemChromeRequest === true,
    researchMode: hardSignals.researchMode || 'auto',
    taskComplexity: classification.taskComplexity,
    planDepth: classification.planDepth,
  })
}

export function inferRouteStateFromKeywords(messages) {
  const text = buildConversationText(messages)
  const intent = latestUserIntent(messages)
  const asksInformational = hasAny(intent, INFORMATIONAL_KEYWORDS)
  const asksDiagnosis =
    hasAny(text, DIAGNOSIS_KEYWORDS) || (asksInformational && hasAny(text, WORKSPACE_KEYWORDS))
  const asksExecution =
    hasAny(intent, EXECUTION_KEYWORDS) &&
    !asksInformational &&
    !hasAny(intent, ['怎么', 'why', 'how', '原因', '解释', '分析', '看看', 'review', 'check'])
  const explicitWebInteraction = detectExplicitWebInteraction(intent)
  const explicitSystemChromeRequest = hasAny(text, SYSTEM_CHROME_REQUEST_KEYWORDS)
  const needsExternalFacts = hasAny(text, EXTERNAL_FACT_KEYWORDS)
  const workspaceRelated = hasAny(text, WORKSPACE_KEYWORDS)
  const isCapabilityAdminTask = hasAny(text, CAPABILITY_ADMIN_KEYWORDS)

  const answerMode = explicitWebInteraction
    ? 'execute'
    : asksExecution
      ? 'execute'
      : asksDiagnosis
        ? 'diagnose'
        : 'advise'
  return buildRouteStateFromSignals({
    answerMode,
    needsExternalFacts,
    webInteractionRequired: explicitWebInteraction,
    workspaceRelated: workspaceRelated || answerMode === 'execute',
    isCapabilityAdminTask,
    explicitSystemChromeRequest,
    researchMode: latestUserResearchMode(messages),
  })
}

export function inferRouteState(messages, options = {}) {
  if (options?.classification) {
    return inferRouteStateFromClassification(
      options.classification,
      {
        ...(options.hardSignals || deriveHardSignals(messages)),
        researchMode: latestUserResearchMode(messages),
      },
    )
  }
  return inferRouteStateFromKeywords(messages)
}

export function selectAgentStrategy(classification, hardSignals = {}, options = {}) {
  let chain = 'route-first'
  let reason = 'default-fast-path'

  if (hardSignals.forceOrchestrated === true) {
    chain = 'orchestrated'
    reason = 'forced-by-hard-signal'
  } else if (!classification) {
    reason = 'keyword-fallback'
  } else if (classification.confidence === 'low') {
    reason = 'low-confidence-default'
  } else if (
    classification.taskComplexity === 'high' &&
    classification.planDepth !== 'single_step'
  ) {
    chain = 'orchestrated'
    reason = 'high-complexity'
  } else if (
    classification.answerMode === 'execute' &&
    classification.planDepth === 'long_horizon'
  ) {
    chain = 'orchestrated'
    reason = 'long-horizon-execution'
  }

  if (chain === 'orchestrated' && options.orchestratedAvailable === false) {
    return {
      chain: 'route-first',
      requestedChain: 'orchestrated',
      reason: 'orchestrated-unavailable-fallback',
    }
  }

  return { chain, reason }
}

function allowReadonlyPluginLikeTool(tool, routeState) {
  return tool.source === 'plugin' || tool.source === 'mcp'
    ? !tool.approvalCategory && !routeState.explicitSystemChromeRequest
    : true
}

function isBuiltinReadonlyTool(tool) {
  return tool.source === 'builtin' && READONLY_BUILTIN_TOOLS.has(tool.name)
}

function isBuiltinWriteTool(tool) {
  return tool.source === 'builtin' && WRITE_BUILTIN_TOOLS.has(tool.name)
}

function isAuraMutationTool(tool) {
  return tool.source === 'builtin' && AURA_MUTATION_TOOLS.has(tool.name)
}

function isBrowserLookupTool(tool) {
  return tool.source === 'builtin' && BROWSER_LOOKUP_TOOLS.has(tool.name)
}

function isWebLookupTool(tool) {
  return tool.source === 'builtin' && WEB_LOOKUP_TOOLS.has(tool.name)
}

function isBrowserInteractiveOnlyTool(tool) {
  return tool.source === 'builtin' && BROWSER_INTERACTIVE_ONLY_TOOLS.has(tool.name)
}

function isComputerTool(tool) {
  return tool.source === 'builtin' && tool.name.startsWith('computer_')
}

function isChromeTool(tool) {
  return tool.source === 'builtin' && tool.name.startsWith('chrome_')
}

export function filterToolsForRouteState(tools, routeState) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return []
  }

  return tools.filter(tool => {
    if (!tool || typeof tool !== 'object') {
      return false
    }

    if (routeState.capabilityTier === 'none') {
      return false
    }

    if (isComputerTool(tool)) {
      return false
    }

    if (routeState.capabilityTier === 'local-readonly') {
      if (isBrowserLookupTool(tool) || isBrowserInteractiveOnlyTool(tool) || isBuiltinWriteTool(tool)) {
        return false
      }
      if (isAuraMutationTool(tool) && !routeState.isCapabilityAdminTask) {
        return false
      }
      return isBuiltinReadonlyTool(tool) || allowReadonlyPluginLikeTool(tool, routeState)
    }

    if (routeState.capabilityTier === 'local-write') {
      if (isBrowserLookupTool(tool) || isBrowserInteractiveOnlyTool(tool)) {
        return false
      }
      if (isAuraMutationTool(tool) && !routeState.isCapabilityAdminTask) {
        return false
      }
      if (tool.source === 'builtin') {
        return isBuiltinReadonlyTool(tool) || isBuiltinWriteTool(tool) || isAuraMutationTool(tool)
      }
      return allowReadonlyPluginLikeTool(tool, routeState)
    }

    if (routeState.capabilityTier === 'web-lookup') {
      if (isBrowserInteractiveOnlyTool(tool)) {
        return false
      }
      if (isBuiltinWriteTool(tool)) {
        return false
      }
      if (isAuraMutationTool(tool) && !routeState.isCapabilityAdminTask) {
        return false
      }
      return (
        isBuiltinReadonlyTool(tool) ||
        isWebLookupTool(tool) ||
        allowReadonlyPluginLikeTool(tool, routeState)
      )
    }

    if (routeState.capabilityTier === 'browser-interactive') {
      if (isAuraMutationTool(tool) && !routeState.isCapabilityAdminTask) {
        return false
      }
      if (isChromeTool(tool)) {
        return routeState.explicitSystemChromeRequest
      }
      if (routeState.explicitSystemChromeRequest && tool.source === 'builtin' && tool.name.startsWith('browser_')) {
        return false
      }
      return true
    }

    return false
  })
}

export function getRouteEscalationTargets(routeState, options = {}) {
  if (!routeState || !Array.isArray(routeState.allowEscalationTo)) {
    return []
  }

  const visitedTiers = options.visitedTiers instanceof Set ? options.visitedTiers : null

  return routeState.allowEscalationTo.filter(targetTier => {
    if (!targetTier || targetTier === routeState.capabilityTier) {
      return false
    }
    if (visitedTiers?.has(targetTier)) {
      return false
    }
    if (
      targetTier === 'local-write' &&
      (!supportsWriteEscalation(routeState.capabilityTier) ||
        (routeState.budgets?.writeEscalationsRemaining || 0) <= 0)
    ) {
      return false
    }
    if (
      targetTier === 'browser-interactive' &&
      (!supportsBrowserEscalation(routeState.capabilityTier) ||
        (routeState.budgets?.browserEscalationsRemaining || 0) <= 0)
    ) {
      return false
    }
    return true
  })
}

export function escalateRouteState(routeState, targetTier) {
  const allowedTargets = getRouteEscalationTargets(routeState)
  if (!allowedTargets.includes(targetTier)) {
    throw createStructuredError('当前路由策略不允许升级到所请求的能力层级。', {
      source: 'system',
      category: 'invalid_input',
      code: 'ROUTE_ESCALATION_NOT_ALLOWED',
      detail: `Route escalation to "${targetTier}" is not allowed from "${routeState?.capabilityTier}".`,
      suggestedAction: '请基于当前能力继续收束回答，或等待新的用户指令明确提升所需权限。',
    })
  }

  const nextState = {
    ...routeState,
    capabilityTier: targetTier,
    budgets: {
      ...(routeState?.budgets || {}),
    },
  }

  if (targetTier === 'local-write') {
    nextState.budgets.writeEscalationsRemaining = Math.max(
      0,
      (nextState.budgets.writeEscalationsRemaining || 0) - 1,
    )
  }

  if (targetTier === 'browser-interactive') {
    nextState.budgets.browserEscalationsRemaining = Math.max(
      0,
      (nextState.budgets.browserEscalationsRemaining || 0) - 1,
    )
  }

  if (
    isWebCapableTier(targetTier) &&
    !isWebCapableTier(routeState.capabilityTier)
  ) {
    nextState.budgets.searchesRemaining = Math.max(
      nextState.budgets.searchesRemaining || 0,
      getSearchBudgetForRoute({
        capabilityTier: targetTier,
        researchMode: nextState.researchMode,
        needsExternalFacts: true,
        taskComplexity: nextState.taskComplexity,
        planDepth: nextState.planDepth,
      }),
    )
  }

  return nextState
}

export function applyRouteToolBudgets(tools, routeState) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools
  }

  const budgets = routeState?.budgets || {}
  const mountedTools =
    (budgets.searchesRemaining || 0) <= 0
      ? tools.filter(tool => tool?.name !== 'browser_search' && tool?.name !== 'web_search')
      : tools

  return mountedTools.map(tool => {
    if (tool?.name === 'web_fetch') {
      return {
        ...tool,
        async run(args, runtime = {}) {
          const output = await tool.run(args, runtime)
          const searchRuntime = getSearchRuntimeState(budgets)
          const normalizedOutput = output && typeof output === 'object' ? output : {}
          const fetchedUrl =
            typeof normalizedOutput.finalUrl === 'string' && normalizedOutput.finalUrl.trim()
              ? normalizedOutput.finalUrl
              : typeof normalizedOutput.url === 'string' && normalizedOutput.url.trim()
                ? normalizedOutput.url
                : typeof args?.url === 'string'
                  ? args.url
                  : ''
          const domain = extractSearchRuntimeHostname(fetchedUrl)
          const fetchRecord = normalizeFetchRuntimeRecord(normalizedOutput, fetchedUrl)

          if (fetchRecord) {
            searchRuntime.fetches = [
              ...(searchRuntime.fetches || []).filter(entry => entry?.url !== fetchRecord.url),
              {
                ...fetchRecord,
                domain,
              },
            ].slice(-6)
          }

          const crossSourceInsights = buildCrossSourceInsights(searchRuntime)
          if (normalizedOutput && typeof normalizedOutput === 'object') {
            return {
              ...normalizedOutput,
              crossSourceInsights,
            }
          }

          return output
        },
      }
    }

    if (tool?.name !== 'browser_search' && tool?.name !== 'web_search') {
      return tool
    }

    return {
      ...tool,
      async run(args, runtime = {}) {
        const searchRuntime = getSearchRuntimeState(budgets)
        const attemptSignature = buildSearchAttemptSignature(args)
        const stopDecision = shouldStopSearchAttempts(
          searchRuntime,
          attemptSignature,
          routeState,
        )
        if (stopDecision.shouldStop) {
          return buildSearchStopPayload(
            stopDecision.reason,
            args,
            searchRuntime,
            attemptSignature,
          )
        }

        if ((budgets.searchesRemaining || 0) <= 0) {
          return buildSearchStopPayload(
            'budget-exhausted',
            args,
            searchRuntime,
            attemptSignature,
          )
        }

        budgets.searchesRemaining -= 1
        const output = await tool.run(args, runtime)
        const normalizedOutput = output && typeof output === 'object' ? output : {}
        const recommendedResults = Array.isArray(normalizedOutput.results)
          ? normalizedOutput.results
              .map(result => {
                const normalizedResult = normalizeRecommendedSearchResult(result)
                if (!normalizedResult) {
                  return null
                }
                return {
                  ...normalizedResult,
                  queryKey: attemptSignature.comparableKey,
                }
              })
              .filter(Boolean)
              .slice(0, 5)
          : []
        const nextAttempt = {
          comparableKey: attemptSignature.comparableKey,
          query: attemptSignature.query,
          domains: attemptSignature.domains,
          noResults:
            normalizedOutput.noResults === true ||
            (typeof normalizedOutput.total === 'number' && normalizedOutput.total <= 0),
          total:
            typeof normalizedOutput.total === 'number' ? normalizedOutput.total : 0,
          resultDomains: Array.isArray(normalizedOutput.results)
            ? Array.from(
                new Set(
                  normalizedOutput.results
                    .map(result => {
                      return extractSearchRuntimeHostname(result?.url || '')
                    })
                    .filter(Boolean),
                ),
              )
            : [],
        }
        searchRuntime.attempts = [...(searchRuntime.attempts || []), nextAttempt].slice(-6)
        searchRuntime.lastResults = recommendedResults

        if (normalizedOutput && typeof normalizedOutput === 'object') {
          return {
            ...normalizedOutput,
            recommendedResults,
            recommendedNextAction:
              recommendedResults.length > 0
                ? 'fetch_top_ranked_results'
                : undefined,
          }
        }

        return output
      },
    }
  })
}
