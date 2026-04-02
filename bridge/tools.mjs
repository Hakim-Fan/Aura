import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  formatToolError,
  resolveWorkspacePath,
  stringifyOutput,
  truncate,
} from './utils.mjs'

const execFileAsync = promisify(execFile)

async function walkDirectory(dirPath, maxDepth, currentDepth = 0) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const lines = []

  for (const entry of entries.slice(0, 80)) {
    const entryPath = path.join(dirPath, entry.name)
    lines.push(
      `${'  '.repeat(currentDepth)}${entry.isDirectory() ? 'dir ' : 'file'} ${path.basename(entryPath)}`,
    )

    if (entry.isDirectory() && currentDepth < maxDepth) {
      lines.push(...(await walkDirectory(entryPath, maxDepth, currentDepth + 1)))
    }
  }

  return lines
}

async function runShell(command, cwd, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Shell command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(
          truncate(
            [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n') ||
              'Command completed with no output',
          ),
        )
        return
      }

      reject(
        new Error(
          `Command exited with code ${code}\n\n${truncate(stderr || stdout)}`,
        ),
      )
    })
  })
}

export function createBuiltinTools(context) {
  return [
    {
      source: 'builtin',
      name: 'list_files',
      description: 'List files and directories inside the current workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path inside the workspace.',
          },
          depth: {
            type: 'number',
            description: 'Maximum recursion depth.',
          },
        },
      },
      async run(args) {
        const target = resolveWorkspacePath(context.cwd, args.path || '.')
        const lines = await walkDirectory(target, Math.min(args.depth ?? 2, 4))
        return truncate(lines.join('\n') || '(empty directory)')
      },
    },
    {
      source: 'builtin',
      name: 'read_file',
      description: 'Read a text file from inside the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside the workspace.',
          },
        },
        required: ['path'],
      },
      async run(args) {
        const target = resolveWorkspacePath(context.cwd, args.path)
        const content = await fs.readFile(target, 'utf8')
        return truncate(content)
      },
    },
    {
      source: 'builtin',
      name: 'write_file',
      approvalCategory: 'file_write',
      description:
        'Write a text file inside the workspace. Overwrites the file if it already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside the workspace.',
          },
          content: {
            type: 'string',
            description: 'Full text content to write.',
          },
        },
        required: ['path', 'content'],
      },
      async run(args) {
        const target = resolveWorkspacePath(context.cwd, args.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, args.content, 'utf8')
        return `Wrote ${args.content.length} characters to ${target}`
      },
    },
    {
      source: 'builtin',
      name: 'search_code',
      description:
        'Search the workspace using ripgrep. Good for finding symbols, text, or patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query for ripgrep.',
          },
          path: {
            type: 'string',
            description: 'Optional relative path inside the workspace.',
          },
        },
        required: ['query'],
      },
      async run(args) {
        const target = resolveWorkspacePath(context.cwd, args.path || '.')
        const { stdout } = await execFileAsync(
          'rg',
          [
            '-n',
            '--hidden',
            '--glob',
            '!node_modules',
            '--glob',
            '!.git',
            args.query,
            target,
          ],
          {
            cwd: context.cwd,
            maxBuffer: 1024 * 1024,
          },
        )
        return truncate(stdout || 'No matches found')
      },
    },
    {
      source: 'builtin',
      name: 'run_shell',
      approvalCategory: 'shell',
      description:
        'Run a shell command inside the workspace. Use carefully and keep commands focused.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Optional timeout in milliseconds.',
          },
        },
        required: ['command'],
      },
      async run(args) {
        return runShell(args.command, context.cwd, args.timeoutMs ?? 60_000)
      },
    },
  ]
}

function isAutoApproved(tool, settings) {
  switch (tool.approvalCategory) {
    case 'shell':
      return settings.autoApproveShell
    case 'file_write':
      return settings.autoApproveFileWrite
    case 'computer_use':
      return settings.autoApproveComputerUse
    case 'chrome_automation':
      return settings.autoApproveChromeAutomation
    default:
      return true
  }
}

function emitToolEvent(event, toolEvents, hooks) {
  toolEvents.push(event)
  hooks?.onToolEvent?.(event)
}

export async function invokeTool(tool, args, toolEvents, hooks = {}) {
  if (tool.approvalCategory && !isAutoApproved(tool, hooks.settings || {})) {
    const decision = await hooks.requestApproval?.({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: tool.approvalCategory,
      toolName: tool.name,
      summary: tool.description,
      input: stringifyOutput(args ?? {}),
    })

    if (decision !== 'approve') {
      const denialEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source: tool.source,
        name: tool.name,
        summary: `${tool.description} (denied by user)`,
        status: 'error',
        input: stringifyOutput(args ?? {}),
        error: 'Tool execution was denied by the user.',
      }
      emitToolEvent(denialEvent, toolEvents, hooks)
      return `Tool ${tool.name} was denied by the user.`
    }
  }

  try {
    const output = await tool.run(args)
    emitToolEvent({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: tool.source,
      name: tool.name,
      summary: tool.description,
      status: 'success',
      input: stringifyOutput(args ?? {}),
      output: stringifyOutput(output),
    }, toolEvents, hooks)
    return stringifyOutput(output)
  } catch (error) {
    const detail = formatToolError(error)
    emitToolEvent({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: tool.source,
      name: tool.name,
      summary: tool.description,
      status: 'error',
      input: stringifyOutput(args ?? {}),
      error: detail,
    }, toolEvents, hooks)
    return `Tool ${tool.name} failed.\n\n${detail}`
  }
}
