function extractRawMessage(error) {
  if (error && typeof error === 'object') {
    if (typeof error.rawMessage === 'string' && error.rawMessage.trim()) {
      return error.rawMessage
    }
    if (typeof error.stack === 'string' && error.stack.trim()) {
      return error.stack
    }
    if (typeof error.message === 'string' && error.message.trim()) {
      return error.message
    }
  }
  return String(error || '')
}

function extractCode(error) {
  if (!error || typeof error !== 'object') {
    return undefined
  }
  if (typeof error.code === 'string' && error.code.trim()) {
    return error.code
  }
  if (typeof error.code === 'number') {
    return String(error.code)
  }
  if (typeof error.status === 'number') {
    return `HTTP_${error.status}`
  }
  return undefined
}

function extractStatus(error) {
  if (!error || typeof error !== 'object') {
    return undefined
  }
  return typeof error.status === 'number' ? error.status : undefined
}

function extractSource(error, fallbackSource) {
  if (
    error &&
    typeof error === 'object' &&
    typeof error.source === 'string' &&
    error.source.trim()
  ) {
    return error.source
  }
  return fallbackSource
}

function classifyError({ code, status, rawMessage }) {
  const normalizedCode = (code || '').toUpperCase()
  const normalizedMessage = (rawMessage || '').toLowerCase()

  if (normalizedCode === 'ENOENT') {
    return 'missing_dependency'
  }
  if (normalizedCode === 'EACCES' || normalizedCode === 'EPERM') {
    return 'permission'
  }
  if (normalizedCode === 'ETIMEDOUT' || normalizedMessage.includes('timeout')) {
    return 'timeout'
  }
  if (
    normalizedCode === 'ECONNRESET' ||
    normalizedCode === 'ECONNREFUSED' ||
    normalizedCode === 'ENOTFOUND' ||
    normalizedCode === 'EAI_AGAIN' ||
    normalizedMessage.includes('socket hang up') ||
    normalizedMessage.includes('network')
  ) {
    return 'network'
  }
  if (status === 401 || status === 403) {
    return 'authentication'
  }
  if (status === 429) {
    return 'rate_limit'
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'unavailable'
  }
  if (normalizedMessage.includes('denied by the user') || normalizedMessage.includes('已停止')) {
    return 'cancelled'
  }
  if (
    normalizedMessage.includes('tool not found') ||
    normalizedMessage.includes('not found')
  ) {
    return 'not_found'
  }
  if (
    normalizedMessage.includes('invalid json') ||
    normalizedMessage.includes('not valid json') ||
    normalizedMessage.includes('invalid argument') ||
    normalizedMessage.includes('invalid ipc message')
  ) {
    return 'invalid_input'
  }
  if (
    normalizedMessage.includes('unsupported') ||
    normalizedMessage.includes('not implemented') ||
    normalizedMessage.includes('macos only')
  ) {
    return 'unsupported'
  }
  if (status && status >= 400) {
    return 'execution_failed'
  }
  return 'execution_failed'
}

function buildSummary(category, operationLabel) {
  const label = operationLabel || '这一步'
  switch (category) {
    case 'missing_dependency':
      return `${label}失败，系统里缺少所需命令或依赖。`
    case 'permission':
      return `${label}失败，当前环境没有足够权限。`
    case 'timeout':
      return `${label}超时了，目标服务或命令在限定时间内没有完成。`
    case 'network':
      return `${label}失败，连接目标服务时中断或无法建立连接。`
    case 'authentication':
      return `${label}失败，当前凭据无效、缺失，或没有访问权限。`
    case 'rate_limit':
      return `${label}失败，请求触发了服务限流。`
    case 'unavailable':
      return `${label}失败，目标服务暂时不可用。`
    case 'not_found':
      return `${label}失败，目标工具、文件或资源不存在。`
    case 'invalid_input':
      return `${label}失败，请求参数或返回格式不符合预期。`
    case 'cancelled':
      return `${label}已被停止或拒绝执行。`
    case 'unsupported':
      return `${label}失败，当前环境或能力不支持这一步操作。`
    case 'execution_failed':
      return `${label}失败，执行过程返回了错误。`
    default:
      return `${label}失败。`
  }
}

function buildSuggestedAction(category) {
  switch (category) {
    case 'missing_dependency':
      return '请确认相关命令或依赖已经安装，并且应用可以在 PATH 中找到它。'
    case 'permission':
      return '请检查系统权限、工作区权限，或确认当前环境允许执行这一步操作。'
    case 'timeout':
      return '请稍后重试，或缩小本次操作范围。'
    case 'network':
      return '请检查网络连接，或确认目标服务当前可用。'
    case 'authentication':
      return '请检查 API Key、访问权限或当前账号配置。'
    case 'rate_limit':
      return '请稍后重试，或切换到其他可用模型 / 服务。'
    case 'unavailable':
      return '请稍后重试，或检查对应服务是否已经启动。'
    case 'not_found':
      return '请确认目标工具、文件、插件或 MCP 服务已经正确安装并启用。'
    case 'invalid_input':
      return '请检查本次传入参数、工具输入或服务返回格式。'
    case 'cancelled':
      return '如果还需要继续，可以重新执行这一步。'
    case 'unsupported':
      return '请切换到受支持的环境、模型或能力配置后再试。'
    default:
      return '请展开详细信息查看原始错误，再决定下一步操作。'
  }
}

export function createStructuredError(summary, extras = {}) {
  const rawMessage = extras.rawMessage || extras.detail || summary
  const error = new Error(summary)
  Object.assign(error, {
    code: extras.code,
    source: extras.source || 'system',
    rawMessage,
    status: extras.status,
    errorInfo: {
      source: extras.source || 'system',
      category: extras.category || 'unknown',
      code: extras.code,
      summary,
      detail: extras.detail || rawMessage,
      suggestedAction: extras.suggestedAction,
      retryable: extras.retryable,
    },
  })
  return error
}

export function normalizeRuntimeError(error, context = {}) {
  const rawMessage = extractRawMessage(error)
  const code = extractCode(error)
  const status = extractStatus(error)
  const source = extractSource(error, context.source || 'system')

  if (
    error &&
    typeof error === 'object' &&
    error.errorInfo &&
    typeof error.errorInfo === 'object'
  ) {
    return {
      code,
      source,
      rawMessage,
      message: error.errorInfo.summary || context.fallbackSummary || '执行失败。',
      errorInfo: {
        source,
        code,
        ...error.errorInfo,
      },
    }
  }

  const category = classifyError({ code, status, rawMessage })
  const summary =
    context.fallbackSummary || buildSummary(category, context.operationLabel)

  return {
    code,
    source,
    rawMessage,
    message: summary,
    errorInfo: {
      source,
      category,
      code,
      summary,
      detail: rawMessage,
      suggestedAction: buildSuggestedAction(category),
      retryable:
        category === 'timeout' ||
        category === 'network' ||
        category === 'rate_limit' ||
        category === 'unavailable',
    },
  }
}
