export type ProviderMode = 'openai' | 'google' | 'custom'

export type ProviderModel = {
  id: string
  enabled: boolean
  contextWindowTokens?: number
  maxOutputTokens?: number
}

export type ProviderProfile = {
  id: string
  name: string
  provider: ProviderMode
  apiKey: string
  baseUrl: string
  enabled: boolean
  models: ProviderModel[]
  defaultModel: string
}

export type ChatRole = 'user' | 'assistant'

export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'failed'

export type MessageEventKind = 'tool' | 'shell' | 'skill' | 'approval' | 'subagent'

export type MessageEventStatus = 'running' | 'success' | 'error' | 'awaiting_approval'

export type RuntimeErrorCategory =
  | 'permission'
  | 'missing_dependency'
  | 'timeout'
  | 'network'
  | 'not_found'
  | 'invalid_input'
  | 'authentication'
  | 'rate_limit'
  | 'unavailable'
  | 'cancelled'
  | 'unsupported'
  | 'execution_failed'
  | 'unknown'

export type RuntimeErrorSource = 'tool' | 'plugin' | 'mcp' | 'provider' | 'system'

export type RuntimeErrorInfo = {
  source: RuntimeErrorSource
  category: RuntimeErrorCategory
  code?: string
  summary: string
  detail?: string
  suggestedAction?: string
  retryable?: boolean
}

export type ProviderRetryStage = 'response' | 'finalization' | 'recovery'

export type ProviderRetryInfo = {
  attemptedRetries: number
  configuredMaxRetries?: number
  configuredMaxAttempts: number
  stage?: ProviderRetryStage
  stageLabel?: string
  recovered?: boolean
}

export type AgentExecutionPhase =
  | 'preparing'
  | 'model_connecting'
  | 'model_streaming'
  | 'tool_running'
  | 'finalizing'
  | 'recovering'
  | 'awaiting_approval'

export type AppendedInputStatus = 'queued' | 'consumed'

export type ResearchMode = 'auto' | 'deep'

export type AppendedInput = {
  id: string
  content: string
  parts?: ChatContentPart[]
  attachments?: MessageAttachment[]
  createdAt: number
  status: AppendedInputStatus
  researchMode?: ResearchMode
}

export type MessageEvent = {
  id: string
  kind: MessageEventKind
  title: string
  summary: string
  toolName?: string
  order?: number
  source?: 'builtin' | 'mcp' | 'plugin' | 'subagent'
  status: MessageEventStatus
  input?: string
  output?: string
  error?: string
  errorInfo?: RuntimeErrorInfo
}

export type MessageActivity = {
  status: TaskStatus
  startedAt: number
  finishedAt?: number
  toolCount: number
  skillCount: number
  stepCount: number
  phase?: AgentExecutionPhase
  phaseStartedAt?: number
  lastHeartbeatAt?: number
  lastProgressAt?: number
  stalled?: boolean
  expanded?: boolean
}

export type MessageAttachment = {
  id: string
  name: string
  path: string
  preview?: string
  mimeType?: string
}

export type ChatContentPart =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'image'
      name: string
      mimeType: string
      path?: string
      dataUrl?: string
    }
  | {
      type: 'file'
      name: string
      path: string
      mimeType?: string
    }

export type MessageReasoning = {
  id: string
  kind: 'provider' | 'summary'
  content: string
  order?: number
}

export type MessagePhaseOutput = {
  id: string
  blockId: string
  content: string
  order?: number
}

export type MessageUsage = {
  inputTokens?: number
  outputTokens?: number
  contextWindow?: number
}

export type CapabilityKind = 'skill' | 'plugin' | 'mcp'

export type CapabilityOverrideMode = 'inherit' | 'on' | 'off'

export type CapabilityUsageEntry = {
  id: string
  name: string
}

export type CapabilityUsageSnapshot = {
  workspaceRoot: string
  resolvedAt: number
  skills: CapabilityUsageEntry[]
  plugins: CapabilityUsageEntry[]
  mcpServers: CapabilityUsageEntry[]
}

