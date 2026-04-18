function getBrowserSourceLabel(source) {
  switch (source) {
    case 'managed-chrome':
      return 'Aura managed browser'
    case 'custom-executable':
      return 'custom browser executable'
    case 'system-chrome':
    default:
      return 'system Chrome'
  }
}

function isBrowserSourceAvailable(settings) {
  const source = settings.browser?.source
  const status = settings.browserRuntimeStatus
  if (!status || !source) {
    return null
  }

  switch (source) {
    case 'managed-chrome':
      return status.managedChromeInstalled === true
    case 'custom-executable':
      return status.customExecutableValid === true
    case 'system-chrome':
    default:
      return status.systemChromeDetected === true
  }
}

function buildCurrentDateContext() {
  const now = new Date()
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'system local timezone'
  const absoluteDate = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
    timeStyle: 'long',
    timeZone: timezone,
  }).format(now)
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

  return [
    `Current local datetime: ${absoluteDate}.`,
    `Current local date: ${isoDate}.`,
    `Current timezone: ${timezone}.`,
    'When the user says today, tomorrow, yesterday, latest, current, or this week, resolve it from the current local date above instead of relying on model-internal dates.',
  ].join('\n')
}

function buildApprovalPolicy(settings) {
  const lines = [
    `Approval policy: shell is ${settings.autoApproveShell ? 'auto-approved' : 'approval-required'}.`,
    `Approval policy: file writes are ${settings.autoApproveFileWrite ? 'auto-approved' : 'approval-required'}.`,
    `Approval policy: computer use is ${settings.autoApproveComputerUse ? 'auto-approved' : 'approval-required'}.`,
  ]

  if (settings.enableChromeAutomation) {
    lines.push(
      `Approval policy: chrome automation is ${settings.autoApproveChromeAutomation ? 'auto-approved' : 'approval-required'}.`,
    )
  }

  return lines.join('\n')
}

function buildReasoningInstruction(settings) {
  const reasoningInstructions = {
    off: 'Reasoning intensity: off. Prefer fast, concise answers and avoid extended internal exploration unless the task clearly requires it.',
    low: 'Reasoning intensity: low. Optimize for speed and keep reasoning lightweight.',
    medium: 'Reasoning intensity: medium. Balance speed and reasoning depth.',
    high: 'Reasoning intensity: high. Spend more effort on analysis before acting, especially for complex tasks.',
    max: 'Reasoning intensity: maximum. Use your deepest available reasoning for difficult tasks, while still avoiding unnecessary repetition.',
  }

  return reasoningInstructions[settings.reasoningEffort] || reasoningInstructions.medium
}

