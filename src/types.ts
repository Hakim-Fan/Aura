export type ProviderMode = 'anthropic' | 'openai-compatible'

export type ProviderPresetDot = 'active' | 'ready' | 'idle'

export type ProviderPreset = {
  id: string
  name: string
  subtitle: string
  badge?: string
  dot: ProviderPresetDot
  provider: ProviderMode
  baseUrl: string
  modelHint: string
}

export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
}

export type ToolEvent = {
  id: string
  source: 'builtin' | 'mcp' | 'plugin' | 'subagent'
  name: string
  summary: string
  status: 'success' | 'error'
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

export type AgentSettings = {
  provider: ProviderMode
  apiKey: string
  baseUrl: string
  model: string
  cwd: string
  maxSteps: number
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
}

export type Session = {
  id: string
  title: string
  messages: ChatMessage[]
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  updatedAt: number
}

export type AgentResponse = {
  message: string
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export type AgentTaskSnapshot = {
  id: string
  status: TaskStatus
  message?: string
  toolEvents: ToolEvent[]
  taskTree: TaskNode[]
  pendingApproval?: ApprovalRequest
  error?: string
}

export type WorkspaceNodeKind = 'file' | 'directory'

export type WorkspaceNode = {
  name: string
  path: string
  kind: WorkspaceNodeKind
  children: WorkspaceNode[]
}
