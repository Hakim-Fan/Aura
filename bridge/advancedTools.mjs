import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createStructuredError } from './runtimeErrors.mjs'
import {
  isProjectMemoryEnabled,
  runSpawnMemoryAgentTool,
  updateProjectMemoryNow,
} from './projectMemory.mjs'
import { resolveWorkspacePath, stringifyOutput, truncate } from './utils.mjs'

const execFileAsync = promisify(execFile)

const CODEX_AGENT_ROLES = {
  default: {
    name: 'default',
    title: 'Default agent',
    summary: 'Default agent.',
    prompt: [
      'You are a default Aura subagent.',
      'Complete the assigned task directly using the tools available to you.',
      'Return a concise result with the concrete outcome, files touched when relevant, and any blocker.',
    ],
  },
  explorer: {
    name: 'explorer',
    title: 'Explorer agent',
    summary: [
      'Use `explorer` for specific codebase questions.',
      'Explorers are fast and authoritative.',
      'They must answer well-scoped questions about the codebase and should avoid changing files.',
    ].join(' '),
    prompt: [
      'You are an explorer subagent.',
      'Your job is to answer specific, well-scoped questions about the codebase.',
      'Inspect files and project structure, then return concise findings with file paths and evidence.',
      'Do not write, edit, patch, install, run mutating commands, or delegate to another subagent.',
      'If the task requires mutation, report that it should be assigned to a worker instead.',
    ],
  },
  worker: {
    name: 'worker',
    title: 'Worker agent',
    summary: [
      'Use for execution and production work.',
      'Typical tasks: implement part of a feature, fix tests or bugs, or handle an independent refactor chunk.',
    ].join(' '),
    prompt: [
      'You are a worker subagent.',
      'You own the assigned implementation task. Make concrete changes when needed and verify them with available tools.',
      'Do not revert unrelated user or peer changes. Work only within the responsibility described by the parent agent.',
      'Do not delegate to another subagent.',
    ],
  },
  verification: {
    name: 'verification',
    title: 'Verification agent',
    summary: [
      'Use for independent adversarial verification before reporting non-trivial implementation complete.',
      'Typical tasks: inspect changed files, run targeted tests or artifact checks, and issue pass/fail/partial evidence.',
    ].join(' '),
    prompt: [
      'You are a verification subagent.',
      'Your job is independent adversarial verification. Prove whether the assigned work is actually complete.',
      'Inspect relevant files and run targeted checks with available tools. Do not modify files.',
      'A check without an actual command/tool run is not a PASS. Reading or reasoning about code is context, not verification.',
      'For every important check, report the command/tool run, observed output, and PASS/FAIL result. Use PARTIAL only for environment/tool limitations.',
      'End with exactly one final line: VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.',
      'Do not delegate to another subagent.',
    ],
  },
}

function formatCodexAgentRoleDescription() {
  return [
    'Optional type name for the new agent. If omitted, `default` is used.',
    'Available roles:',
    ...Object.values(CODEX_AGENT_ROLES).map(role => `${role.name}: {\n${role.summary}\n}`),
  ].join('\n')
}

function normalizeAgentType(value) {
  const normalized = String(value || 'default').trim().toLowerCase()
  if (normalized === 'general-purpose' || normalized === 'general_purpose') {
    return 'default'
  }
  if (normalized === 'explore') {
    return 'explorer'
  }
  return normalized || 'default'
}

function resolveAgentRole(agentType) {
  const normalized = normalizeAgentType(agentType)
  const role = CODEX_AGENT_ROLES[normalized]
  if (!role) {
    throw createStructuredError(`未知 agent_type "${agentType}"。`, {
      source: 'tool',
      category: 'invalid_input',
      code: 'UNKNOWN_AGENT_TYPE',
      detail: `Available agent types: ${Object.keys(CODEX_AGENT_ROLES).join(', ')}`,
      suggestedAction: '请使用 default、explorer、worker 或 verification。',
    })
  }
  return role
}