export type AgentArchitectureMode = 'route-first' | 'orchestrated'

export type RouteAnswerMode = 'advise' | 'diagnose' | 'execute'

export type RouteCapabilityTier =
  | 'none'
  | 'local-readonly'
  | 'local-write'
  | 'web-lookup'
  | 'browser-interactive'

export type RouteEscalationTarget =
  | 'local-write'
  | 'web-lookup'
  | 'browser-interactive'

export type RouteBudgetSnapshot = {
  searchesRemaining: number
  browserEscalationsRemaining: number
  writeEscalationsRemaining: number
}

export type RouteMountedCapabilitiesSnapshot = {
  skills: string[]
  plugins: string[]
  mcpServers: string[]
  tools: string[]
}

export type RouteDecisionSnapshot = {
  answerMode: RouteAnswerMode
  capabilityTier: RouteCapabilityTier
  budgets?: RouteBudgetSnapshot
  allowEscalationTo?: RouteEscalationTarget[]
  availableEscalations?: RouteEscalationTarget[]
  escalationCount?: number
  tierHistory?: RouteCapabilityTier[]
  stopReason?:
    | 'completed'
    | 'completed_with_evidence'
    | 'no_incremental_progress'
    | 'budget_exhausted'
    | 'runtime_pass_limit'
  mountedCapabilities?: RouteMountedCapabilitiesSnapshot
}

export type CompletionState =
  | 'not_executed'
  | 'executed_unverified'
  | 'executed_verified'
  | 'blocked_by_approval'
  | 'blocked_by_capability'
  | 'failed_after_execution'

export type EvidenceRecord = {
  toolName: string
  source: 'builtin' | 'plugin' | 'mcp' | 'subagent'
  status: 'success' | 'error' | 'denied'
  effectTypes: Array<'read' | 'write' | 'execute' | 'browser' | 'plan'>
  producedEvidence: Array<
    | 'file_mutation'
    | 'command_exit_0'
    | 'command_output'
    | 'test_pass'
    | 'test_fail'
    | 'page_state'
    | 'search_result'
    | 'web_search_result'
    | 'web_research_result'
    | 'web_fetch_content'
    | 'web_fetch_summary'
    | 'user_denied'
  >
  verificationLevel: 'none' | 'partial' | 'verified'
  detail?: string
}

export type ExecutionEvidenceSummary = {
  records: EvidenceRecord[]
  hasAnyExecution: boolean
  hasWriteEffect: boolean
  hasBrowserEffect: boolean
  hasVerifiedEvidence: boolean
  hasApprovalBlock: boolean
  hasCapabilityBlock: boolean
  hasExecutionFailure: boolean
}

export type ResolvedSkillCapability = CapabilityUsageEntry & {
  promptPath?: string
}

export type ResolvedPluginCapability = CapabilityUsageEntry & {
  entryPath?: string
}

export type ResolvedAgentCapabilities = {
  workspaceRoot: string
  resolvedAt: number
  skills: ResolvedSkillCapability[]
  plugins: ResolvedPluginCapability[]
  mcpServers: McpServerConfig[]
}

export type WorkspaceCapabilityOverrides = {
  skills: Record<string, CapabilityOverrideMode>
  plugins: Record<string, CapabilityOverrideMode>
  mcp: Record<string, CapabilityOverrideMode>
}

export type ProjectCapabilityOverrides = Record<string, WorkspaceCapabilityOverrides>

export type CapabilityPanelItem = {
  id: string
  kind: CapabilityKind
  name: string
  description: string
  source: 'builtin' | 'user'
  installed: boolean
  supported: boolean
  supportMessage?: string
  path?: string
  entryPath?: string
  readonly: boolean
  globalEnabled: boolean
  projectOverride: CapabilityOverrideMode
  effectiveEnabled: boolean
}

export type MessageModelInfo = {
  providerProfileId: string
  providerProfileName: string
  provider: ProviderMode
  modelId: string
  label: string
}

