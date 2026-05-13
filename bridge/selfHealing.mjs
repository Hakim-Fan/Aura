import {
  ToolExecutionError,
  ToolResult,
  ErrorCategory,
  ErrorSeverity,
  getRetryDelay,
  shouldRetry,
  buildToolErrorReport,
} from './toolErrors.mjs'
import { stringifyOutput } from './utils.mjs'

export const SelfHealingStrategy = {
  RETRY: 'retry',
  RECONSTRUCT_ARGS: 'reconstruct_args',
  ALTERNATIVE_TOOL: 'alternative_tool',
  REFRESH_AND_RETRY: 'refresh_and_retry',
  ESCALATE: 'escalate',
  DECOMPOSE: 'decompose',
  USER_DECISION: 'user_decision',
  FALLBACK_OR_SKIP: 'fallback_or_skip',
}

export const SelfHealingAction = {
  READ_FILE_FIRST: 'read_file_first',
  INSTALL_DEPENDENCY: 'install_dependency',
  SUGGEST_ALTERNATIVE: 'suggest_alternative',
  FIX_CREDENTIALS: 'fix_credentials',
  USER_APPROVAL: 'user_approval',
}

function buildRepairHintForCategory(category, error, toolName) {
  switch (category) {
    case ErrorCategory.TEXT_CONTEXT_MISMATCH:
      return {
        strategy: SelfHealingStrategy.REFRESH_AND_RETRY,
        action: SelfHealingAction.READ_FILE_FIRST,
        hint: `请先用 read_file 重新读取目标文件的最新内容，然后基于当前内容重新构造参数再执行 ${toolName}。`,
      }
    case ErrorCategory.PATCH_CONTEXT_MISMATCH:
      return {
        strategy: SelfHealingStrategy.REFRESH_AND_RETRY,
        action: SelfHealingAction.READ_FILE_FIRST,
        hint: `补丁上下文已失效。请先用 read_file 重新读取目标文件的最新内容，再基于当前内容生成新的补丁。`,
      }
    case ErrorCategory.MISSING_DEPENDENCY:
      return {
        strategy: SelfHealingStrategy.ESCALATE,
        action: SelfHealingAction.INSTALL_DEPENDENCY,
        hint: `缺少必要的依赖。请先安装缺失的命令或工具，然后再重试。`,
      }
    case ErrorCategory.INVALID_INPUT:
      return {
        strategy: SelfHealingStrategy.RECONSTRUCT_ARGS,
        action: null,
        hint: `输入参数格式不正确。请检查并修正 ${toolName} 的参数后重试。`,
      }
    case ErrorCategory.NOT_FOUND:
      return {
        strategy: SelfHealingStrategy.SUGGEST_ALTERNATIVE,
        action: SelfHealingAction.SUGGEST_ALTERNATIVE,
        hint: `工具 ${toolName} 未找到。请确认工具名称拼写正确，或使用其他替代工具完成相同任务。`,
      }
    case ErrorCategory.PERMISSION:
      return {
        strategy: SelfHealingStrategy.ESCALATE,
        action: SelfHealingAction.USER_APPROVAL,
        hint: `当前权限不足，无法执行 ${toolName}。请获取必要权限后重试，或联系管理员。`,
      }
    case ErrorCategory.AUTHENTICATION:
      return {
        strategy: SelfHealingStrategy.ESCALATE,
        action: SelfHealingAction.FIX_CREDENTIALS,
        hint: `认证失败。请检查 API Key、凭据或访问权限配置是否正确。`,
      }
    case ErrorCategory.UNSUPPORTED:
      return {
        strategy: SelfHealingStrategy.FALLBACK_OR_SKIP,
        action: null,
        hint: `当前环境或配置不支持 ${toolName}。请切换到受支持的环境或使用替代方案。`,
      }
    case ErrorCategory.TIMEOUT:
    case ErrorCategory.NETWORK:
    case ErrorCategory.RATE_LIMIT:
    case ErrorCategory.UNAVAILABLE:
      return {
        strategy: SelfHealingStrategy.RETRY,
        action: null,
        hint: `由于临时性问题，${toolName} 执行失败。建议稍后重试。`,
      }
    default:
      return {
        strategy: SelfHealingStrategy.RETRY,
        action: null,
        hint: `${toolName} 执行遇到问题，请检查错误详情后重试。`,
      }
  }
}

export class SelfHealingEngine {
  constructor(hooks = {}) {
    this.hooks = hooks
    this.healingHistory = []
  }

  generateRepairStrategy(error, toolName, context = {}) {
    if (!(error instanceof ToolExecutionError)) {
      return {
        strategy: SelfHealingStrategy.RETRY,
        retryable: true,
        hint: 'Unknown error, attempting retry.',
      }
    }

    const repairHint = buildRepairHintForCategory(error.category, error, toolName)

    return {
      strategy: repairHint.strategy,
      action: repairHint.action,
      hint: repairHint.hint,
      retryable: error.retryable,
      category: error.category,
      severity: error.severity,
      retryConfig: error.retryConfig,
      requiresApproval: repairHint.action === SelfHealingAction.USER_APPROVAL,
    }
  }

