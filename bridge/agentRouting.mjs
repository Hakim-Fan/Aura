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
  'chrome',
  'browser',
  'website',
  'url',
  'page',
  'tab',
  'login',
  'sign in',
  'captcha',
  'consent',
  'click',
  'form',
  'browser takeover',
  '网页',
  '浏览器',
  '网址',
  '页面',
  '标签页',
  '登录',
  '点击',
  '表单',
  '验证码',
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
  'web-lookup': 5,
  'browser-interactive': 3,
}

function uniqueTargets(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
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

export function inferRouteState(messages) {
  const text = buildConversationText(messages)
  const intent = latestUserIntent(messages)
  const asksInformational = hasAny(intent, INFORMATIONAL_KEYWORDS)
  const asksDiagnosis =
    hasAny(text, DIAGNOSIS_KEYWORDS) || (asksInformational && hasAny(text, WORKSPACE_KEYWORDS))
  const asksExecution =
    hasAny(intent, EXECUTION_KEYWORDS) &&
    !asksInformational &&
    !hasAny(intent, ['怎么', 'why', 'how', '原因', '解释', '分析', '看看', 'review', 'check'])
  const explicitWebInteraction = hasAny(text, WEB_INTERACTION_KEYWORDS)
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
  let capabilityTier = 'none'

  if (explicitWebInteraction) {
    capabilityTier = 'browser-interactive'
  } else if (needsExternalFacts) {
    capabilityTier = 'web-lookup'
  } else if (answerMode === 'execute') {
    capabilityTier = 'local-write'
  } else if (workspaceRelated) {
    capabilityTier = 'local-readonly'
  }

  const allowEscalationTo = []
  if (answerMode === 'execute' && supportsWriteEscalation(capabilityTier)) {
    allowEscalationTo.push('local-write')
  }
  if (!isWebCapableTier(capabilityTier) && needsExternalFacts) {
    allowEscalationTo.push('web-lookup')
  }
  if (supportsBrowserEscalation(capabilityTier) && explicitWebInteraction) {
    allowEscalationTo.push('browser-interactive')
  }

  return {
    answerMode,
    capabilityTier,
    allowEscalationTo: uniqueTargets(allowEscalationTo),
    budgets: {
      searchesRemaining: SEARCH_BUDGET_BY_TIER[capabilityTier] || 0,
      browserEscalationsRemaining:
        explicitWebInteraction && supportsBrowserEscalation(capabilityTier) ? 1 : 0,
      writeEscalationsRemaining:
        answerMode === 'execute' && supportsWriteEscalation(capabilityTier) ? 1 : 0,
    },
    completionPolicy: {
      canClaimDone: answerMode === 'execute',
      requiresEvidenceForDone: answerMode === 'execute',
    },
    isCapabilityAdminTask,
    explicitSystemChromeRequest,
  }
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
      SEARCH_BUDGET_BY_TIER[targetTier] || 0,
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
    if (tool?.name !== 'browser_search' && tool?.name !== 'web_search') {
      return tool
    }

    return {
      ...tool,
      async run(args, runtime = {}) {
        if ((budgets.searchesRemaining || 0) <= 0) {
          return {
            query: typeof args?.query === 'string' ? args.query : '',
            provider: 'route-budget',
            tookMs: 0,
            total: 0,
            results: [],
            budgetExhausted: true,
            code: 'ROUTE_SEARCH_BUDGET_EXHAUSTED',
            summary: '本轮网页搜索预算已经用完。',
            suggestedAction:
              '请直接基于前面已经成功的搜索结果继续分析，或改用 web_fetch 打开已有链接。',
          }
        }

        budgets.searchesRemaining -= 1
        return tool.run(args, runtime)
      },
    }
  })
}