export type ChatMessageVariant = {
  content: string
  parts?: ChatContentPart[]
  status?: MessageStatus
  createdAt?: number
  researchMode?: ResearchMode
  attachments?: MessageAttachment[]
  reasoning?: MessageReasoning[]
  phaseOutputs?: MessagePhaseOutput[]
  usage?: MessageUsage
  capabilitySnapshot?: CapabilityUsageSnapshot
  activity?: MessageActivity
  events?: MessageEvent[]
  steps?: TaskNode[]
  error?: string
  errorInfo?: RuntimeErrorInfo
  retryInfo?: ProviderRetryInfo
  appendedInputs?: AppendedInput[]
  modelInfo?: MessageModelInfo
  agentMode?: AgentArchitectureMode
  routeDecision?: RouteDecisionSnapshot
  completionState?: CompletionState
  evidenceSummary?: ExecutionEvidenceSummary
  deliveryNote?: string
}

export type ChatMessage = {
  id: string
  role: ChatRole
  linkedMessageId?: string
  content: string
  parts?: ChatContentPart[]
  status?: MessageStatus
  createdAt?: number
  researchMode?: ResearchMode
  attachments?: MessageAttachment[]
  reasoning?: MessageReasoning[]
  phaseOutputs?: MessagePhaseOutput[]
  usage?: MessageUsage
  capabilitySnapshot?: CapabilityUsageSnapshot
  activity?: MessageActivity
  events?: MessageEvent[]
  steps?: TaskNode[]
  error?: string
  errorInfo?: RuntimeErrorInfo
  retryInfo?: ProviderRetryInfo
  appendedInputs?: AppendedInput[]
  modelInfo?: MessageModelInfo
  agentMode?: AgentArchitectureMode
  routeDecision?: RouteDecisionSnapshot
  completionState?: CompletionState
  evidenceSummary?: ExecutionEvidenceSummary
  deliveryNote?: string
  versions?: ChatMessageVariant[]
  activeVersionIndex?: number
}

export type ToolEvent = {
  id: string
  source: 'builtin' | 'mcp' | 'plugin' | 'subagent'
  name: string
  summary: string
  order?: number
  status: 'running' | 'success' | 'error'
  input?: string
  output?: string
  error?: string
  errorInfo?: RuntimeErrorInfo
}

export type ApprovalCategory =
  | 'shell'
  | 'file_write'
  | 'computer_use'

