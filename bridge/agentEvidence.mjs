const READ_EFFECT_TOOLS = new Set([
  'list_files',
  'glob_files',
  'read_file',
  'read_block',
  'search_code',
  'verify_artifact',
  'aura_list_capabilities',
  'aura_read_skill',
  'web_research',
  'web_search',
  'web_fetch',
  'computer_capture_screen',
  'computer_list_apps',
  'computer_get_frontmost_app',
])

const WRITE_EFFECT_TOOLS = new Set([
  'write_file',
  'apply_patch',
  'edit_file',
  'multi_edit_file',
  'replace_line_range',
  'aura_enable_skill',
  'aura_enable_plugin',
  'aura_import_skill',
  'aura_import_plugin',
  'aura_upsert_mcp_server',
  'aura_remove_mcp_server',
])

const EXECUTE_EFFECT_TOOLS = new Set([
  'run_shell',
  'exec_command',
  'write_stdin',
  'computer_open_app',
  'computer_type_text',
  'computer_press_shortcut',
])

const BROWSER_EFFECT_TOOLS = new Set([
  'system_browser_open',
])

const PAGE_STATE_TOOLS = new Set([
  'computer_capture_screen',
])

const TEST_COMMAND_PATTERN =
  /\b(test|tests|testing|spec|specs|jest|vitest|mocha|ava|pytest|rspec|unittest|cargo test|cargo check|cargo clippy|pnpm test|pnpm lint|pnpm typecheck|npm test|npm run test|npm run lint|yarn test|go test|gradle test|mvn test)\b/i

const COMMAND_SESSION_TOOLS = new Set([
  'run_shell',
  'exec_command',
  'write_stdin',
])

function normalizeToolName(name) {
  return typeof name === 'string' ? name.trim() : ''
}

function isDeniedToolEvent(event) {
  return event?.errorInfo?.code === 'USER_DENIED'
}

function parseStructuredOutput(output) {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output
  }

  if (typeof output !== 'string' || !output.trim()) {
    return null
  }

  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

function isArtifactRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.path === 'string' &&
    (
      Object.prototype.hasOwnProperty.call(value, 'verified') ||
      Object.prototype.hasOwnProperty.call(value, 'exists') ||
      Object.prototype.hasOwnProperty.call(value, 'readBackOk') ||
      Object.prototype.hasOwnProperty.call(value, 'sha256') ||
      Object.prototype.hasOwnProperty.call(value, 'removed')
    )
  )
}

function extractArtifactRecords(structuredOutput) {
  if (!structuredOutput || typeof structuredOutput !== 'object') {
    return []
  }

  return [
    isArtifactRecord(structuredOutput) ? structuredOutput : null,
    isArtifactRecord(structuredOutput.verification) ? structuredOutput.verification : null,
    ...(Array.isArray(structuredOutput.files) ? structuredOutput.files.filter(isArtifactRecord) : []),
    ...(Array.isArray(structuredOutput.results)
      ? structuredOutput.results.filter(isArtifactRecord)
      : []),
  ].filter(Boolean)
}

function summarizeArtifactVerification(structuredOutput) {
  const artifacts = extractArtifactRecords(structuredOutput)

  return {
    verifiedCount: artifacts.filter(artifact => artifact.verified === true).length,
    hasPresentArtifact: artifacts.some(artifact => artifact.exists === true),
    hasReadBack: artifacts.some(artifact => artifact.readBackOk === true),
    hasHash: artifacts.some(
      artifact => typeof artifact.sha256 === 'string' && artifact.sha256.trim(),
    ),
    paths: Array.from(
      new Set(
        artifacts
          .map(artifact => artifact.path)
          .filter(pathValue => typeof pathValue === 'string' && pathValue.trim()),
      ),
    ),
  }
}

