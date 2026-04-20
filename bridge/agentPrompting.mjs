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
    if (Array.isArray(routeState.availableEscalations) && routeState.availableEscalations.length > 0) {
      lines.push(`Allowed route escalations for this turn: ${routeState.availableEscalations.join(', ')}.`)
    }
    lines.push(
      'Internal route budgets and pass limits exist for planning only. Never mention budgets, route tiers, or pass limits to the user.',
    )
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
        routeState.researchMode === 'deep'
          ? 'Research mode: deep.'
          : 'Research mode: auto.',
        'Internal budgets and route controls exist only for planning.',
        'Never mention budgets, route tiers, pass limits, or internal controller decisions in the final answer.',
      ].join('\n'),
    )

    if (routeState.responseStyle === 'research-structured') {
      sections.push(
        'This turn benefits from an evidence-led response. Use clear structure when it improves comprehension, especially for multi-source or uncertainty-heavy research. Do not force a rigid report format onto trivial questions.',
      )
    } else {
      sections.push(
        'Keep simple questions simple. Do not force headings like conclusion, corroboration, uncertainty, or next steps unless the task genuinely benefits from that structure.',
      )
    }

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
        'For research, latest info, docs, news, or source-finding tasks, your first external evidence step should normally be web_research. Use web_search only after an initial web_research pass when you truly need extra discovery breadth, and use web_fetch when you already know the exact URL that needs deeper reading.',
      )
      sections.push(
        'For source selection, prefer high-signal domains when relevant: official docs for technical references, reputable finance sites for market data, and established news outlets for current events.',
      )
      sections.push(
        'When calling web_search, prefer plain natural-language keywords. If you want to bias toward certain sites, prefer the domains field. Legacy operators like site:, intitle:, or quoted phrases are accepted, but they are less portable across providers than structured fields.',
      )
      sections.push(
        'web_research returns ranked results together with fetched or provider-supplied evidence when available. Prefer it when you want packaged evidence with citationIndex, status, content, and per-source risk signals in a single step.',
      )
      sections.push(
        'web_search returns ranking metadata such as rankScore, sourceQualityScore, noveltyScore, freshnessScore, domainCategory, and rankingSignals. Some providers may also return rich snippets, answer fields, or result content. Prefer higher rankScore links, but still diversify domains when the question benefits from comparison.',
      )
      sections.push(
        'web_fetch returns structured evidence such as sourceAssessment, riskFlags, keyPoints, and evidenceBlocks. Prefer grounding your answer in those evidenceBlocks instead of paraphrasing the whole page blindly.',
      )
      sections.push(
        'When multiple web_fetch calls or a web_research result expose crossSourceInsights, prefer those signals to separate corroborated claims from mixed or conflicting evidence before writing the conclusion.',
      )
      sections.push(
        'Use a research loop that mirrors mature agents: start with one broad but well-formed discovery step, inspect whether web_research or web_search already returned enough grounded content, then deepen only the best sources. Search again only if the evidence is stale, contradictory, or still missing a key angle.',
      )
      if (routeState.researchMode === 'deep') {
        sections.push(
          'Deep research mode is enabled. Prefer broader source coverage, more domain diversity, and higher-confidence corroboration. A well-scoped web_research call with higher searchLimit and fetchLimit is often the fastest starting point.',
        )
      }
      sections.push(
        routeState.researchMode === 'deep'
          ? 'Do not burn searches on minor query rewrites. In deep research mode you may spend a few extra discovery searches, but once strong candidates exist you should switch to reading, web_research synthesis, or targeted web_fetch before searching again.'
          : 'Do not burn searches on minor query rewrites. After two discovery searches without switching to reading or web_research synthesis, stop and move to source analysis or a bounded answer.',
      )
      if (routeState.allowBrowserResearchFallback) {
        sections.push(
          'Browser fallback for web research is enabled in settings, but it is still a last resort. Stay on web_* first. Only request escalation to browser-interactive when web_research or web_fetch explicitly signals browserFallbackSuggested, repeated WEB_FETCH_PAGE_REQUIRES_BROWSER blockers occur, or public-web results remain unusable after reasonable web_* attempts.',
        )
      } else {
        sections.push(
          'Browser fallback for ordinary web research is disabled in settings. Do not request browser-interactive just because web results are thin; stay within web_* unless the user explicitly asked for browser operation.',
        )
      }
      sections.push(
        'When you stop searching, present it as a user-facing evidence boundary, not an internal budget boundary.',
      )
    } else if (routeState.capabilityTier === 'browser-interactive') {
      sections.push(
        routeState.webInteractionRequired
          ? 'Interactive browser tools are mounted because the request explicitly requires web interaction. Stay focused on the requested workflow.'
          : 'Interactive browser tools are mounted as a last-resort fallback after web research limits were reached or browser-dependent pages blocked ordinary web access. Stay focused on unblocking the evidence path instead of browsing casually.',
      )
      sections.push(
        'When both web_* and browser_* are mounted, use web_research, web_search, and web_fetch for information gathering, source lookup, and page reading. Use browser_* only for actual browser operation such as open, login, click, type, submit, or page-state verification.',
      )
      if (routeState.webInteractionRequired) {
        sections.push(
          'Do not use browser_search or browser page navigation as a substitute for ordinary research. Unless the task itself is to operate a browser workflow, gather information only through web_search, web_research, and web_fetch.',
        )
      } else {
        sections.push(
          'Because this browser tier came from research fallback, prefer browser_search only when web_search or web_research failed to surface usable public results, and prefer browser_open on specific blocked URLs when web_fetch or web_research already identified them.',
        )
      }
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
