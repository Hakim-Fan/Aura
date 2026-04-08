export type ProviderMode = 'openai' | 'google' | 'custom'

export type ProviderModel = {
  id: string
  enabled: boolean
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
  usage?: MessageUsage
  capabilitySnapshot?: CapabilityUsageSnapshot
  activity?: MessageActivity
  events?: MessageEvent[]
  steps?: TaskNode[]
  error?: string
  errorInfo?: RuntimeErrorInfo
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
  usage?: MessageUsage
  capabilitySnapshot?: CapabilityUsageSnapshot
  activity?: MessageActivity
  events?: MessageEvent[]
  steps?: TaskNode[]
  error?: string
  errorInfo?: RuntimeErrorInfo
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
  isDefault?: boolean
}

export type ExecutionMode = 'bounded' | 'long-task'

export type MemoryMode = 'summary' | 'claude-like'

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

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
  enableMultiAgent: boolean
  enableComputerUse: boolean
  enableChromeAutomation: boolean
  autoApproveShell: boolean
  autoApproveFileWrite: boolean
  autoApproveComputerUse: boolean
  autoApproveChromeAutomation: boolean
  enabledSkillIds: string[]
  enabledPluginIds: string[]
  mcpServers: McpServerConfig[]
  sendShortcut: 'enter' | 'meta-enter'
}

export type Session = {
  id: string
  title: string
  providerProfileId: string
  provider: ProviderMode
  model: string
  workspacePath: string
  workspaceRoot: string
  workspaceMode: 'explicit' | 'default'
  messages: ChatMessage[]
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  updatedAt: number
}

export type AgentResponse = {
  message: string
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  reasoning?: MessageReasoning[]
  usage?: MessageUsage
}

export type AgentTaskSnapshot = {
  id: string
  status: TaskStatus
  message?: string
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  reasoning?: MessageReasoning[]
  usage?: MessageUsage
  pendingApproval?: ApprovalRequest
  appendedInputs?: AppendedInput[]
  error?: string
  errorInfo?: RuntimeErrorInfo
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
