import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveWorkspacePath, stringifyOutput, truncate } from './utils.mjs'

const execFileAsync = promisify(execFile)

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

async function runAppleScript(lines, featureName = 'Desktop automation') {
  const args = lines.flatMap(line => ['-e', line])
  try {
    const { stdout } = await execFileAsync('osascript', args, {
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${featureName} failed. Make sure the app is running in a logged-in macOS desktop session and that accessibility / automation permissions are granted.\n\n${detail}`,
    )
  }
}

async function runCommand(file, args, cwd) {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd,
    maxBuffer: 1024 * 1024,
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

function buildComputerTools({ settings, context }) {
  if (!settings.enableComputerUse) {
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
      async run() {
        ensureMacOs('Computer use')
        return runAppleScript([
          'tell application "System Events"',
          'set appNames to name of every application process whose background only is false',
          'return appNames as string',
          'end tell',
        ], 'Computer use')
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
      async run() {
        ensureMacOs('Computer use')
        return runAppleScript([
          'tell application "System Events"',
          'return name of first application process whose frontmost is true',
          'end tell',
        ], 'Computer use')
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
      async run(args) {
        ensureMacOs('Computer use')
        const appName = escapeAppleScriptString(args.appName)
        await runAppleScript([
          `tell application "${appName}" to activate`,
        ], 'Computer use')
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
      async run(args) {
        ensureMacOs('Computer use')
        const relativePath =
          args.relativePath ||
          `.aura/captures/capture-${Date.now()}.png`
        const target = resolveWorkspacePath(context.cwd, relativePath)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await runCommand('screencapture', ['-x', target], context.cwd)
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
      async run(args) {
        ensureMacOs('Computer use')
        const text = escapeAppleScriptString(args.text)
        await runAppleScript([
          'tell application "System Events"',
          `keystroke "${text}"`,
          'end tell',
        ], 'Computer use')
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
      async run(args) {
        ensureMacOs('Computer use')
        const key = escapeAppleScriptString(args.key)
        const usingClause = formatModifiers(args.modifiers)
        await runAppleScript([
          'tell application "System Events"',
          `keystroke "${key}"${usingClause}`,
          'end tell',
        ], 'Computer use')
        return `Sent shortcut ${[...(args.modifiers || []), args.key].join('+')}`
      },
    },
  ]
}

function buildChromeTools({ settings }) {
  if (!settings.enableChromeAutomation) {
    return []
  }

  return [
    {
      source: 'builtin',
      name: 'chrome_open_url',
      approvalCategory: 'chrome_automation',
      description: 'Open a URL in Google Chrome and bring it to the front.',
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
      async run(args) {
        ensureMacOs('Chrome automation')
        const url = escapeAppleScriptString(args.url)
        await runAppleScript([
          'tell application "Google Chrome"',
          'activate',
          `open location "${url}"`,
          'end tell',
        ], 'Chrome automation')
        return `Opened ${args.url} in Google Chrome.`
      },
    },
    {
      source: 'builtin',
      name: 'chrome_get_active_tab',
      approvalCategory: 'chrome_automation',
      description: 'Read the title and URL of the active Google Chrome tab.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async run() {
        ensureMacOs('Chrome automation')
        const result = await runAppleScript([
          'tell application "Google Chrome"',
          'set tabTitle to title of active tab of front window',
          'set tabUrl to URL of active tab of front window',
          'return tabTitle & linefeed & tabUrl',
          'end tell',
        ], 'Chrome automation')
        const [title = '', url = ''] = result.split('\n')
        return `Title: ${title}\nURL: ${url}`
      },
    },
    {
      source: 'builtin',
      name: 'chrome_run_javascript',
      approvalCategory: 'chrome_automation',
      description:
        'Execute JavaScript in the active tab of the frontmost Google Chrome window.',
      inputSchema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'JavaScript source to evaluate in the active tab.',
          },
        },
        required: ['script'],
      },
      async run(args) {
        ensureMacOs('Chrome automation')
        const script = escapeAppleScriptString(args.script)
        const result = await runAppleScript([
          'tell application "Google Chrome"',
          `set jsResult to execute active tab of front window javascript "${script}"`,
          'return jsResult',
          'end tell',
        ], 'Chrome automation')
        return result || '(javascript executed with empty result)'
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
  if (!settings.enableMultiAgent || (runtimeMeta.subagentDepth || 0) >= 1) {
    return []
  }

  return [
    {
      source: 'subagent',
      name: 'spawn_subagent',
      description:
        'Delegate a focused subtask to a worker agent and receive its distilled result.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Precise subtask for the worker agent.',
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
        required: ['task'],
      },
      async run(args) {
        const workerCwd = args.cwd
          ? resolveWorkspacePath(context.cwd, args.cwd)
          : context.cwd
        const taskNode = taskTracker?.createChildTask({
          parentId: runtimeMeta.currentTaskId,
          title: args.task,
          summary: args.deliverable || 'Focused subagent task',
        })
        const workerPrompt = [
          'You are a focused worker subagent.',
          `Task: ${args.task}`,
          args.deliverable
            ? `Return format: ${args.deliverable}`
            : 'Return only the concrete result and any important caveats.',
          'Do not delegate to another subagent.',
        ].join('\n\n')

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
              currentTaskId: taskNode?.id,
              taskTracker,
            },
          })

          taskTracker?.completeTask(
            taskNode?.id,
            result.message || 'Subagent completed successfully.',
            result.status === 'failed' ? 'failed' : 'completed',
            result.taskTree || [],
          )

          return stringifyOutput({
            worker_cwd: workerCwd,
            response: result.message,
            toolEvents: result.toolEvents,
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
    ...buildChromeTools(options),
  ]
}
