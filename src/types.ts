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

export type AppendedInput = {
  id: string
  content: string
  parts?: ChatContentPart[]
  attachments?: MessageAttachment[]
  createdAt: number
  status: AppendedInputStatus
}

export type MessageEvent = {
  id: string
  kind: MessageEventKind
  title: string
  summary: string
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
}

export type ChatMessage = {
  id: string
  role: ChatRole
  linkedMessageId?: string
  content: string
  parts?: ChatContentPart[]
  status?: MessageStatus
  createdAt?: number
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
  | 'chrome_automation'

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

export type BrowserRuntimeSource =
  | 'system-chrome'
  | 'managed-chrome'
  | 'custom-executable'

export type BrowserSearchEngine =
  | 'google'
  | 'bing'
  | 'duckduckgo'
  | 'baidu'
  | 'custom'

export type BrowserTakeoverMode = 'ask' | 'auto-visible-on-blocker'

export type BrowserSearchPreferences = {
  engine: BrowserSearchEngine
  customTemplate?: string
  region?: string
  language?: string
  safeSearch?: 'off' | 'moderate' | 'strict'
}

export type BrowserBehaviorPreferences = {
  acceptLanguage?: string
  timezone?: string
  locale?: string
  colorScheme?: 'light' | 'dark' | 'system'
  userAgentMode?: 'default' | 'desktop'
}

export type BrowserRuntimeSettings = {
  enabled: boolean
  source: BrowserRuntimeSource
  executablePath?: string
  managedExecutablePath?: string
  allowChromeAutomationFallback: boolean
  headlessByDefault: boolean
  takeoverMode: BrowserTakeoverMode
  persistAuraProfile: boolean
  auraProfilePath?: string
  search: BrowserSearchPreferences
  behavior: BrowserBehaviorPreferences
}

export type ChromeImportSource = {
  id: string
  profileName: string
  profilePath: string
  isDefault: boolean
}

export type ImportedChromeSite = {
  id: string
  domain: string
  sourceProfileId: string
  importedAt: number
  lastRefreshedAt?: number
  cookieCount: number
  notes?: string
}

export type BrowserRuntimeStatusRecord = {
  systemChromeDetected: boolean
  systemChromePath?: string
  managedChromeInstalled: boolean
  managedChromePath?: string
  managedChromeSizeBytes?: number
  customExecutablePath?: string
  customExecutableValid?: boolean
  lastCheckedAt: number
}

export type ManagedBrowserInstallStage =
  | 'preparing'
  | 'resolving-download'
  | 'downloading'
  | 'extracting'
  | 'verifying'
  | 'cancelled'
  | 'completed'
  | 'failed'

export type ManagedBrowserInstallProgress = {
  stage: ManagedBrowserInstallStage
  message: string
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
}

export type AgentSettings = {
  provider: ProviderMode
  apiKey: string
  baseUrl: string
  model: string
  activeProviderProfileId: string
  providerProfiles: ProviderProfile[]
  cwd: string
  maxSteps: number
  executionMode: ExecutionMode
  memoryMode: MemoryMode
  reasoningEffort: ReasoningEffort
  enableProviderFailureRecovery: boolean
  providerFailureRecoveryMaxAttempts: number
  enableMultiAgent: boolean
  enableComputerUse: boolean
  enableChromeAutomation: boolean
  autoApproveShell: boolean
  autoApproveFileWrite: boolean
  autoApproveComputerUse: boolean
  autoApproveChromeAutomation: boolean
  enabledSkillIds: string[]
  enabledPluginIds: string[]
  browser: BrowserRuntimeSettings
  chromeImportSources: ChromeImportSource[]
  importedChromeSites: ImportedChromeSite[]
  browserRuntimeStatus?: BrowserRuntimeStatusRecord
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
}

export type WorkspaceNodeKind = 'file' | 'directory'

export type WorkspaceNode = {
  name: string
  path: string
  kind: WorkspaceNodeKind
  children: WorkspaceNode[]
}
