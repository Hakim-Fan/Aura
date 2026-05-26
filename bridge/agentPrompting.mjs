import {
  buildLanguagePolicyInstruction,
  getLocaleDisplayName,
  normalizeRuntimeLocale,
} from './runtimeLanguage.mjs'
import {
  createPromptBlock,
  renderPromptBlocks,
} from './promptBlocks.mjs'

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

function buildHostExecutionContext() {
  const platformLabel =
    process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'darwin'
        ? 'macOS'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform

  return [
    `Host OS: ${platformLabel}.`,
    process.platform === 'win32'
      ? 'Shell commands run through a Windows shell; prefer PowerShell-compatible commands and Windows-native installers such as winget when helping with local setup.'
      : 'Shell commands run through a POSIX shell; prefer commands that match the host OS and installed toolchain.',
    process.platform === 'darwin'
      ? 'Computer Use desktop automation may be mounted when enabled.'
      : 'macOS-only Computer Use desktop automation is not mounted on this host.',
  ].join('\n')
}

function buildWorkspaceScratchInstruction(settings = {}) {
  const cwd = typeof settings?.cwd === 'string' && settings.cwd.trim()
    ? settings.cwd.trim()
    : 'the active workspace'
  return [
    `Workspace scratch directory: ${cwd}/.aura/tmp/`,
    'Use this workspace-local scratch directory for temporary unzip/extraction output, cloned source copies, generated intermediate files, and conversion work. Create task-specific subdirectories there as needed.',
    'Do not use /tmp, the user home directory, Downloads, or other paths outside the active workspace for scratch work unless the user explicitly asks for that external location.',
  ].join('\n')
}

function buildApprovalPolicy(settings) {
  return [
    `Approval policy: shell is ${settings.autoApproveShell ? 'auto-approved' : 'approval-required'}.`,
    `Approval policy: file writes are ${settings.autoApproveFileWrite ? 'auto-approved' : 'approval-required'}.`,
    `Approval policy: computer use is ${settings.autoApproveComputerUse ? 'auto-approved' : 'approval-required'}.`,
    `Approval policy: long task plan approval is ${settings.requireLongTaskPlanApproval ? 'approval-required' : 'not required'}.`,
  ].join('\n')
}

function buildReasoningInstruction(settings) {
  const reasoningInstructions = {
    off: 'Reasoning intensity: off. Prefer fast, concise answers and avoid extended internal exploration unless the task clearly requires it.',
    low: 'Reasoning intensity: low. Optimize for speed and keep reasoning lightweight.',
    medium: 'Reasoning intensity: medium. Balance speed and reasoning depth.',
    high: 'Reasoning intensity: high. Spend more effort on analysis for complex tasks, but produce observable progress early instead of staying in analysis.',
    max: 'Reasoning intensity: maximum. Use your deepest available reasoning for difficult tasks, while still producing observable progress early and avoiding unnecessary repetition.',
  }

  return reasoningInstructions[settings.reasoningEffort] || reasoningInstructions.medium
}

