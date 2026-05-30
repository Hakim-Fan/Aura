import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createStructuredError } from './runtimeErrors.mjs'
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
      'Return a clear PASS, FAIL, or PARTIAL verdict with concrete evidence and required follow-up.',
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
  const message = String(args.message || args.task || '').trim()
  const taskName = String(args.task_name || args.taskName || '').trim()
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

function buildSystemBrowserTools({ settings, context }) {
  if (settings?.browser?.interactive?.enabled === false) {
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

        const command =
          process.platform === 'darwin'
            ? { file: 'open', args: [normalizedUrl] }
            : process.platform === 'win32'
              ? { file: 'cmd', args: ['/c', 'start', '', normalizedUrl] }
              : { file: 'xdg-open', args: [normalizedUrl] }

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
          'Spawns a Codex-style agent to work on the specified task and returns its distilled result.',
          'Spawned agents inherit the current model by default. Omit model unless the user explicitly asks for a different model.',
          formatCodexAgentRoleDescription(),
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
        required: ['task_name', 'message'],
      },
      async run(args) {
        const role = resolveAgentRole(args.agent_type)
        const message = String(args.message || args.task || '').trim()
        if (!message) {
          throw createStructuredError('spawn_agent 缺少 message。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'SPAWN_AGENT_MISSING_MESSAGE',
            suggestedAction: '请提供要交给子 agent 的明确任务。',
          })
        }
        const workerCwd = args.cwd
          ? resolveWorkspacePath(context.cwd, args.cwd)
          : context.cwd
        const taskNode = taskTracker?.createChildTask({
          parentId: runtimeMeta.currentTaskId,
          title: args.task_name || message,
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
              subagentTaskName: args.task_name || taskNode?.id,
              currentTaskId: taskNode?.id,
              taskTracker,
              executionStepIds: runtimeMeta.executionStepIds,
            },
          })

          taskTracker?.completeTask(
            taskNode?.id,
            result.message || 'Subagent completed successfully.',
            result.status === 'failed' ? 'failed' : 'completed',
            result.taskTree || [],
          )

          return stringifyOutput({
            agent_id: taskNode?.id,
            task_name: args.task_name || taskNode?.id || message,
            agent_type: role.name,
            agent_status: result.status === 'failed' ? 'failed' : 'completed',
            worker_cwd: workerCwd,
            response: result.message,
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

export function createAdvancedTools(options) {
  return [
    ...buildMultiAgentTools(options),
    ...buildComputerTools(options),
    ...buildSystemBrowserTools(options),
  ]
}