export function buildCapabilityExposureNote(snapshot, routeState) {
  const lines = ['Only task-relevant optional capabilities are exposed for this turn.']

  if (routeState) {
    lines.push(
      `Current answer mode: ${routeState.answerMode}. Current capability tier: ${routeState.capabilityTier}.`,
    )
    if (routeState.budgets?.searchesRemaining >= 0) {
      lines.push(
        `Budget status: searches remaining ${routeState.budgets.searchesRemaining}.`,
      )
    }
    if (routeState.budgets?.writeEscalationsRemaining >= 0) {
      lines.push(
        `Budget status: write escalations remaining ${routeState.budgets.writeEscalationsRemaining}.`,
      )
    }
    if (routeState.budgets?.browserEscalationsRemaining >= 0) {
      lines.push(
        `Budget status: browser escalations remaining ${routeState.budgets.browserEscalationsRemaining}.`,
      )
    }
    if (Array.isArray(routeState.availableEscalations) && routeState.availableEscalations.length > 0) {
      lines.push(`Allowed route escalations for this turn: ${routeState.availableEscalations.join(', ')}.`)
    }
  }

  const items = [
    snapshot?.skills?.length ? `skills ${snapshot.skills.length}` : null,
    snapshot?.plugins?.length ? `plugins ${snapshot.plugins.length}` : null,
    snapshot?.mcpServers?.length ? `mcp ${snapshot.mcpServers.length}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  if (items) {
    lines.push(`Selected optional capabilities: ${items}.`)
  }

  if (snapshot?.mcpServers?.length) {
    const names = snapshot.mcpServers.map(server => server.name).filter(Boolean).join(', ')
    lines.push(
      `Selected MCP servers for this turn: ${names}. Their tools are already mounted in the tool list for this turn, so call them directly when relevant instead of saying MCP must be invoked by an external client.`,
    )
  }

  return lines.join('\n')
}

export function buildRouteFirstSystemPrompt(settings, skillPrompt, exposureNote, routeState) {
  const sections = [
    'You are Aura, a local-first desktop coding agent.',
    `The active workspace is: ${settings.cwd}`,
    buildCurrentDateContext(),
    'Answer directly when your current knowledge or the mounted local context is sufficient.',
    'Use only the currently mounted tools when they materially reduce uncertainty or let you act directly on the user request.',
    'Do not claim that something is fixed, installed, configured, created, or completed unless the current run produced direct evidence.',
    'Do not access paths outside the configured workspace root.',
    'If the user includes image attachments, treat them as already provided visual input. Do not read PNG/JPG/WebP files as plain text unless the user explicitly asks for raw file inspection or metadata.',
    buildApprovalPolicy(settings),
    buildReasoningInstruction(settings),
  ]

  if (routeState) {
    sections.push(
      [
        `Current answer mode: ${routeState.answerMode}.`,
        `Current capability tier: ${routeState.capabilityTier}.`,
        `Current search budget remaining: ${routeState.budgets?.searchesRemaining ?? 0}.`,
        `Current write escalation budget remaining: ${routeState.budgets?.writeEscalationsRemaining ?? 0}.`,
        `Current browser escalation budget remaining: ${routeState.budgets?.browserEscalationsRemaining ?? 0}.`,
      ].join('\n'),
    )

    if (Array.isArray(routeState.availableEscalations) && routeState.availableEscalations.length > 0) {
      sections.push(
        `Allowed escalation targets for this turn: ${routeState.availableEscalations.join(', ')}.`,
      )
      sections.push(
        'If the current tier is genuinely insufficient and an allowed higher tier would materially help, use route_request_escalation instead of writing a speculative or blocked final answer.',
      )
    }

    if (routeState.answerMode === 'execute') {
      sections.push(
        'The user is primarily asking for execution. If you actually modify files, run commands, or interact with the browser, verify the outcome before saying it is done.',
      )
    } else {
      sections.push(
        'The user primarily needs advice or diagnosis. Prefer explaining the issue and a concrete next step over pretending the task has already been executed.',
      )
    }

    if (routeState.capabilityTier === 'none') {
      sections.push('No workspace or web tools are mounted for this turn. Answer directly with your best explanation.')
    } else if (routeState.capabilityTier === 'local-readonly') {
      sections.push('Only readonly workspace tools are mounted for this turn. Diagnose or explain first; do not imply that files were changed.')
    } else if (routeState.capabilityTier === 'local-write') {
      sections.push('Workspace read and write tools are mounted for this turn. Keep changes focused and verify before claiming completion.')
    } else if (routeState.capabilityTier === 'web-lookup') {
      sections.push('Web lookup tools are mounted only for external facts and current information. Prefer local context first, then use the web only when necessary.')
      sections.push(
        'For research, latest info, docs, news, or source-finding tasks, prefer web_search first and then web_fetch for selected URLs. Do not jump to browser_search just to read public web content.',
      )
    } else if (routeState.capabilityTier === 'browser-interactive') {
      sections.push('Interactive browser tools are mounted because the request explicitly requires web interaction. Stay focused on the requested workflow.')
      sections.push(
        'When both web_* and browser_* are mounted, use web_search/web_fetch for structured lookup or page reading, and use browser_* only when the user explicitly wants browser interaction or the page truly requires interaction.',
      )
      if (routeState.explicitSystemChromeRequest) {
        sections.push('The user explicitly asked to operate system Chrome. Prefer the mounted chrome_* tools over the Aura browser runtime for this turn.')
      }
    }
  }

  if (
    routeState?.capabilityTier === 'web-lookup' ||
    routeState?.capabilityTier === 'browser-interactive'
  ) {
    const browserSource = settings.browser?.source || 'system-chrome'
    const availability = isBrowserSourceAvailable(settings)
    const statusLabel =
      availability === null ? 'unknown' : availability ? 'available' : 'unavailable'
    sections.push(
      `Aura browser source: ${getBrowserSourceLabel(browserSource)} (${statusLabel}).`,
    )
    if (routeState.capabilityTier === 'browser-interactive') {
      sections.push(
        'If a browser_* tool reports a real blocker such as login, MFA, CAPTCHA, or consent, use browser_takeover_visible when mounted instead of switching to unrelated tools.',
      )
      sections.push(
        'Prefer the snapshot-first browser flow: inspect with browser_snapshot or browser_get_page(format=snapshot), act with ref-based browser_click/browser_type when possible, then verify with browser_wait_for, browser_inspect_element, browser_get_page, or browser_screenshot.',
      )
      sections.push(
        'If the browser flow stalls, gather structured evidence before guessing again: browser_console_get, browser_network_get, browser_storage_list/get, and when needed browser_trace_start/browser_trace_stop or browser_video_start/browser_video_stop.',
      )
    }
  }

  if (skillPrompt.trim()) {
    sections.push('Selected skill summaries:\n' + skillPrompt)
    if (routeState?.capabilityTier !== 'none') {
      sections.push(
        'If one of these selected skills is relevant and you need exact instructions, use aura_read_skill only when it is actually mounted for this turn.',
      )
    }
  }

  if (exposureNote?.trim()) {
    sections.push(exposureNote)
  }

  return sections.join('\n\n')
}
