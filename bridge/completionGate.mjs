function normalizeText(value) {
  return String(value || '').trim()
}

function messageClaimsCompletion(message) {
  const normalized = normalizeText(message).toLowerCase()
  if (!normalized) {
    return false
  }

  return (
    /\b(done|completed|finished|fixed|resolved|implemented|updated|created|written)\b/u.test(
      normalized,
    ) ||
    /(已完成|已经完成|搞定了|已修复|已经修复|已实现|已经实现|已更新|已经更新|已创建|已经创建|已写好|已经写好|已修改|已经修改)/u.test(
      normalized,
    )
  )
}

function buildGateLead(completionState) {
  switch (completionState) {
    case 'blocked_by_approval':
      return '这轮执行被审批拦住了，所以任务现在还不能算完成。'
    case 'blocked_by_capability':
      return '当前能力不足以把这项任务真正做完，所以现在还不能视为已完成。'
    case 'failed_after_execution':
      return '我已经尝试执行，但过程中出现失败，所以目前不能确认任务已完成。'
    case 'executed_unverified':
      return '我已经执行了相关操作，但当前还缺少系统级验证证据，所以不能直接把任务标记为已完成。'
    case 'not_executed':
    default:
      return '这轮还没有形成足够的实际执行证据，所以任务不能视为已完成。'
  }
}

function stripLeadingCompletionClaim(message) {
  const normalized = normalizeText(message)
  if (!normalized) {
    return normalized
  }

  return normalized
    .replace(/^(已完成|已经完成|已修复|已经修复|已实现|已经实现|已更新|已经更新|已创建|已经创建|已写好|已经写好)[，。:\s-]*/u, '')
    .replace(/^(done|completed|finished|fixed|resolved|implemented|updated|created|written)[\s:,-]*/iu, '')
    .trim()
}

export function applyCompletionGate(result, routeState) {
  if (routeState?.answerMode !== 'execute') {
    return result
  }

  if (result?.completionState === 'executed_verified') {
    return result
  }

  const nextMessage = normalizeText(result?.message)
  if (!nextMessage) {
    return {
      ...result,
      message: buildGateLead(result?.completionState),
    }
  }

  if (!messageClaimsCompletion(nextMessage)) {
    return result
  }

  const stripped = stripLeadingCompletionClaim(nextMessage)
  const lead = buildGateLead(result?.completionState)

  return {
    ...result,
    message: stripped ? `${lead}\n\n${stripped}` : lead,
  }
}