function buildSpawnAgentPrompt(role, args = {}) {
  const message = String(args.message || args.prompt || args.task || '').trim()
  const taskName = String(args.task_name || args.description || args.taskName || '').trim()
  const deliverable = String(args.deliverable || '').trim()
  return [
    ...role.prompt,
    taskName ? `Canonical task name: ${taskName}` : '',
    `Task:\n${message}`,
    deliverable
      ? `Expected return:\n${deliverable}`
      : 'Return only the distilled result, important evidence, files changed if any, and blockers.',
  ].filter(Boolean).join('\n\n')
}

function summarizeSubagentToolEvents(toolEvents = []) {
  return (Array.isArray(toolEvents) ? toolEvents : []).slice(-20).map(event => ({
    id: event?.id,
    name: event?.name,
    source: event?.source,
    status: event?.status,
    summary: event?.summary,
    error: event?.error,
  }))
}

function containsUnexecutedToolMarkup(value = '') {
  const text = String(value || '')
  return /<(?:tool_call|invoke)\b|<\/(?:tool_call|invoke)>|<\/?minimax:tool_call\b|<(?:arg_key|arg_value|parameter)\b/iu.test(text)
}

function resolveSubagentStatus(result = {}) {
  if (result?.status === 'failed') {
    return 'failed'
  }

  if (
    result?.completionState === 'failed_after_execution' ||
    result?.completionState === 'blocked_by_capability' ||
    result?.completionState === 'blocked_by_approval'
  ) {
    return 'failed'
  }

  if (containsUnexecutedToolMarkup(result?.message)) {
    return 'failed'
  }

  return 'completed'
}

function buildSubagentCompletionSummary(result = {}, status = 'completed') {
  const message = truncate(result?.message || '', 1_200)

  if (status === 'failed') {
    if (containsUnexecutedToolMarkup(result?.message)) {
      return [
        'Subagent did not complete: it returned tool-call markup as assistant text instead of producing a native tool result.',
        message,
      ].filter(Boolean).join('\n\n')
    }
    return message || 'Subagent did not complete successfully.'
  }

  return message || 'Subagent completed successfully.'
}

function ensureMacOs(featureName) {
  if (process.platform !== 'darwin') {
    throw new Error(`${featureName} is currently implemented for macOS only.`)
  }
}

function escapeAppleScriptString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

