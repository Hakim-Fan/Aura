const LONG_TEXT_THRESHOLD = 1600
const SIMPLE_TEXT_THRESHOLD = 900

function collectMessageText(message) {
  if (!message) return ''
  const parts = []
  if (typeof message.content === 'string') {
    parts.push(message.content)
  }
  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      if (typeof part?.text === 'string') {
        parts.push(part.text)
      } else if (typeof part?.content === 'string') {
        parts.push(part.content)
      }
    }
  }
  return parts.join('\n').trim()
}

function latestUserMessage(messages = []) {
  return [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find(message => message?.role === 'user') || null
}

function hasAttachments(message) {
  return (
    (Array.isArray(message?.attachments) && message.attachments.length > 0) ||
    (Array.isArray(message?.parts) &&
      message.parts.some(part => part?.type && part.type !== 'text'))
  )
}

function containsAny(patterns, text) {
  return patterns.some(pattern => pattern.test(text))
}

const WRITE_OR_EXECUTE_PATTERNS = [
  /\b(?:write|edit|modify|update|create|delete|rename|move|patch|implement|fix|refactor|install|run|execute|test|build|commit|push|open)\b/iu,
  /(?:写|修改|更新|创建|删除|重命名|移动|实现|修复|重构|安装|运行|执行|测试|构建|提交|推送|打开)/u,
]

const WORKSPACE_PATTERNS = [
  /\b(?:repo|repository|codebase|workspace|project|branch|diff|file|folder|directory|README|package\.json|src\/|bridge\/|docs\/)\b/iu,
  /(?:仓库|代码库|工作区|项目|分支|文件|目录|这个函数|这个文件|当前实现|当前分支)/u,
  /(?:^|\s)(?:\.{0,2}\/|~\/)[^\s]+/u,
  /\b[A-Za-z0-9_.-]+\.(?:js|mjs|ts|tsx|json|md|rs|toml|css|html)\b/u,
]

const WEB_OR_CURRENT_PATTERNS = [
  /https?:\/\//iu,
  /\b(?:latest|current|today|yesterday|tomorrow|news|price|stock|weather|search|browse|google|web|website|url)\b/iu,
  /(?:最新|当前|今天|昨日|昨天|明天|新闻|价格|股价|天气|搜索|网页|网站|链接|浏览)/u,
]

const COMPLEXITY_PATTERNS = [
  /\b(?:architecture|migration|multi[-\s]?step|plan|roadmap|compare|analysis|audit|review|research)\b/iu,
  /(?:架构|迁移|多步|计划|路线图|对比|分析|审查|调研|研究|方案)/u,
]

export function classifyAgentTask({ messages = [], settings = {} } = {}) {
  const latestUser = latestUserMessage(messages)
  const text = collectMessageText(latestUser)
  const normalized = text.replace(/\s+/g, ' ').trim()
  const reasons = []
  let pathMode = 'standard'
  let complexity = 'standard'
  let risk = 'medium'

  if (!normalized) {
    return {
      pathMode: 'standard',
      complexity: 'standard',
      risk: 'medium',
      requiresTools: true,
      requiresWrite: false,
      reason: 'empty or non-text latest user message',
      reasons: ['empty_input'],
      confidence: 0.4,
    }
  }

  const requiresWrite = containsAny(WRITE_OR_EXECUTE_PATTERNS, normalized)
  const workspaceRelated = containsAny(WORKSPACE_PATTERNS, normalized)
  const needsCurrentInfo = containsAny(WEB_OR_CURRENT_PATTERNS, normalized)
  const looksComplex = containsAny(COMPLEXITY_PATTERNS, normalized)
  const attachmentPresent = hasAttachments(latestUser)
  const longTaskRequested = settings?.executionMode === 'long-task'
  const longText = normalized.length > LONG_TEXT_THRESHOLD

  if (attachmentPresent) reasons.push('attachments_present')
  if (requiresWrite) reasons.push('write_or_execute_intent')
  if (workspaceRelated) reasons.push('workspace_related')
  if (needsCurrentInfo) reasons.push('current_or_web_info_needed')
  if (looksComplex) reasons.push('complexity_keyword')
  if (longTaskRequested) reasons.push('long_task_mode')
  if (longText) reasons.push('long_input')

  if (longTaskRequested || longText || looksComplex) {
    pathMode = 'long'
    complexity = 'complex'
    risk = requiresWrite || attachmentPresent ? 'high' : 'medium'
  } else if (
    !attachmentPresent &&
    !requiresWrite &&
    !workspaceRelated &&
    !needsCurrentInfo &&
    normalized.length <= SIMPLE_TEXT_THRESHOLD
  ) {
    pathMode = 'fast'
    complexity = 'simple'
    risk = 'low'
    reasons.push('simple_no_tool_question')
  }

  return {
    pathMode,
    complexity,
    risk,
    requiresTools: pathMode !== 'fast' || attachmentPresent || workspaceRelated || needsCurrentInfo,
    requiresWrite,
    workspaceRelated,
    needsCurrentInfo,
    hasAttachments: attachmentPresent,
    reason: reasons.join(', ') || 'standard default-agent execution',
    reasons,
    confidence: pathMode === 'fast' ? 0.86 : 0.72,
    latestUserTextLength: normalized.length,
  }
}
