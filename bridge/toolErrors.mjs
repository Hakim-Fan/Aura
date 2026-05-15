export const ErrorSeverity = {
  TRANSIENT: 'transient',
  PERMANENT: 'permanent',
  FATAL: 'fatal',
}

export const ErrorCategory = {
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  RATE_LIMIT: 'rate_limit',
  UNAVAILABLE: 'unavailable',
  PERMISSION: 'permission',
  NOT_FOUND: 'not_found',
  INVALID_INPUT: 'invalid_input',
  MISSING_DEPENDENCY: 'missing_dependency',
  TEXT_CONTEXT_MISMATCH: 'text_context_mismatch',
  PATCH_CONTEXT_MISMATCH: 'patch_context_mismatch',
  CANCELLED: 'cancelled',
  UNSUPPORTED: 'unsupported',
  AUTHENTICATION: 'authentication',
  EXECUTION_FAILED: 'execution_failed',
  UNKNOWN: 'unknown',
}

export const RetryStrategy = {
  NONE: 'none',
  EXPONENTIAL_BACKOFF: 'exponential_backoff',
  LINEAR_BACKOFF: 'linear_backoff',
  IMMEDIATE: 'immediate',
}

export const DEFAULT_TOOL_RETRY_CONFIG = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  retryStrategy: RetryStrategy.EXPONENTIAL_BACKOFF,
}

export const ERROR_RETRY_STRATEGY_MAP = {
  [ErrorCategory.TIMEOUT]: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    retryStrategy: RetryStrategy.EXPONENTIAL_BACKOFF,
  },
  [ErrorCategory.NETWORK]: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 500,
    maxDelayMs: 8000,
    backoffMultiplier: 2,
    retryStrategy: RetryStrategy.EXPONENTIAL_BACKOFF,
  },
  [ErrorCategory.RATE_LIMIT]: {
    retryable: true,
    maxRetries: 5,
    initialDelayMs: 2000,
    maxDelayMs: 30000,
    backoffMultiplier: 1.5,
    retryStrategy: RetryStrategy.LINEAR_BACKOFF,
  },
  [ErrorCategory.UNAVAILABLE]: {
    retryable: true,
    maxRetries: 3,
    initialDelayMs: 2000,
    maxDelayMs: 15000,
    backoffMultiplier: 2,
    retryStrategy: RetryStrategy.EXPONENTIAL_BACKOFF,
  },
  [ErrorCategory.PERMISSION]: {
    retryable: false,
    strategy: 'escalate_to_user',
    requiresApproval: true,
  },
  [ErrorCategory.NOT_FOUND]: {
    retryable: false,
    strategy: 'suggest_alternative',
  },
  [ErrorCategory.INVALID_INPUT]: {
    retryable: false,
    strategy: 'reconstruct_args',
  },
  [ErrorCategory.MISSING_DEPENDENCY]: {
    retryable: false,
    strategy: 'install_dependency',
  },
  [ErrorCategory.TEXT_CONTEXT_MISMATCH]: {
    retryable: false,
    strategy: 'refresh_and_retry',
    action: 'read_file_first',
  },
  [ErrorCategory.PATCH_CONTEXT_MISMATCH]: {
    retryable: false,
    strategy: 'refresh_and_retry',
    action: 'read_file_first',
  },
  [ErrorCategory.CANCELLED]: {
    retryable: false,
    strategy: 'user_decision',
  },
  [ErrorCategory.UNSUPPORTED]: {
    retryable: false,
    strategy: 'fallback_or_skip',
  },
  [ErrorCategory.AUTHENTICATION]: {
    retryable: false,
    strategy: 'fix_credentials',
  },
  [ErrorCategory.EXECUTION_FAILED]: {
    retryable: true,
    maxRetries: 1,
    initialDelayMs: 500,
    maxDelayMs: 3000,
    backoffMultiplier: 2,
    retryStrategy: RetryStrategy.EXPONENTIAL_BACKOFF,
  },
}

export class ToolExecutionError extends Error {
  constructor({
    toolName,
    category,
    severity,
    detail,
    suggestedAction,
    repairHint,
    originalError,
    retryable,
    retryConfig,
  }) {
    super(detail || `Tool ${toolName} execution failed`)
    this.name = 'ToolExecutionError'
    this.toolName = toolName
    this.category = category || ErrorCategory.UNKNOWN
    this.severity = severity || ErrorSeverity.TRANSIENT
    this.retryable = retryable
    this.retryConfig = retryConfig
    this.suggestedAction = suggestedAction
    this.repairHint = repairHint
    this.originalError = originalError
    this.timestamp = Date.now()

    if (originalError instanceof Error) {
      this.stack = originalError.stack
    }
  }

  toStructuredReport() {
    return {
      name: this.name,
      toolName: this.toolName,
      category: this.category,
      severity: this.severity,
      message: this.message,
      detail: this.message,
      suggestedAction: this.suggestedAction,
      repairHint: this.repairHint,
      retryable: this.retryable,
      retryConfig: this.retryConfig,
      timestamp: this.timestamp,
    }
  }