function normalizeCustomInstructionText(value, maxLength = 6000) {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

export function buildUserCustomInstructionsPrompt(settings = {}) {
  const custom = settings?.customInstructions || {}
  const workRules = normalizeCustomInstructionText(custom.workRules)
  const answerPreferences = normalizeCustomInstructionText(custom.answerPreferences)

  if (!workRules && !answerPreferences) {
    return ''
  }

  return [
    'User custom instructions:',
    'These are developer-level user preferences configured in Aura. Follow them when applicable unless they conflict with system safety, workspace permissions, tool policies, or the latest user request.',
    workRules
      ? `<work_rules>\n${workRules}\n</work_rules>`
      : '',
    answerPreferences
      ? `<answer_preferences>\n${answerPreferences}\n</answer_preferences>`
      : '',
  ].filter(Boolean).join('\n')
}

function deriveCapabilityProfile(routeState, toolAvailability = {}) {
  const answerMode = routeState?.answerMode || 'advise'
  const needsExternalFacts = routeState?.needsExternalFacts === true
  const webRetrievalAvailable = routeState?.webRetrievalAvailable !== false
  const webInteractionRequired = routeState?.webInteractionRequired === true
  const explicitSystemBrowserRequest =
    routeState?.explicitSystemBrowserRequest === true
  const isCapabilityAdminTask = routeState?.isCapabilityAdminTask === true
  const mountedReadonly =
    toolAvailability.hasReadonlyWorkspaceTools !== false
  const mountedWrite =
    toolAvailability.hasWorkspaceWriteTools === true
  const mountedWeb =
    toolAvailability.hasWebRetrievalTools === true ||
    webRetrievalAvailable
  const mountedBrowser =
    toolAvailability.hasInteractiveBrowserTools === true ||
    webInteractionRequired ||
    explicitSystemBrowserRequest
  const mountedAdmin =
    toolAvailability.hasCapabilityAdminTools === true ||
    isCapabilityAdminTask

  return {
    hasReadonlyWorkspaceTools: mountedReadonly,
    hasWorkspaceWriteTools: mountedWrite || mountedAdmin,
    hasWebRetrievalTools: mountedWeb,
    hasInteractiveBrowserTools: mountedBrowser,
    hasCapabilityAdminTools: mountedAdmin,
    mixedRetrievalAndWorkspaceExecution:
      mountedWeb === true &&
      needsExternalFacts === true &&
      (mountedWrite === true || mountedAdmin === true) &&
      answerMode === 'execute',
  }
}

export function buildCapabilityExposureNote(snapshot, routeState, toolAvailability = {}) {
  const lines = [
    'Mounted direct tools follow runtime safety boundaries. The mounted tool list is the source of truth for this turn\'s capabilities, and mounted tools remain callable when relevant even if they are not ranked first.',
  ]

  if (routeState) {
    const capabilityProfile = deriveCapabilityProfile(routeState, toolAvailability)
    const enabledModes = [
      capabilityProfile.hasReadonlyWorkspaceTools ? 'safe local reads' : null,
      capabilityProfile.hasWorkspaceWriteTools ? 'workspace writes' : null,
      capabilityProfile.hasWebRetrievalTools ? 'web retrieval' : null,
      capabilityProfile.hasInteractiveBrowserTools ? 'interactive browser handoff' : null,
      capabilityProfile.hasCapabilityAdminTools ? 'capability management' : null,
    ]
      .filter(Boolean)
      .join(', ')
    lines.push(
      routeState.modelDirected === true
        ? `Active default-agent capability profile: ${enabledModes || 'safe local reads only'}.`
        : `Current answer mode: ${routeState.answerMode}. Active capability profile: ${enabledModes || 'safe local reads only'}.`,
    )
    if (routeState.needsExternalFacts === true) {
      lines.push(
        'If web retrieval tools are mounted in the tool list, use them to ground current external facts instead of answering from memory alone.',
      )
    } else {
      lines.push(
        'Web retrieval tools may still be mounted as optional tools on this turn. If they appear in the tool list, use them when local context or current knowledge is insufficient instead of assuming they are blocked by prior classification.',
      )
    }
    if (
      routeState.modelDirected !== true &&
      Array.isArray(routeState.availableEscalations) &&
      routeState.availableEscalations.length > 0
    ) {
      lines.push(
        `Additional runtime escalations remain possible if the current capability profile is genuinely insufficient: ${routeState.availableEscalations.join(', ')}.`,
      )
    }
    if (routeState.modelDirected !== true) {
      lines.push(
        'Internal route budgets and pass limits exist for planning only. Never mention budgets, route tiers, or pass limits to the user.',
      )
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
    lines.push(`Mounted optional capabilities: ${items}.`)
  }

  const deferredCount =
    typeof toolAvailability.deferredToolCount === 'number' &&
    Number.isFinite(toolAvailability.deferredToolCount)
      ? Math.max(0, Math.round(toolAvailability.deferredToolCount))
      : 0
  const discoverableCount =
    typeof toolAvailability.discoverableToolCount === 'number' &&
    Number.isFinite(toolAvailability.discoverableToolCount)
      ? Math.max(0, Math.round(toolAvailability.discoverableToolCount))
      : deferredCount
  const discoverableOnlyCount =
    typeof toolAvailability.discoverableOnlyToolCount === 'number' &&
    Number.isFinite(toolAvailability.discoverableOnlyToolCount)
      ? Math.max(0, Math.round(toolAvailability.discoverableOnlyToolCount))
      : Math.max(0, discoverableCount - deferredCount)

  if (deferredCount > 0 || discoverableOnlyCount > 0) {
    lines.push(
      `tool_search can inspect the current tool catalog, including mounted tools plus deferred or discoverable plugin/MCP tools (${deferredCount} hidden loadable tools, ${discoverableCount} currently discoverable in search, ${discoverableOnlyCount} requiring activation or enablement before direct use). Search first, then call the direct or newly loaded tool that best fits the job.`,
    )
  }

  if (snapshot?.mcpServers?.length) {
    const names = snapshot.mcpServers.map(server => server.name).filter(Boolean).join(', ')
    lines.push(
      `Mounted MCP servers for this turn: ${names}. Their tools are already in the tool list, so call them directly when relevant instead of describing them as external-only capabilities.`,
    )
  }

  return lines.join('\n')
}

export function buildRuntimeSystemPrompt(
  settings,
  skillPrompt,
  exposureNote,
  routeState,
  toolAvailability = {},
) {
  const locale = normalizeRuntimeLocale(settings?.locale)
  const localeLabel = getLocaleDisplayName(locale)
  const sections = [
    'You are Aura, a runtime-governed tool-using agent for workspace work, web retrieval, and browser tasks within mounted capabilities.',
    `The active workspace is: ${settings.cwd}`,
    buildWorkspaceScratchInstruction(settings),
    buildHostExecutionContext(),
    buildCurrentDateContext(),
    'Answer directly when your current knowledge or the mounted local context is sufficient.',
    'Latest user request boundary: treat the newest user message as the scope for this turn. Use earlier conversation, task progress, and work memory only as background context unless the newest message explicitly asks to continue, revise, finish, or build on prior work. Do not expand a narrow latest request into an older larger task goal.',
    'Use only the currently mounted tools when they materially reduce uncertainty or let you act directly on the user request.',
    'Treat the mounted tool list as the source of truth for what you can do in this turn. Do not describe yourself as local-only when web or browser tools are mounted.',
    'If tool_search is mounted, use it to inspect the available tool catalog before claiming a needed capability does not exist.',
    'Do not claim that something is fixed, installed, configured, created, or completed unless the current run produced direct evidence.',
    'Do not access paths outside the configured workspace root.',
    'If the user includes image attachments, treat them as already provided visual input. Do not read PNG/JPG/WebP files as plain text unless the user explicitly asks for raw file inspection or metadata.',
    'When it improves clarity, use enhanced Markdown fences that the UI can render: ```mermaid for diagrams, ```csv or ```tsv for tabular data, ```json for structured data, and LaTeX math with $...$ or $$...$$. Use these only when they make the answer easier to inspect.',
    buildApprovalPolicy(settings),
    buildReasoningInstruction(settings),
    buildUserCustomInstructionsPrompt(settings),
    [
      'Work memory discipline: reasoning and scratchpad text are temporary process, not reusable task memory.',
      'The runtime may save compact progress/tool checkpoints automatically; treat those checkpoints as handoff hints and avoid repeating already successful extraction or setup steps.',
      'For long tasks, treat context as a working window rather than durable storage. Process one bounded chunk at a time, persist requested deliverables with real file/edit/command tools, and keep ordinary assistant text short until final delivery.',
      'Do not write full intermediate tables, large drafts, long logs, or raw reasoning into assistant content. If a large user-visible result must persist, write or update a real workspace file and keep only its path, counts, decisions, open questions, and next action in work memory.',
    'Do not record generic plans, raw chain-of-thought, speculative mid-stream thoughts, or obvious facts. Mark incomplete but useful artifacts as draft, and mark unverified assumptions as assumption.',
    ].join('\n'),
    `Primary response locale: ${localeLabel} (${locale}).`,
  ]

  if (routeState) {
    const capabilityProfile = deriveCapabilityProfile(routeState, toolAvailability)

    sections.push(
      [
        `Current answer mode: ${routeState.answerMode}.`,
        capabilityProfile.hasInteractiveBrowserTools
          ? 'Interactive browser tools: enabled when explicitly required.'
          : 'Interactive browser tools: not active unless the task explicitly requires them.',
        routeState.needsExternalFacts === true
          ? 'If web retrieval tools are mounted in the tool list, use them for this turn because the task depends on current external facts.'
          : 'If web retrieval tools are mounted in the tool list, they remain optional but usable. Do not wait for classifier hints before using them when local context or current knowledge is insufficient.',
        capabilityProfile.hasWorkspaceWriteTools
          ? 'Workspace write tools: mounted when available in the tool list. Use them when the user is asking for concrete local changes, and treat route mode as planning guidance rather than a hard prohibition.'
          : 'Workspace write tools are not mounted for this turn.',
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
        'The user primarily needs advice or diagnosis. Prefer explaining the issue and a concrete next step over pretending the task has already been executed. If mounted write tools are available and the user explicitly asked for concrete local changes, you may still execute instead of refusing purely because of route mode.',
      )
    }

    sections.push(
      'Safe local inspection tools may be mounted even on advice-heavy turns. Use them when they materially reduce uncertainty, but do not imply that files were changed unless write evidence exists.',
    )
    sections.push(
      'If you truly need the user to confirm a risky change or provide a missing local decision, call request_user_input. Do not hide the question only inside reasoning text.',
    )
    sections.push(
      'For skill installation requests, first identify the target application. If the user wants to install a skill for Aura, use aura_install_skill or aura_import_skill and do not execute third-party npx/Claude/Codex installer commands through shell directly. Treat those commands as sources for the audited Aura installer, which may run npx only inside an isolated temporary home before importing the produced skill. If the user appears to be installing a skill for another application, ask for confirmation before running that app-specific installer.',
    )
    if (capabilityProfile.hasCapabilityAdminTools) {
      sections.push(
        'Capability management tools are mounted. For Aura skill installation from a URL, GitHub path, npm package, npx command, local path, or pasted SKILL.md, call aura_install_skill directly with that source; use aura_import_skill only when you already have a local skill file/directory. Do not pre-download, git clone, mkdir, cp, or mv into ~/.aura/skills by shell.',
      )
    }
    sections.push(
      'Shell commands run under an execution policy. Do not use shell as a workaround for workspace file-tool boundaries: if read_file cannot access an external path, import or copy the file into the workspace, or use the dedicated Aura capability tool. Accessing /tmp, the user home directory, ~/.aura, elevated commands, package installers, and system automation may require explicit approval or be blocked.',
    )

    if (capabilityProfile.hasWorkspaceWriteTools) {
      sections.push('Workspace read and write tools are mounted for this turn. Keep changes focused and verify before claiming completion.')
      sections.push(
        'For code changes, prefer apply_patch as the main editing path. Use write_file mainly for new files or full-document rewrites, keep edit_file / multi_edit_file as exact-match fallbacks, and use replace_line_range after a fresh read_file range when exact patch context repeatedly fails.',
      )
      sections.push(
        'A high-quality local editing loop is: locate with search_code or glob_files, inspect with read_file or read_block, patch with apply_patch, then do targeted verification before the final answer. When you need a specific file range, call read_file with startLine/endLine and mode=edit_context instead of shell awk/sed; use mode=raw when you need copyable replacement text without line numbers.',
      )
      sections.push(
        'search_code returns suggestedRanges that can be passed directly to read_file with mode=edit_context. Prefer those ranges over guessing line numbers after a match.',
      )
      sections.push(
        'When producing binary or office artifacts such as DOCX, PPTX, XLSX, PDF, or images, call verify_artifact on the output path before finalizing so the evidence gate records existence, hash, read-back, and Office container structure when applicable.',
      )
      sections.push(
        'For longer-running or interactive commands, prefer exec_command and continue with write_stdin. Use write_stdin to send more input, poll more output, close stdin, or terminate the session. Keep run_shell for short one-shot commands.',
      )
    }

    if (capabilityProfile.hasWebRetrievalTools) {
      sections.push(
        capabilityProfile.mixedRetrievalAndWorkspaceExecution
          ? 'This turn mixes external fact gathering with local workspace execution. Retrieval tools and workspace write tools may both be mounted. Gather just enough outside evidence, then return to concrete repo changes.'
          : 'Web retrieval tools are mounted for external facts and current information. Prefer local context first, then use the web only when necessary.',
      )
      sections.push(
        'Use staged retrieval like mature commercial assistants: start with web_search for straightforward fact lookup or quick source discovery, then escalate to web_research only when the search result says the evidence is still thin, conflicting, or clearly needs deeper reading. Use web_fetch when you already know the exact URL that needs closer inspection.',
      )
      sections.push(
        'web_search, web_research, and web_fetch may be mounted together. Choose the right retrieval tool directly for the job instead of assuming the runtime will auto-upgrade one into another.',
      )
      sections.push(
        'Treat retrieval backends as runtime internals. Work through web_search, web_fetch, and web_research as stable tools, and do not narrate provider selection details to the user unless a backend-specific failure materially affects the task.',
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
        'web_search returns ranking metadata such as rankScore, sourceQualityScore, noveltyScore, freshnessScore, domainCategory, rankingSignals, and a searchAssessment block. If searchAssessment recommends answer_from_search, you can usually answer quickly. If it recommends fetch_top_ranked_results, deepen selectively. If it recommends upgrade_to_web_research, stop stretching snippets and escalate.',
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
      sections.push(
        'Ordinary research does not escalate into browser interaction automatically. Stay within web_search, web_research, and web_fetch unless the user explicitly asked to operate a browser.',
      )
      sections.push(
        'When you stop searching, present it as a user-facing evidence boundary, not an internal budget boundary.',
      )
    }

    if (capabilityProfile.hasInteractiveBrowserTools) {
      sections.push(
        routeState.webInteractionRequired
          ? 'Interactive browser tools are mounted because the request explicitly requires web interaction. Stay focused on the requested workflow.'
          : 'Interactive browser tools are mounted only for explicit browser-operation tasks. Do not treat them as a research fallback.',
      )
      sections.push(
        'Use web_research, web_search, and web_fetch for information gathering. Use system_browser_open only to hand off an explicit browser workflow to the user-facing system browser.',
      )
      if (routeState.explicitSystemBrowserRequest) {
        sections.push('The user explicitly asked to use the system browser. Prefer system_browser_open and then computer_* tools when needed.')
      }
    }
  }

  if (deriveCapabilityProfile(routeState, toolAvailability).hasInteractiveBrowserTools) {
    sections.push(
      'Open the site with system_browser_open when the user needs to log in, solve CAPTCHA, grant consent, submit forms, or otherwise interact manually.',
    )
    sections.push(
      'If computer_* tools are mounted, use them only after opening the system browser and only when they materially help the requested interaction.',
    )
  }

  if (skillPrompt.trim()) {
    sections.push('Enabled skill summaries:\n' + skillPrompt)
    if (routeState) {
      sections.push(
        'Enabled skills are live routing hints for this turn. At the start of each user request, scan the skill names, ids, and descriptions even if the user does not mention a skill. If a skill clearly or plausibly matches the request, use it proactively: call aura_read_skill with the exact skill id before applying the skill, then follow its instructions. If no skill matches, proceed normally and do not force an irrelevant skill.',
      )
      sections.push(
        'When a skill matches a file type or domain (for example a docx skill for Word documents), read that skill before choosing generic shell/Python/Node commands. After reading a skill, treat its named tools, runtimes, libraries, and validation steps as the source of truth for that domain. Do not substitute an unrelated dependency or language-specific package unless the skill explicitly allows it or the skill path is impossible and you clearly report the blocker.',
      )
    }
  }

  if (exposureNote?.trim()) {
    sections.push(exposureNote)
  }

  sections.push(buildLanguagePolicyInstruction(settings))

  return sections.join('\n\n')
}

export function buildDefaultAgentSystemPrompt(
  settings,
  skillPrompt,
  exposureNote,
  routeState,
  toolAvailability = {},
) {
  return renderPromptBlocks(
    buildDefaultAgentPromptBlocks(
      settings,
      skillPrompt,
      exposureNote,
      routeState,
      toolAvailability,
    ),
  )
}

export function buildDefaultAgentPromptBlocks(
  settings,
  skillPrompt,
  exposureNote,
  routeState,
  toolAvailability = {},
) {
  const locale = normalizeRuntimeLocale(settings?.locale)
  const localeLabel = getLocaleDisplayName(locale)
  const capabilityProfile = deriveCapabilityProfile(routeState, toolAvailability)
  const blocks = []
  const coreSections = [
    'You are Aura running in default-agent mode: the main model decides whether to answer directly, make a lightweight plan, use tools, ask the user, or stop with a clear blocker.',
    'Understand the user request from context and act naturally in this single default-agent pass.',
    'For simple questions, answer directly and keep the response concise.',
    'For multi-step, ambiguous, or stateful work, call todo_write with a short checklist and keep it current. todo_write is only for progress display: use explanation for why the plan changed, and plan items with step/status/activeForm. Do not put acceptance criteria, verification evidence, risks, or long explanations in todo items. Do not create a plan for trivial one-step work.',
    'When a todo step needs verification, perform verification with an appropriate mounted tool before finalizing. Mark todo steps completed only after the current run produced concrete tool evidence for the work represented by that step.',
    routeState?.answerMode === 'execute'
      ? 'Execution-mode contract: the user expects concrete work, not another planning pass. todo_write, reading files, and explaining intent are coordination/context only; they do not satisfy an execution step by themselves. After a plan/todo update, move to the concrete tool that creates, edits, runs, verifies, or persists the requested output. If the requested output is large, create the smallest durable file first, then extend it in bounded chunks.'
      : null,
    routeState?.answerMode === 'execute'
      ? 'For large generated deliverables such as HTML prototypes, PRDs, slide decks, reports, or converted documents, avoid a single huge tool-call argument. Persist a compact workspace file scaffold first, then continue with bounded edits and checkpoints.'
      : null,
    'Use tools when they materially reduce uncertainty or let you complete the user request. The mounted tool list is the source of truth for this turn.',
    'If a needed capability is not obvious and tool_search is mounted, inspect the current tool catalog before claiming the capability is unavailable.',
    'If the user request needs files, commands, web retrieval, browser interaction, or capability management and the matching tool is mounted, use the tool directly instead of asking the user to do the work.',
    'Ask the user only when an important product decision, risky action, missing credential, or unavailable input blocks progress.',
    'Do not claim that something is fixed, installed, configured, created, or completed unless the current run produced direct evidence.',
    'Verify concrete changes before finalizing when verification is practical. If verification is blocked, say exactly what was done and what remains unverified.',
    'For final delivery after concrete work, summarize what changed, the key files or artifacts, what verification was run, and any remaining unverified risk. Keep it concise and do not invent verification that is not present in tool evidence.',
  ].filter(Boolean)

  blocks.push(createPromptBlock({
    id: 'core-instructions',
    kind: 'core_instructions',
    priority: 10,
    stable: true,
    content: coreSections.join('\n\n'),
  }))

  blocks.push(createPromptBlock({
    id: 'developer-instructions',
    kind: 'developer_instructions',
    priority: 20,
    content: [
      'When it improves clarity, use enhanced Markdown fences that the UI can render: ```mermaid for diagrams, ```csv or ```tsv for tabular data, ```json for structured data, and LaTeX math with $...$ or $$...$$. Use these only when they make the answer easier to inspect.',
      buildReasoningInstruction(settings),
      [
        'Work memory discipline: reasoning and scratchpad text are temporary process, not reusable task memory.',
        'The runtime may save compact progress/tool checkpoints automatically; treat those checkpoints as handoff hints and avoid repeating already successful extraction or setup steps.',
        'For long tasks, treat context as a working window rather than durable storage. Process one bounded chunk at a time, persist requested deliverables with real file/edit/command tools, and keep ordinary assistant text short until final delivery.',
        'Do not write full intermediate tables, large drafts, long logs, or raw reasoning into assistant content. If a large user-visible result must persist, write or update a real workspace file and keep only its path, counts, decisions, open questions, and next action in work memory.',
        'Do not record generic plans, raw chain-of-thought, speculative mid-stream thoughts, or obvious facts. Mark incomplete but useful artifacts as draft, and mark unverified assumptions as assumption.',
      ].join('\n'),
    ].join('\n\n'),
  }))

  blocks.push(createPromptBlock({
    id: 'system-safety-and-permissions',
    kind: 'system_safety_and_permissions',
    priority: 30,
    content: [
      buildApprovalPolicy(settings),
      'Do not access paths outside the configured workspace root.',
      'If the user includes image attachments, treat them as already provided visual input. Do not read PNG/JPG/WebP files as plain text unless the user explicitly asks for raw file inspection or metadata.',
    ].join('\n\n'),
  }))

  const customInstructions = buildUserCustomInstructionsPrompt(settings)
  if (customInstructions) {
    blocks.push(createPromptBlock({
      id: 'user-custom-instructions',
      kind: 'user_custom_instructions',
      priority: 40,
      content: customInstructions,
    }))
  }

  blocks.push(createPromptBlock({
    id: 'environment-context',
    kind: 'environment_context',
    priority: 50,
    content: [
      buildHostExecutionContext(),
      buildCurrentDateContext(),
      `The active workspace is: ${settings.cwd}`,
      buildWorkspaceScratchInstruction(settings),
      `Primary response locale: ${localeLabel} (${locale}).`,
      buildLanguagePolicyInstruction(settings),
    ].join('\n\n'),
  }))

  const enabledModes = [
    capabilityProfile.hasReadonlyWorkspaceTools ? 'safe local reads' : null,
    capabilityProfile.hasWorkspaceWriteTools ? 'workspace writes' : null,
    capabilityProfile.hasWebRetrievalTools ? 'web retrieval' : null,
    capabilityProfile.hasInteractiveBrowserTools ? 'interactive browser handoff' : null,
    capabilityProfile.hasCapabilityAdminTools ? 'capability management' : null,
  ]
    .filter(Boolean)
    .join(', ')

  const capabilitySections = [
    `Mounted capability profile: ${enabledModes || 'direct answers only'}.`,
  ]

  if (capabilityProfile.hasWorkspaceWriteTools) {
    capabilitySections.push('For code changes, prefer apply_patch as the main editing path. Use write_file mainly for new files or full-document rewrites, keep edit_file / multi_edit_file as exact-match fallbacks, and use replace_line_range after a fresh read_file range when exact patch context repeatedly fails.')
    capabilitySections.push('A high-quality local editing loop is: locate with search_code or glob_files, inspect with read_file or read_block, patch with apply_patch, then do targeted verification before the final answer.')
    capabilitySections.push('For longer-running or interactive commands, prefer exec_command and continue with write_stdin. Use write_stdin to send more input, poll more output, close stdin, or terminate the session. Keep run_shell for short one-shot commands.')
  }

  if (capabilityProfile.hasWebRetrievalTools) {
    capabilitySections.push('Use web retrieval for current facts, live data, linked pages, or external evidence that may have changed. Prefer local context first when the task is purely about the workspace.')
    capabilitySections.push('Use web_search for quick discovery, web_fetch for a known URL, and web_research when the evidence needs broader synthesis or corroboration.')
  }

  if (capabilityProfile.hasInteractiveBrowserTools) {
    capabilitySections.push('Use browser/computer tools only for explicit browser workflows such as login, clicking, filling forms, or operating the system browser. Use web retrieval tools for ordinary information gathering.')
  }

  if (capabilityProfile.hasCapabilityAdminTools) {
    capabilitySections.push('For Aura skill/plugin/MCP management, use the dedicated aura_* tools. Do not install third-party capability commands through shell when an Aura capability tool fits.')
  }

  if (skillPrompt.trim()) {
    capabilitySections.push('Enabled skill summaries:\n' + skillPrompt)
    capabilitySections.push('At the start of each user request, scan the skill names, ids, and descriptions. If a skill clearly or plausibly matches, call aura_read_skill with the exact skill id before applying the skill.')
  }

  if (exposureNote?.trim()) {
    capabilitySections.push(exposureNote)
  }

  blocks.push(createPromptBlock({
    id: 'capability-context',
    kind: 'capability_context',
    priority: 60,
    content: capabilitySections.join('\n\n'),
  }))

  return blocks
}
