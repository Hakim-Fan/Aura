function normalizeFinalAnswer(message) {
  return (message || '').trim()
}

function resultClaimsExecution(message) {
  const normalized = normalizeFinalAnswer(message).toLowerCase()
  if (!normalized) {
    return false
  }

  return [
    'done',
    'completed',
    'already done',
    'installed',
    'configured',
    'created',
    'updated',
    'downloaded',
    'enabled',
    'wrote',
    'fixed',
    '已完成',
    '已经为你',
    '已经帮你',
    '完成',
    '已为你',
    '已帮你',
    '装好了',
    '配置好了',
    '创建了',
    '写入了',
    '修复了',
    '启用了',
  ].some(keyword => normalized.includes(keyword))
}

export function enforceEvidencePolicy(result, toolEvents, routeState) {
  const claimsExecution = resultClaimsExecution(result.message)
  if (!claimsExecution) {
    return result
  }

  if (routeState?.completionPolicy?.canClaimDone === false) {
    return {
      ...result,
      message:
        '这轮任务当前处在建议/诊断路径里，我不能把结果表述成“已经修复”或“已经完成”。如果你希望我实际执行修改或操作，我需要在获得对应能力后继续执行并验证结果。',
    }
  }

  if (
    routeState?.completionPolicy?.requiresEvidenceForDone !== true ||
    toolEvents.length > 0
  ) {
    return result
  }

  return {
    ...result,
    message:
      '我还没有执行任何工具，所以现在不能确认这项实际操作已经完成。要完成这类任务，我需要先运行相应工具并验证结果，然后再向你确认完成。',
  }
}
