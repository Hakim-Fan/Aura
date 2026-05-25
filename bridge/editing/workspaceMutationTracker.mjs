import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_MAX_ENTRIES = 6_000
const DEFAULT_MAX_DIFF_LINES = 80
const DEFAULT_MAX_PREVIEW_BYTES = 160_000
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  'target',
])

const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.scss',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
])

function normalizeRoot(root) {
  return typeof root === 'string' && root.trim() ? path.resolve(root.trim()) : ''
}

function toRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/')
}

function shouldSkipDirectory(name) {
  return SKIPPED_DIRECTORIES.has(name)
}

function isProbablyTextFile(relativePath) {
  return TEXT_PREVIEW_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
}

function countLines(text) {
  if (!text) {
    return 0
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  return normalized ? normalized.split(/\r?\n/u).length : 0
}

async function maybeReadTextPreview(root, relativePath, size, maxBytes) {
  if (!isProbablyTextFile(relativePath) || size > maxBytes) {
    return null
  }
  try {
    const text = await fs.readFile(path.join(root, relativePath), 'utf8')
    return text
  } catch {
    return null
  }
}

export async function snapshotWorkspaceFiles(root, options = {}) {
  const workspaceRoot = normalizeRoot(root)
  const maxEntries = Math.max(1, Math.round(Number(options.maxEntries) || DEFAULT_MAX_ENTRIES))
  const files = new Map()
  let truncated = false

  async function walk(directory) {
    if (files.size >= maxEntries) {
      truncated = true
      return
    }

    let entries = []
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.size >= maxEntries) {
        truncated = true
        return
      }

      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          await walk(path.join(directory, entry.name))
        }
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const absolutePath = path.join(directory, entry.name)
      try {
        const stat = await fs.stat(absolutePath)
        files.set(toRelativePath(workspaceRoot, absolutePath), {
          size: stat.size,
          mtimeMs: Math.round(stat.mtimeMs),
        })
      } catch {
        // Ignore files that disappeared during the scan.
      }
    }
  }

  if (workspaceRoot) {
    await walk(workspaceRoot)
  }

  return {
    root: workspaceRoot,
    files,
    truncated,
    capturedAt: Date.now(),
  }
}

async function buildChangedFile(root, relativePath, kind, before, after, options = {}) {
  const maxDiffLines = Math.max(1, Math.round(Number(options.maxDiffLines) || DEFAULT_MAX_DIFF_LINES))
  const maxPreviewBytes = Math.max(1024, Math.round(Number(options.maxPreviewBytes) || DEFAULT_MAX_PREVIEW_BYTES))
  const text = after ? await maybeReadTextPreview(root, relativePath, after.size, maxPreviewBytes) : null
  const lineCount = text === null ? 0 : countLines(text)
  const diffLines = []
  let diffTruncated = false

  if (kind === 'create' && text !== null) {
    const lines = text.split(/\r?\n/u)
    for (const [index, line] of lines.slice(0, maxDiffLines).entries()) {
      diffLines.push({
        type: 'add',
        newLine: index + 1,
        text: line,
      })
    }
    diffTruncated = lines.length > maxDiffLines
  } else if (kind === 'update') {
    diffLines.push({
      type: 'truncated',
      text: 'File was modified by a shell command; exact line diff was not captured.',
    })
  } else if (kind === 'delete') {
    diffLines.push({
      type: 'truncated',
      text: 'File was deleted by a shell command.',
    })
  }

  return {
    path: relativePath,
    relativePath,
    kind,
    changed: true,
    exists: kind !== 'delete',
    size: after?.size,
    previousSize: before?.size,
    mtimeMs: after?.mtimeMs,
    previousMtimeMs: before?.mtimeMs,
    diffStat: {
      addedLines: kind === 'create' ? lineCount : 0,
      removedLines: 0,
    },
    diffPreview: {
      lines: diffLines,
      truncated: diffTruncated,
    },
  }
}

export async function detectWorkspaceFileMutations(beforeSnapshot, options = {}) {
  const root = normalizeRoot(beforeSnapshot?.root)
  if (!root) {
    return null
  }

  const afterSnapshot = await snapshotWorkspaceFiles(root, options)
  const changed = []

  for (const [relativePath, after] of afterSnapshot.files.entries()) {
    const before = beforeSnapshot.files.get(relativePath)
    if (!before) {
      changed.push(await buildChangedFile(root, relativePath, 'create', null, after, options))
      continue
    }
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      changed.push(await buildChangedFile(root, relativePath, 'update', before, after, options))
    }
  }

  for (const [relativePath, before] of beforeSnapshot.files.entries()) {
    if (!afterSnapshot.files.has(relativePath)) {
      changed.push(await buildChangedFile(root, relativePath, 'delete', before, null, options))
    }
  }

  if (changed.length === 0) {
    return null
  }

  const files = changed.slice(0, Math.max(1, Math.round(Number(options.maxChangedFiles) || 24)))
  const affectedPaths = files.map(file => file.path)
  return {
    stage: 'shell_file_mutation',
    operation: 'shell_file_mutation',
    summary: `${affectedPaths.length} file${affectedPaths.length === 1 ? '' : 's'} changed by shell command.`,
    affectedPaths,
    files,
    preview: files,
    fileChanges: files,
    truncated: changed.length > files.length || beforeSnapshot.truncated || afterSnapshot.truncated,
  }
}

export function attachWorkspaceFileMutations(output, mutationSummary) {
  if (!mutationSummary || !Array.isArray(mutationSummary.files) || mutationSummary.files.length === 0) {
    return output
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return output
  }
  return {
    ...output,
    ...mutationSummary,
    shell: output.shell,
    command: output.command,
    cwd: output.cwd,
    stdout: output.stdout,
    stderr: output.stderr,
    output: output.output,
  }
}