function detectEffectTypes(event) {
  const name = normalizeToolName(event?.name)

  if (!name) {
    return []
  }

  if (name === 'todo_write') {
    return ['plan']
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
  const structuredOutput = parseStructuredOutput(event?.structuredOutput || event?.output)
  const artifactVerification = summarizeArtifactVerification(structuredOutput)

  if (denied) {
    producedEvidence.push('user_denied')
    return producedEvidence
  }

  if (event?.status === 'success') {
    if (effectTypes.includes('write')) {
      producedEvidence.push('file_mutation')
      if (artifactVerification.verifiedCount > 0) {
        producedEvidence.push('file_verified')
      }
      if (artifactVerification.hasPresentArtifact) {
        producedEvidence.push('artifact_present')
      }
      if (artifactVerification.hasReadBack) {
        producedEvidence.push('artifact_read_back')
      }
      if (artifactVerification.hasHash) {
        producedEvidence.push('artifact_hash_recorded')
      }
    }

    if (name === 'verify_artifact') {
      if (artifactVerification.verifiedCount > 0) {
        producedEvidence.push('file_verified')
      }
      if (artifactVerification.hasPresentArtifact) {
        producedEvidence.push('artifact_present')
      }
      if (artifactVerification.hasReadBack) {
        producedEvidence.push('artifact_read_back')
      }
      if (artifactVerification.hasHash) {
        producedEvidence.push('artifact_hash_recorded')
      }
    }

    if (COMMAND_SESSION_TOOLS.has(name)) {
      producedEvidence.push('command_output')
      if (
        structuredOutput &&
        typeof structuredOutput === 'object' &&
        Object.prototype.hasOwnProperty.call(structuredOutput, 'sessionId')
      ) {
        producedEvidence.push('command_session')
      }
      if (
        structuredOutput &&
        typeof structuredOutput === 'object' &&
        structuredOutput.running === false &&
        structuredOutput.exitCode === 0
      ) {
        producedEvidence.push('command_exit_0')
      } else if (
        structuredOutput &&
        typeof structuredOutput === 'object' &&
        structuredOutput.running === false &&
        typeof structuredOutput.exitCode === 'number' &&
        structuredOutput.exitCode !== 0
      ) {
        producedEvidence.push('command_exit_nonzero')
      }
      if (
        structuredOutput &&
        typeof structuredOutput === 'object' &&
        structuredOutput.timedOut === true
      ) {
        producedEvidence.push('command_timeout')
      }
      if (TEST_COMMAND_PATTERN.test(String(event?.input || ''))) {
        if (
          structuredOutput &&
          typeof structuredOutput === 'object' &&
          structuredOutput.running === false &&
          structuredOutput.exitCode === 0
        ) {
          producedEvidence.push('test_pass')
        }
      }
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

  if (
    event?.status === 'error' &&
    COMMAND_SESSION_TOOLS.has(name) &&
    TEST_COMMAND_PATTERN.test(String(event?.input || ''))
  ) {
    producedEvidence.push('test_fail')
  }

  return producedEvidence
}

function inferVerificationLevel(event, effectTypes, producedEvidence) {
  if (producedEvidence.includes('file_verified')) {
    return 'verified'
  }

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
  const artifactPaths = new Set()
  let verifiedArtifactCount = 0

  for (const event of Array.isArray(toolEvents) ? toolEvents : []) {
    const effectTypes = detectEffectTypes(event)
    if (effectTypes.length === 0) {
      continue
    }

    const producedEvidence = collectProducedEvidence(event, effectTypes)
    const denied = isDeniedToolEvent(event)
    const verificationLevel = inferVerificationLevel(event, effectTypes, producedEvidence)
    const artifactVerification = summarizeArtifactVerification(
      parseStructuredOutput(event?.structuredOutput || event?.output),
    )
    verifiedArtifactCount += artifactVerification.verifiedCount
    for (const artifactPath of artifactVerification.paths) {
      artifactPaths.add(artifactPath)
    }
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

  const hasExecutionFailure = hasUnresolvedExecutionFailure(records)

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
    hasFileVerification: verifiedArtifactCount > 0,
    verifiedArtifactCount,
    artifactPaths: Array.from(artifactPaths),
    hasSuccessfulCommand: records.some(
      record =>
        (record.toolName === 'run_shell' ||
          record.toolName === 'exec_command' ||
          record.toolName === 'write_stdin') &&
        record.status === 'success' &&
        record.producedEvidence.includes('command_exit_0'),
    ),
    hasSuccessfulBrowserAction: records.some(
      record => record.status === 'success' && record.effectTypes.includes('browser'),
    ),
    hasVerifiedEvidence: records.some(record => record.verificationLevel === 'verified'),
    hasApprovalBlock: records.some(record => record.status === 'denied'),
    hasCapabilityBlock: false,
    hasExecutionFailure,
  }
}

function hasUnresolvedExecutionFailure(records) {
  const unresolved = {
    write: false,
    execute: false,
    browser: false,
  }

  for (const record of records) {
    const failed =
      (
        record.status === 'error' &&
        record.effectTypes.some(
          effectType =>
            effectType === 'write' ||
            effectType === 'execute' ||
            effectType === 'browser',
        )
      ) ||
      record.producedEvidence.includes('command_timeout')

    if (failed) {
      if (record.effectTypes.includes('write')) {
        unresolved.write = true
      }
      if (record.effectTypes.includes('execute')) {
        unresolved.execute = true
      }
      if (record.effectTypes.includes('browser')) {
        unresolved.browser = true
      }
      continue
    }

    if (record.status !== 'success') {
      continue
    }

    if (record.effectTypes.includes('write')) {
      unresolved.write = false
    }
    if (record.effectTypes.includes('execute')) {
      unresolved.execute = false
    }
    if (record.effectTypes.includes('browser')) {
      unresolved.browser = false
    }
  }

  return unresolved.write || unresolved.execute || unresolved.browser
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

  if (
    evidenceSummary.hasWriteEffect &&
    !evidenceSummary.hasFileVerification &&
    !evidenceSummary.hasVerifiedEvidence
  ) {
    return 'executed_unverified'
  }

  if (
    !evidenceSummary.hasVerifiedEvidence &&
    !evidenceSummary.hasFileVerification &&
    !evidenceSummary.hasSuccessfulBrowserAction &&
    !(
      evidenceSummary.hasSuccessfulCommand &&
      evidenceSummary.hasWriteEffect !== true
    )
  ) {
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