  static fromNormalizedError(normalized, toolName) {
    const strategy = ERROR_RETRY_STRATEGY_MAP[normalized.errorInfo?.category] || {}

    let severity = ErrorSeverity.TRANSIENT
    if (!strategy.retryable) {
      severity = strategy.strategy === 'escalate_to_user' || strategy.strategy === 'fix_credentials'
        ? ErrorSeverity.PERMANENT
        : ErrorSeverity.PERMANENT
    }

    return new ToolExecutionError({
      toolName,
      category: normalized.errorInfo?.category || ErrorCategory.UNKNOWN,
      severity,
      detail: normalized.errorInfo?.detail || normalized.rawMessage || 'Unknown error',
      suggestedAction: normalized.errorInfo?.suggestedAction,
      repairHint: normalized.errorInfo?.repairHint,
      originalError: normalized,
      retryable: strategy.retryable ?? false,
      retryConfig: strategy.retryable
        ? {
            maxRetries: strategy.maxRetries ?? DEFAULT_TOOL_RETRY_CONFIG.maxRetries,
            initialDelayMs: strategy.initialDelayMs ?? DEFAULT_TOOL_RETRY_CONFIG.initialDelayMs,
            maxDelayMs: strategy.maxDelayMs ?? DEFAULT_TOOL_RETRY_CONFIG.maxDelayMs,
            backoffMultiplier: strategy.backoffMultiplier ?? DEFAULT_TOOL_RETRY_CONFIG.backoffMultiplier,
            retryStrategy: strategy.retryStrategy ?? DEFAULT_TOOL_RETRY_CONFIG.retryStrategy,
          }
        : null,
    })
  }
}

export class ToolResult {
  constructor({ success, output, error, toolName, toolCallId, attempt }) {
    this.success = success
    this.output = output
    this.error = error
    this.toolName = toolName
    this.toolCallId = toolCallId
    this.attempt = attempt || 1
    this.timestamp = Date.now()
  }

  isRetryableFailure() {
    return !this.success && this.error instanceof ToolExecutionError && this.error.retryable
  }

  toToolEventEntry() {
    if (this.success) {
      return {
        name: this.toolName,
        status: 'success',
        output: typeof this.output === 'string' ? this.output : JSON.stringify(this.output),
        toolCallId: this.toolCallId,
        attempt: this.attempt,
      }
    }
    return {
      name: this.toolName,
      status: 'error',
      error: this.error instanceof ToolExecutionError ? this.error.message : String(this.error),
      errorInfo: this.error instanceof ToolExecutionError ? this.error.toStructuredReport() : undefined,
      toolCallId: this.toolCallId,
      attempt: this.attempt,
    }
  }
}

export function classifyToolError(normalizedError) {
  const category = normalizedError?.errorInfo?.category || ErrorCategory.UNKNOWN
  const strategy = ERROR_RETRY_STRATEGY_MAP[category] || {}

  return {
    category,
    retryable: strategy.retryable ?? false,
    strategy: strategy.strategy || 'unknown',
    action: strategy.action || null,
    requiresApproval: strategy.requiresApproval || false,
  }
}

export function getRetryDelay(attempt, retryConfig) {
  if (!retryConfig) return 0

  const { initialDelayMs, maxDelayMs, backoffMultiplier, retryStrategy } = retryConfig

  let delay
  if (retryStrategy === RetryStrategy.EXPONENTIAL_BACKOFF) {
    delay = Math.min(initialDelayMs * Math.pow(backoffMultiplier, attempt - 1), maxDelayMs)
  } else if (retryStrategy === RetryStrategy.LINEAR_BACKOFF) {
    delay = Math.min(initialDelayMs * attempt, maxDelayMs)
  } else {
    delay = initialDelayMs
  }

  const jitter = delay * 0.1 * Math.random()
  return Math.floor(delay + jitter)
}

export function shouldRetry(toolExecutionError, currentAttempt) {
  if (!toolExecutionError?.retryable) return false
  if (!toolExecutionError?.retryConfig) return false
  return currentAttempt <= toolExecutionError.retryConfig.maxRetries
}

export function mergeToolErrors(existing, incoming) {
  if (!existing) return incoming
  if (!incoming) return existing

  return new ToolExecutionError({
    toolName: incoming.toolName || existing.toolName,
    category: incoming.category || existing.category,
    severity: incoming.severity || existing.severity,
    detail: incoming.detail || existing.detail,
    suggestedAction: incoming.suggestedAction || existing.suggestedAction,
    repairHint: incoming.repairHint || existing.repairHint,
    originalError: incoming.originalError || existing.originalError,
    retryable: incoming.retryable !== undefined ? incoming.retryable : existing.retryable,
    retryConfig: incoming.retryConfig || existing.retryConfig,
  })
}

export function buildToolErrorReport(toolName, error, attempt, maxRetries) {
  const report = {
    toolName,
    attempt,
    maxRetries,
    timestamp: Date.now(),
  }

  if (error instanceof ToolExecutionError) {
    return {
      ...report,
      ...error.toStructuredReport(),
    }
  }

  return {
    ...report,
    category: ErrorCategory.UNKNOWN,
    severity: ErrorSeverity.TRANSIENT,
    message: String(error),
    detail: String(error),
    retryable: false,
  }
}