  async executeRepair(strategy, toolCall, originalArgs, context = {}) {
    const { strategy: repairStrategy, action, hint } = strategy

    this.recordHealingAttempt(toolCall.function.name, repairStrategy, action)

    switch (repairStrategy) {
      case SelfHealingStrategy.RETRY:
        return {
          shouldRetry: true,
          hint,
          strategy,
        }

      case SelfHealingStrategy.REFRESH_AND_RETRY:
        return {
          shouldRetry: false,
          hint: `${hint}\n\nAgent 指令：重新读取相关文件以获取最新内容，然后基于最新内容重新构造参数重试。`,
          strategy,
          requiresContextRefresh: true,
        }

      case SelfHealingStrategy.RECONSTRUCT_ARGS:
        return {
          shouldRetry: false,
          hint: `${hint}\n\nAgent 指令：分析原始输入参数的错误原因，重新构造正确的参数后重试。不要重复提交相同的错误参数。`,
          strategy,
          requiresArgReconstruction: true,
        }

      case SelfHealingStrategy.ALTERNATIVE_TOOL:
        return {
          shouldRetry: false,
          hint: `${hint}\n\nAgent 指令：评估是否有其他工具可以完成相同任务，如有则使用替代工具。`,
          strategy,
          requiresAlternativeSearch: true,
        }

      case SelfHealingStrategy.ESCALATE:
        if (action === SelfHealingAction.USER_APPROVAL) {
          return {
            shouldRetry: false,
            hint,
            strategy,
            requiresUserApproval: true,
          }
        }
        return {
          shouldRetry: false,
          hint,
          strategy,
          requiresEscalation: true,
        }

      case SelfHealingStrategy.DECOMPOSE:
        return {
          shouldRetry: false,
          hint: `${hint}\n\nAgent 指令：将当前任务分解为更小的子任务，逐一完成后再整合结果。`,
          strategy,
          requiresTaskDecomposition: true,
        }

      case SelfHealingStrategy.FALLBACK_OR_SKIP:
        return {
          shouldRetry: false,
          hint: `${hint}\n\nAgent 指令：如果有替代方案则使用，否则跳过此步骤继续后续任务。`,
          strategy,
          canSkip: true,
        }

      case SelfHealingStrategy.USER_DECISION:
        return {
          shouldRetry: false,
          hint,
          strategy,
          requiresUserDecision: true,
        }

      default:
        return {
          shouldRetry: false,
          hint,
          strategy,
        }
    }
  }

  recordHealingAttempt(toolName, strategy, action) {
    this.healingHistory.push({
      toolName,
      strategy,
      action,
      timestamp: Date.now(),
    })

    if (this.hooks.onHealingAttempt) {
      this.hooks.onHealingAttempt({ toolName, strategy, action })
    }
  }

  getHealingHistory() {
    return [...this.healingHistory]
  }

  clearHistory() {
    this.healingHistory = []
  }
}

export function createSelfHealingEngine(hooks) {
  return new SelfHealingEngine(hooks)
}

export async function handleToolFailureWithSelfHealing(
  toolCall,
  error,
  context = {},
  hooks = {},
) {
  const engine = createSelfHealingEngine(hooks)

  const strategy = engine.generateRepairStrategy(error, toolCall.function.name, context)

  const repairResult = await engine.executeRepair(
    strategy,
    toolCall,
    context,
  )

  return {
    strategy,
    repairResult,
    engine,
    canContinue: repairResult.shouldRetry || repairResult.requiresContextRefresh || repairResult.requiresArgReconstruction,
  }
}

export function injectRepairHintIntoMessages(messages, repairResult, toolName) {
  const hint = repairResult.hint
  if (!hint) return messages

  const lastMessage = messages[messages.length - 1]
  const repairNote = `\n\n[Self-Healing Note for ${toolName}]\n${hint}\n\n请根据上述提示解决工具执行问题，然后重试或继续执行任务。`

  if (lastMessage && lastMessage.role === 'user') {
    return [
      ...messages.slice(0, -1),
      {
        ...lastMessage,
        content: lastMessage.content + repairNote,
      },
    ]
  }

  return [
    ...messages,
    {
      role: 'user',
      content: repairNote,
    },
  ]
}

export function shouldEscalateAfterMaxRepairs(error, repairAttempts) {
  if (!(error instanceof ToolExecutionError)) return false

  const maxRepairAttempts = 3
  return repairAttempts >= maxRepairAttempts && error.severity === ErrorSeverity.PERMANENT
}

export function buildToolFailureSummary(toolName, errors, repairAttempts) {
  const uniqueCategories = [...new Set(errors.map(e => e.category))]
  const hasRetryable = errors.some(e => e.retryable)
  const hasPermanent = errors.some(e => e.severity === ErrorSeverity.PERMANENT)

  return {
    toolName,
    totalAttempts: repairAttempts,
    errorCount: errors.length,
    categories: uniqueCategories,
    hasRetryable,
    hasPermanent,
    recommendation: hasPermanent
      ? 'escalate'
      : hasRetryable
        ? 'retry_with_backoff'
        : 'skip',
  }
}