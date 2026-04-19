const READ_EFFECT_TOOLS = new Set([
  'list_files',
  'glob_files',
  'read_file',
  'search_code',
  'aura_list_capabilities',
  'aura_read_skill',
  'web_research',
  'web_search',
  'web_fetch',
  'browser_search',
  'browser_get_page',
  'browser_snapshot',
  'browser_inspect_element',
  'browser_screenshot',
  'browser_wait_for',
  'browser_list_sessions',
  'browser_storage_list',
  'browser_storage_get',
  'browser_storage_set',
  'browser_storage_clear',
  'browser_console_get',
  'browser_network_get',
  'browser_trace_start',
  'browser_trace_stop',
  'browser_video_start',
  'browser_video_stop',
  'computer_capture_screen',
  'computer_list_apps',
  'computer_get_frontmost_app',
])

const WRITE_EFFECT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'todo_write',
  'aura_enable_skill',
  'aura_enable_plugin',
  'aura_import_skill',
  'aura_import_plugin',
  'aura_upsert_mcp_server',
  'aura_remove_mcp_server',
  'browser_storage_export_state',
  'browser_storage_import_state',
  'browser_trace_stop',
  'browser_video_stop',
])

const EXECUTE_EFFECT_TOOLS = new Set([
  'run_shell',
  'computer_open_app',
  'computer_type_text',
  'computer_press_shortcut',
])

const BROWSER_EFFECT_TOOLS = new Set([
  'browser_open',
  'browser_click',
  'browser_type',
  'browser_takeover_visible',
  'browser_resume_after_takeover',
  'browser_get_page',
  'browser_snapshot',
  'browser_inspect_element',
  'browser_run_javascript',
  'browser_screenshot',
  'browser_wait_for',
  'browser_search',
  'browser_list_sessions',
  'browser_set_active_session',
  'browser_close_session',
  'browser_storage_list',
  'browser_storage_get',
  'browser_storage_set',
  'browser_storage_clear',
  'browser_storage_export_state',
  'browser_storage_import_state',
  'browser_console_get',
  'browser_network_get',
  'browser_trace_start',
  'browser_trace_stop',
  'browser_video_start',
  'browser_video_stop',
])

const PAGE_STATE_TOOLS = new Set([
  'browser_get_page',
  'browser_snapshot',
  'browser_inspect_element',
  'browser_run_javascript',
  'browser_wait_for',
  'browser_screenshot',
  'browser_storage_list',
  'browser_storage_get',
  'browser_storage_set',
  'browser_storage_clear',
  'browser_console_get',
  'browser_network_get',
  'browser_trace_start',
  'browser_trace_stop',
  'browser_video_start',
  'browser_video_stop',
])

const TEST_COMMAND_PATTERN =
  /\b(test|tests|testing|spec|specs|jest|vitest|mocha|ava|pytest|rspec|unittest|cargo test|cargo check|cargo clippy|pnpm test|pnpm lint|pnpm typecheck|npm test|npm run test|npm run lint|yarn test|go test|gradle test|mvn test)\b/i

function normalizeToolName(name) {
  return typeof name === 'string' ? name.trim() : ''
}

function isDeniedToolEvent(event) {
  return event?.errorInfo?.code === 'USER_DENIED'
}