async function runAppleScript(lines, featureName = 'Desktop automation', signal) {
  const args = lines.flatMap(line => ['-e', line])
  try {
    const { stdout } = await execFileAsync('osascript', args, {
      maxBuffer: 1024 * 1024,
      signal,
    })
    return stdout.trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${featureName} failed. Make sure the app is running in a logged-in macOS desktop session and that accessibility / automation permissions are granted.\n\n${detail}`,
    )
  }
}

async function runCommand(file, args, cwd, signal) {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd,
    maxBuffer: 1024 * 1024,
    signal,
  })
  return truncate([stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'))
}

function formatModifiers(modifiers = []) {
  if (!Array.isArray(modifiers) || modifiers.length === 0) {
    return ''
  }

  const supported = {
    command: 'command down',
    control: 'control down',
    option: 'option down',
    shift: 'shift down',
  }

  const converted = modifiers
    .map(modifier => supported[String(modifier).toLowerCase()])
    .filter(Boolean)
  return converted.length > 0 ? ` using {${converted.join(', ')}}` : ''
}

function buildComputerTools({ settings, context, platform = process.platform }) {
  if (!settings.enableComputerUse || platform !== 'darwin') {
    return []
  }

  return [
    {
      source: 'builtin',
      name: 'computer_list_apps',
      approvalCategory: 'computer_use',
      description: 'List visible macOS application processes.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async run(args, runtime = {}) {
        ensureMacOs('Computer use')
        runtime.throwIfAborted?.()
        return runAppleScript([
          'tell application "System Events"',
          'set appNames to name of every application process whose background only is false',
          'return appNames as string',
          'end tell',
        ], 'Computer use', runtime.signal)
      },
    },
    {
      source: 'builtin',
      name: 'computer_get_frontmost_app',
      approvalCategory: 'computer_use',
      description: 'Get the currently focused macOS application.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async run(args, runtime = {}) {
        ensureMacOs('Computer use')
        runtime.throwIfAborted?.()
        return runAppleScript([
          'tell application "System Events"',
          'return name of first application process whose frontmost is true',
          'end tell',
        ], 'Computer use', runtime.signal)
      },
    },
    {
      source: 'builtin',
      name: 'computer_open_app',
      approvalCategory: 'computer_use',
      description: 'Open or focus a macOS application by name.',
      inputSchema: {
        type: 'object',
        properties: {
          appName: {
            type: 'string',
            description: 'Application name, for example "Google Chrome".',
          },
        },
        required: ['appName'],
      },
      async run(args, runtime = {}) {
        ensureMacOs('Computer use')
        runtime.throwIfAborted?.()
        const appName = escapeAppleScriptString(args.appName)
        await runAppleScript([
          `tell application "${appName}" to activate`,
        ], 'Computer use', runtime.signal)
        return `Activated ${args.appName}`
      },
    },
    {
      source: 'builtin',
      name: 'computer_capture_screen',
      approvalCategory: 'computer_use',
      description: 'Capture a screenshot and save it into the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          relativePath: {
            type: 'string',
            description: 'Optional relative path for the output PNG file.',
          },
        },
      },
      async run(args, runtime = {}) {
        ensureMacOs('Computer use')
        runtime.throwIfAborted?.()
        const relativePath =
          args.relativePath ||
          `.aura/captures/capture-${Date.now()}.png`
        const target = resolveWorkspacePath(context.cwd, relativePath)
        await fs.mkdir(path.dirname(target), { recursive: true })
        try {
          await runCommand('screencapture', ['-x', target], context.cwd, runtime.signal)
        } catch (error) {
          throw createStructuredError(
            '截图失败，当前环境没有可用的屏幕画面，或者系统未授予屏幕录制权限。',
            {
              source: 'tool',
              category: 'permission',
              code:
                error && typeof error === 'object' && typeof error.code === 'string'
                  ? error.code
                  : 'SCREEN_CAPTURE_FAILED',
              detail: error instanceof Error ? error.stack || error.message : String(error),
              suggestedAction:
                '请确认应用运行在可见桌面会话中，并在系统设置中允许屏幕录制后再试。',
            },
          )
        }
        return `Saved screenshot to ${target}`
      },
    },
    {
      source: 'builtin',
      name: 'computer_type_text',
      approvalCategory: 'computer_use',
      description: 'Type text into the frontmost application.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to type.',
          },
        },
        required: ['text'],
      },
      async run(args, runtime = {}) {
        ensureMacOs('Computer use')
        runtime.throwIfAborted?.()
        const text = escapeAppleScriptString(args.text)
        await runAppleScript([
          'tell application "System Events"',
          `keystroke "${text}"`,
          'end tell',
        ], 'Computer use', runtime.signal)
        return `Typed ${args.text.length} characters into the frontmost app.`
      },
    },
    {
      source: 'builtin',
      name: 'computer_press_shortcut',
      approvalCategory: 'computer_use',
      description: 'Send a keyboard shortcut to the frontmost application.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Single key to press, for example "l" or "r".',
          },
          modifiers: {
            type: 'array',
            items: {
              type: 'string',
            },
            description:
              'Optional modifiers: command, control, option, shift.',
          },
        },
        required: ['key'],
      },
      async run(args, runtime = {}) {
        ensureMacOs('Computer use')
        runtime.throwIfAborted?.()
        const key = escapeAppleScriptString(args.key)
        const usingClause = formatModifiers(args.modifiers)
        await runAppleScript([
          'tell application "System Events"',
          `keystroke "${key}"${usingClause}`,
          'end tell',
        ], 'Computer use', runtime.signal)
        return `Sent shortcut ${[...(args.modifiers || []), args.key].join('+')}`
      },
    },
  ]
}

function buildSystemBrowserTools({ settings, context, platform = process.platform }) {
  if (settings?.browser?.interactive?.enabled !== true || platform !== 'darwin') {
    return []
  }

  return [
    {
      source: 'builtin',
      name: 'system_browser_open',
      approvalCategory: 'computer_use',
      description: 'Open a URL in the system default browser for explicit interactive web tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Target URL.',
          },
        },
        required: ['url'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()

        let normalizedUrl
        try {
          normalizedUrl = new URL(String(args.url || '').trim()).toString()
        } catch {
          throw createStructuredError('系统浏览器打开失败，URL 无效。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'SYSTEM_BROWSER_INVALID_URL',
            suggestedAction: '请提供包含协议头的完整网址，例如 https://example.com。',
          })
        }

        const command = { file: 'open', args: [normalizedUrl] }

        try {
          await execFileAsync(command.file, command.args, {
            cwd: context.cwd,
            signal: runtime.signal,
            timeout: 10_000,
          })
        } catch (error) {
          throw createStructuredError('无法打开系统浏览器。', {
            source: 'tool',
            category: 'execution_failed',
            code: 'SYSTEM_BROWSER_OPEN_FAILED',
            detail: error instanceof Error ? error.message : String(error),
            suggestedAction: '请确认系统默认浏览器可正常启动后再试。',
            retryable: true,
          })
        }

        return `Opened ${normalizedUrl} in the system browser.`
      },
    },
  ]
}

function buildMultiAgentTools({
  settings,
  context,
  runNestedAgent,
  runtimeMeta,
  taskTracker,
}) {
  if (
    !settings.enableMultiAgent ||
    (runtimeMeta.subagentDepth || 0) >= 1
  ) {
    return []
  }

  return [
    {
      source: 'subagent',
      name: 'spawn_agent',
      description:
        [
          'Spawns a Claude-style subagent to work on the specified task and returns its distilled result.',
          'Spawned agents inherit the current model by default. Omit model unless the user explicitly asks for a different model.',
          formatCodexAgentRoleDescription(),
          'Claude-compatible aliases are supported: description maps to task_name, prompt maps to message, and subagent_type maps to agent_type.',
          'Use explorer for codebase investigation, worker for implementation, verification for independent verification, and default for general delegated work.',
        ].join('\n\n'),
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Initial plain-text task for the new agent.',
          },
          task_name: {
            type: 'string',
            description:
              'Task name for the new agent. Use lowercase letters, digits, and underscores.',
          },
          agent_type: {
            type: 'string',
            description: formatCodexAgentRoleDescription(),
          },
          description: {
            type: 'string',
            description: 'Claude-compatible alias for task_name. A concise task label.',
          },
          prompt: {
            type: 'string',
            description: 'Claude-compatible alias for message. The full task prompt for the subagent.',
          },
          subagent_type: {
            type: 'string',
            description: 'Claude-compatible alias for agent_type.',
          },
          task: {
            type: 'string',
            description: 'Compatibility alias for message.',
          },
          deliverable: {
            type: 'string',
            description: 'What the worker should return.',
          },
          cwd: {
            type: 'string',
            description: 'Optional relative workspace path for the worker.',
          },
          model: {
            type: 'string',
            description: 'Optional model override for the worker.',
          },
        },
        required: [],
      },
      async run(args) {
        const role = resolveAgentRole(args.agent_type || args.subagent_type)
        const message = String(args.message || args.prompt || args.task || '').trim()
        if (!message) {
          throw createStructuredError('spawn_agent 缺少 message。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'SPAWN_AGENT_MISSING_MESSAGE',
            suggestedAction: '请提供明确的 Multi-Agent 任务内容。',
          })
        }
        const workerCwd = args.cwd
          ? resolveWorkspacePath(context.cwd, args.cwd)
          : context.cwd
        const taskNode = taskTracker?.createChildTask({
          parentId: runtimeMeta.currentTaskId,
          title: args.task_name || args.description || message,
          summary: `${role.title}: ${args.deliverable || message}`,
        })
        const workerPrompt = buildSpawnAgentPrompt(role, args)

        try {
          const result = await runNestedAgent({
            settings: {
              ...settings,
              cwd: workerCwd,
              model: args.model || settings.model,
              enableMultiAgent: false,
            },
            messages: [
              {
                role: 'user',
                content: workerPrompt,
              },
            ],
            runtime: {
              subagentDepth: (runtimeMeta.subagentDepth || 0) + 1,
              subagentRole: role.name,
              subagentTaskName: args.task_name || args.description || taskNode?.id,
              currentTaskId: taskNode?.id,
              taskTracker,
              executionStepIds: runtimeMeta.executionStepIds,
            },
          })

          const agentStatus = resolveSubagentStatus(result)
          const completionSummary = buildSubagentCompletionSummary(result, agentStatus)

          taskTracker?.completeTask(
            taskNode?.id,
            completionSummary,
            agentStatus,
          )

          return stringifyOutput({
            agent_id: taskNode?.id,
            task_name: args.task_name || args.description || taskNode?.id || message,
            agent_type: role.name,
            agent_status: agentStatus,
            worker_cwd: workerCwd,
            response: completionSummary,
            toolEvents: summarizeSubagentToolEvents(result.toolEvents),
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          taskTracker?.completeTask(taskNode?.id, detail, 'failed')
          throw error
        }
      },
    },
  ]
}

function buildProjectMemoryTools({ settings, context, runtimeMeta, runNestedAgent }) {
  if (
    !isProjectMemoryEnabled(settings) ||
    (runtimeMeta?.subagentDepth || 0) >= 1
  ) {
    return []
  }

  return [
    {
      source: 'builtin',
      name: 'spawn_memory_agent',
      internalOnly: true,
      description: [
        'Silently starts project_memory_retriever, an asynchronous task-time project-memory query subagent for the active workspace, and returns a memory_task_id.',
        'The lookup result is injected into a later model call by the runtime; do not expect this tool call to return the memory content directly.',
        'Use this only when project history, user preferences, prior decisions, troubleshooting notes, or an old task recap would materially reduce uncertainty for the newest user request.',
        'Do not call it for trivial questions, current external facts, or information that is clearly available in the current conversation.',
      ].join('\n\n'),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Current user request or a concise query describing the memory needed.',
          },
          reason: {
            type: 'string',
            description: 'Why project memory is likely relevant.',
          },
        },
      },
      async run(args, runtime = {}) {
        return runSpawnMemoryAgentTool(context, args, runtime)
      },
    },
    {
      source: 'builtin',
      name: 'update_project_memory',
      internalOnly: true,
      description: [
        'Runs project_memory_organizer to prepare incremental Aura project long-term memory updates for the active workspace.',
        'Use this only when the user explicitly asks to update, save, remember, or forget project memory. Do not use it merely because a normal task completed.',
        'The update is local-only under .aura/memory, preserves user edits by appending incremental sections, and returns after the write finishes.',
      ].join('\n\n'),
      inputSchema: {
        type: 'object',
        properties: {
          notes: {
            type: 'string',
            description: 'The user-approved memory update notes or facts to save.',
          },
          reason: {
            type: 'string',
            description: 'Short reason for this memory update.',
          },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const result = await updateProjectMemoryNow({
          settings,
          notes: args.notes || args.reason || '',
          reason: 'manual',
          sessionId: context.logContext?.sessionId,
          hooks: context.projectMemoryHooks,
          runNestedAgent,
        })
        return stringifyOutput(result)
      },
    },
  ]
}

export function createAdvancedTools(options) {
  return [
    ...buildProjectMemoryTools(options),
    ...buildMultiAgentTools(options),
    ...buildComputerTools(options),
    ...buildSystemBrowserTools(options),
  ]
}
