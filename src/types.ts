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

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  parts?: ChatContentPart[]
  status?: MessageStatus
  createdAt?: number
  attachments?: MessageAttachment[]
  reasoning?: MessageReasoning[]
  usage?: MessageUsage
  activity?: MessageActivity
  events?: MessageEvent[]
  steps?: TaskNode[]
  error?: string
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
  command: string
  args: string
  env: string
  cwd: string
  enabled: boolean
}

export type ExecutionMode = 'bounded' | 'long-task'

export type MemoryMode = 'summary' | 'claude-like'

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
  error?: string
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