function parseStructuredOutput(output) {
  if (typeof output !== 'string' || !output.trim()) {
    return null
  }

  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

function detectEffectTypes(event) {
  const name = normalizeToolName(event?.name)

  if (!name) {
    return []
  }

  if (READ_EFFECT_TOOLS.has(name)) {
    const effects = ['read']
    if (BROWSER_EFFECT_TOOLS.has(name)) {
      effects.push('browser')
    }
    return effects
  }

  if (WRITE_EFFECT_TOOLS.has(name)) {
    return ['write']
  }

  if (EXECUTE_EFFECT_TOOLS.has(name)) {
    return ['execute']
  }

  if (BROWSER_EFFECT_TOOLS.has(name)) {
    return ['browser']
  }

  if (name === 'route_request_escalation') {
    return ['plan']
  }

  if (event?.source === 'plugin' || event?.source === 'mcp' || event?.source === 'subagent') {
    return ['execute']
  }

  return []
}

function collectProducedEvidence(event, effectTypes) {
  const producedEvidence = []
  const name = normalizeToolName(event?.name)
  const denied = isDeniedToolEvent(event)
  const structuredOutput = parseStructuredOutput(event?.output)

  if (denied) {
    producedEvidence.push('user_denied')
    return producedEvidence
  }

  if (event?.status === 'success') {
    if (effectTypes.includes('write')) {
      producedEvidence.push('file_mutation')
    }

    if (name === 'run_shell') {
      producedEvidence.push('command_output', 'command_exit_0')
      if (TEST_COMMAND_PATTERN.test(String(event?.input || ''))) {
        producedEvidence.push('test_pass')
      }
    }

    if (name === 'browser_search') {
      producedEvidence.push('search_result')
    }

    if (name === 'web_search') {
      if (
        structuredOutput?.noResults !== true &&
        structuredOutput?.searchStopped !== true &&
        structuredOutput?.budgetExhausted !== true &&
        (!Array.isArray(structuredOutput?.results) || structuredOutput.results.length > 0)
      ) {
        producedEvidence.push('web_search_result')
      }
    }

    if (name === 'web_research') {
      if (
        structuredOutput?.noResults !== true &&
        structuredOutput?.searchStopped !== true &&
        structuredOutput?.budgetExhausted !== true &&
        (!Array.isArray(structuredOutput?.results) || structuredOutput.results.length > 0)
      ) {
        producedEvidence.push('web_research_result')
      }
    }

    if (name === 'web_fetch') {
      const contentFormat =
        structuredOutput &&
        typeof structuredOutput === 'object' &&
        typeof structuredOutput.contentFormat === 'string'
          ? structuredOutput.contentFormat
          : ''
      producedEvidence.push(
        contentFormat === 'text' ? 'web_fetch_summary' : 'web_fetch_content',
      )
    }

    if (PAGE_STATE_TOOLS.has(name)) {
      producedEvidence.push('page_state')
    }
  }

  if (event?.status === 'error' && name === 'run_shell' && TEST_COMMAND_PATTERN.test(String(event?.input || ''))) {
    producedEvidence.push('test_fail')
  }

  return producedEvidence
}

function inferVerificationLevel(event, effectTypes, producedEvidence) {
  if (producedEvidence.includes('test_pass')) {
    return 'verified'
  }

  if (
    producedEvidence.includes('web_search_result') ||
    producedEvidence.includes('web_research_result') ||
    producedEvidence.includes('web_fetch_content') ||
    producedEvidence.includes('web_fetch_summary')
  ) {
    return 'partial'
  }

  if (
    producedEvidence.includes('page_state') ||
    (event?.status === 'success' && effectTypes.includes('browser') && effectTypes.length > 0)
  ) {
    return 'partial'
  }

  return 'none'
}

export function collectEvidenceFromToolEvents(toolEvents = []) {
  const records = []

  for (const event of Array.isArray(toolEvents) ? toolEvents : []) {
    const effectTypes = detectEffectTypes(event)
    if (effectTypes.length === 0) {
      continue
    }

    const producedEvidence = collectProducedEvidence(event, effectTypes)
    const denied = isDeniedToolEvent(event)
    const verificationLevel = inferVerificationLevel(event, effectTypes, producedEvidence)
    records.push({
      toolName: normalizeToolName(event.name),
      source: event.source || 'builtin',
      status: denied ? 'denied' : event.status === 'error' ? 'error' : 'success',
      effectTypes,
      producedEvidence,
      verificationLevel,
      detail: event.errorInfo?.summary || event.summary || undefined,
    })
  }

  return {
    records,
    hasAnyExecution: records.some(record =>
      record.effectTypes.some(
        effectType =>
          effectType === 'write' || effectType === 'execute' || effectType === 'browser',
      ),
    ),
    hasWriteEffect: records.some(record => record.effectTypes.includes('write')),
    hasBrowserEffect: records.some(record => record.effectTypes.includes('browser')),
    hasVerifiedEvidence: records.some(record => record.verificationLevel === 'verified'),
    hasApprovalBlock: records.some(record => record.status === 'denied'),
    hasCapabilityBlock: false,
    hasExecutionFailure: records.some(
      record =>
        record.status === 'error' &&
        record.effectTypes.some(
          effectType =>
            effectType === 'write' || effectType === 'execute' || effectType === 'browser',
        ),
    ),
  }
}

export function deriveCompletionState(routeState, evidenceSummary, runtimeBlocks = {}) {
  if (routeState?.answerMode !== 'execute') {
    return 'not_executed'
  }

  if (runtimeBlocks.hasApprovalBlock === true || evidenceSummary.hasApprovalBlock) {
    return 'blocked_by_approval'
  }

  if (runtimeBlocks.hasCapabilityBlock === true || evidenceSummary.hasCapabilityBlock) {
    return 'blocked_by_capability'
  }

  if (!evidenceSummary.hasAnyExecution) {
    return 'not_executed'
  }

  if (evidenceSummary.hasExecutionFailure) {
    return 'failed_after_execution'
  }

  if (!evidenceSummary.hasVerifiedEvidence) {
    return 'executed_unverified'
  }

  return 'executed_verified'
}

export function buildDeliveryPolicy(completionState) {
  switch (completionState) {
    case 'blocked_by_approval':
      return {
        allowedWording:
          'Explain that execution is blocked on approval. Do not claim the requested operation is completed.',
        deliveryNote:
          '系统完成态：等待审批。任务需要继续执行，但本轮被审批阻塞，所以正文不能视为已完成的实际操作。',
      }
    case 'blocked_by_capability':
      return {
        allowedWording:
          'Summarize what you could establish from the available evidence, describe the remaining uncertainty in user-facing terms, and give the best next step. Do not mention internal budgets, route tiers, or pass limits. Do not claim completion.',
        deliveryNote:
          '系统完成态：能力受限。当前只能基于已有证据收束回答；不要把内部预算、层级或路由机制暴露给用户。',
      }
    case 'failed_after_execution':
      return {
        allowedWording:
          'Describe what was attempted and where it failed. Do not claim the task is completed.',
        deliveryNote:
          '系统完成态：执行失败。已经发生过实际操作，但过程中出现失败，因此目前不能确认任务已经完成。',
      }
    case 'executed_unverified':
      return {
        allowedWording:
          'Describe what was changed or executed, but do not claim the task is fully completed without verification.',
        deliveryNote:
          '系统完成态：已执行未验证。系统记录到实际执行，但还缺少足够的验证证据，所以暂时不能确认任务已经全部完成。',
      }
    case 'executed_verified':
      return {
        allowedWording:
          'You may confirm completion and summarize the verification evidence.',
        deliveryNote: undefined,
      }
    case 'not_executed':
    default:
      return {
        allowedWording:
          'Provide analysis, findings, and next steps. Do not claim the requested operation is completed.',
        deliveryNote:
          '系统完成态：未执行。正文可以作为分析、方案或下一步建议阅读，但不应被理解为已经完成了实际操作。',
      }
  }
}

export function applyCompletionPolicy(result, completionState, evidenceSummary, routeState) {
  const deliveryPolicy = buildDeliveryPolicy(completionState)
  return {
    ...result,
    completionState,
    evidenceSummary,
    deliveryNote:
      routeState?.answerMode === 'execute' ? deliveryPolicy.deliveryNote : undefined,
  }
}

export function enforceEvidencePolicy(result, toolEvents, routeState, runtimeBlocks = {}) {
  const baseSummary = collectEvidenceFromToolEvents(toolEvents)
  const evidenceSummary = {
    ...baseSummary,
    hasApprovalBlock:
      runtimeBlocks.hasApprovalBlock === true || baseSummary.hasApprovalBlock,
    hasCapabilityBlock:
      runtimeBlocks.hasCapabilityBlock === true || baseSummary.hasCapabilityBlock,
  }
  const completionState = deriveCompletionState(routeState, evidenceSummary, runtimeBlocks)
  return applyCompletionPolicy(result, completionState, evidenceSummary, routeState)
}