export type ApprovalRequest = {
  id: string
  category: ApprovalCategory
  toolName: string
  summary: string
  input?: string
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'

export type TaskNode = {
  id: string
  title: string
  summary: string
  kind: 'main' | 'subagent'
  status: TaskStatus
  children: TaskNode[]
}

export type McpServerConfig = {
  id: string
  name: string
  description: string
  command: string
  args: string
  env: string
  cwd: string
  networkProxy?: string
  enabled: boolean
  healthStatus?: 'unknown' | 'ok' | 'error'
  healthMessage?: string
  lastCheckedAt?: number
  toolCount?: number
  isDefault?: boolean
}

export type ExecutionMode = 'bounded' | 'long-task'

export type MemoryMode = 'summary' | 'claude-like'

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

export type LightpandaSettings = {
  enabled: boolean
  executablePath?: string
  maxConcurrency: number
  timeoutSeconds: number
}

export type InteractiveBrowserSettings = {
  enabled: boolean
  allowComputerUse: boolean
}

export type BrowserSettings = {
  lightpanda: LightpandaSettings
  interactive: InteractiveBrowserSettings
}

export type WebSearchProviderId = 'auto' | 'tavily' | 'brave' | 'duckduckgo'

export type WebFetchProviderId = 'auto' | 'http-readability'

export type WebSearchProviderSettings = {
  tavilyApiKey: string
  braveApiKey: string
}

export type WebFetchProviderSettings = {
  jinaEnabled: boolean
  jinaApiKey: string
  jinaAllowAnonymous: boolean
}

export type WebSearchSettings = {
  enabled: boolean
  provider: WebSearchProviderId
  timeoutSeconds: number
  cacheTtlMinutes: number
  maxResults: number
  providers: WebSearchProviderSettings
}

export type WebFetchSettings = {
  enabled: boolean
  provider: WebFetchProviderId
  timeoutSeconds: number
  maxCharsCap: number
  maxResponseBytes: number
  maxRedirects: number
  readability: boolean
  providers: WebFetchProviderSettings
}

export type WebResearchSettings = {
  enabled: boolean
  defaultSearchLimit: number
  defaultFetchLimit: number
  defaultMaxChars: number
  preferSearchContent: boolean
  searchContentMinChars: number
  deepSearchLimit: number
  deepFetchLimit: number
  deepMaxChars: number
}

export type WebToolsSettings = {
  search: WebSearchSettings
  fetch: WebFetchSettings
  research: WebResearchSettings
}

export type LightpandaRuntimeStatusRecord = {
  detected: boolean
  executablePath?: string
  version?: string
  valid: boolean
  lastCheckedAt: number
  error?: string
}

export type AgentSettings = {
  provider: ProviderMode
  apiKey: string
  baseUrl: string
  model: string
  analysisProviderProfileId: string
  analysisModel: string
  activeProviderProfileId: string
  providerProfiles: ProviderProfile[]
  agentArchitectureMode: AgentArchitectureMode
  cwd: string
  networkProxy?: string
  maxSteps: number
  executionMode: ExecutionMode
  memoryMode: MemoryMode
  reasoningEffort: ReasoningEffort
  showDetailedExecutionDetails: boolean
  enableProviderFailureRecovery: boolean
  providerFailureRecoveryMaxAttempts: number
  enableMultiAgent: boolean
  enableComputerUse: boolean
  autoApproveShell: boolean
  autoApproveFileWrite: boolean
  autoApproveComputerUse: boolean
  enabledSkillIds: string[]
  enabledPluginIds: string[]
  browser: BrowserSettings
  web: WebToolsSettings
  mcpServers: McpServerConfig[]
  sendShortcut: 'enter' | 'meta-enter'
}

export type Session = {
  id: string
  title: string
  providerProfileId: string
  provider: ProviderMode
  model: string
  folderId?: string
  workspacePath: string
  workspaceRoot: string
  workspaceMode: 'explicit' | 'default'
  messages: ChatMessage[]
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  updatedAt: number
}

export type SessionFolder = {
  id: string
  name: string
  expanded: boolean
  createdAt: number
}

export type AgentResponse = {
  message: string
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  reasoning?: MessageReasoning[]
  usage?: MessageUsage
  capabilitySnapshot?: CapabilityUsageSnapshot
  retryInfo?: ProviderRetryInfo
  agentMode?: AgentArchitectureMode
  routeDecision?: RouteDecisionSnapshot
  completionState?: CompletionState
  evidenceSummary?: ExecutionEvidenceSummary
  deliveryNote?: string
}

export type AgentTaskSnapshot = {
  id: string
  status: TaskStatus
  message?: string
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  reasoning?: MessageReasoning[]
  phaseOutputs?: MessagePhaseOutput[]
  usage?: MessageUsage
  capabilitySnapshot?: CapabilityUsageSnapshot
  pendingApproval?: ApprovalRequest
  appendedInputs?: AppendedInput[]
  error?: string
  errorInfo?: RuntimeErrorInfo
  retryInfo?: ProviderRetryInfo
  phase?: AgentExecutionPhase
  phaseStartedAt?: number
  lastHeartbeatAt?: number
  lastProgressAt?: number
  stalled?: boolean
  errorCode?: string
  errorSource?: string
  rawError?: string
  agentMode?: AgentArchitectureMode
  routeDecision?: RouteDecisionSnapshot
  completionState?: CompletionState
  evidenceSummary?: ExecutionEvidenceSummary
  deliveryNote?: string
}

export type WorkspaceNodeKind = 'file' | 'directory'

export type WorkspaceNode = {
  name: string
  path: string
  kind: WorkspaceNodeKind
  children: WorkspaceNode[]
}
