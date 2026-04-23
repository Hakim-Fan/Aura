import fs from 'node:fs/promises'
import { resolveWorkspacePath } from '../utils.mjs'

function splitFileContent(content) {
  const normalized = String(content || '').replace(/\r\n/g, '\n')
  if (!normalized) {
    return {
      lines: [],
      hasTrailingNewline: false,
    }
  }

  const hasTrailingNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (hasTrailingNewline) {
    lines.pop()
  }

  return {
    lines,
    hasTrailingNewline,
  }
}

function joinFileContent(lines, hasTrailingNewline) {
  if (lines.length === 0) {
    return hasTrailingNewline ? '\n' : ''
  }
  const text = lines.join('\n')
  return hasTrailingNewline ? `${text}\n` : text
}

function findSequenceStart(lines, sequence, startIndex) {
  if (sequence.length === 0) {
    return -1
  }

  for (let index = Math.max(0, startIndex); index <= lines.length - sequence.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (lines[index + offset] !== sequence[offset]) {
        matched = false
        break
      }
    }
    if (matched) {
      return index
    }
  }

  return -1
}

function applyUpdateHunksToContent(originalContent, operation) {
  const { lines, hasTrailingNewline: originalTrailingNewline } = splitFileContent(originalContent)
  let hasTrailingNewline = originalTrailingNewline
  let cursor = 0

  for (const hunk of operation.hunks) {
    const oldLines = hunk.lines
      .filter(entry => entry.type === 'context' || entry.type === 'remove')
      .map(entry => entry.text)
    const newLines = hunk.lines
      .filter(entry => entry.type === 'context' || entry.type === 'add')
      .map(entry => entry.text)

    if (oldLines.length === 0) {
      throw new Error(
        `Update hunk for ${operation.path} must include at least one context or removed line so it can be anchored safely.`,
      )
    }

    const start = findSequenceStart(lines, oldLines, cursor)
    if (start < 0) {
      throw new Error(`Patch context did not match the current content of ${operation.path}.`)
    }

    lines.splice(start, oldLines.length, ...newLines)
    cursor = start + newLines.length
    if (hunk.endOfFile) {
      hasTrailingNewline = false
    }
  }

  return joinFileContent(lines, hasTrailingNewline)
}

async function ensurePathAbsent(targetPath, label) {
  try {
    await fs.access(targetPath)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return
    }
    throw error
  }

  throw new Error(`${label} already exists: ${targetPath}`)
}

function buildPatchCounts(changes) {
  return changes.reduce(
    (summary, change) => {
      summary[change.kind] = (summary[change.kind] || 0) + 1
      return summary
    },
    {
      add: 0,
      update: 0,
      delete: 0,
      move: 0,
    },
  )
}

function buildPatchSummaryFromCounts(counts) {
  return [
    counts.add > 0 ? `added ${counts.add}` : null,
    counts.update > 0 ? `updated ${counts.update}` : null,
    counts.move > 0 ? `moved ${counts.move}` : null,
    counts.delete > 0 ? `deleted ${counts.delete}` : null,
  ]
    .filter(Boolean)
    .join(', ')
}

function validatePatchOperationConflicts(rootPath, operations) {
  const sourceOwners = new Map()
  const destinationOwners = new Map()

  for (const operation of operations) {
    const sourcePath = resolveWorkspacePath(rootPath, operation.path)
    const previousSource = sourceOwners.get(sourcePath)
    if (previousSource) {
      throw new Error(
        `Patch touches ${operation.path} more than once (${previousSource.kind} and ${operation.kind}). Split these into separate patches.`,
      )
    }
    sourceOwners.set(sourcePath, operation)

    const destinationPath =
      operation.kind === 'add'
        ? sourcePath
        : operation.kind === 'update' && operation.moveTo
          ? resolveWorkspacePath(rootPath, operation.moveTo)
          : sourcePath

    const previousDestination = destinationOwners.get(destinationPath)
    if (previousDestination) {
      throw new Error(
        `Patch would produce multiple final writes to ${operation.kind === 'update' && operation.moveTo ? operation.moveTo : operation.path}. Split these into separate patches.`,
      )
    }
    destinationOwners.set(destinationPath, operation)

    if (
      operation.kind === 'update' &&
      operation.moveTo &&
      sourceOwners.has(destinationPath)
    ) {
      throw new Error(
        `Patch move target ${operation.moveTo} conflicts with another operation in the same patch.`,
      )
    }
  }
}

async function buildVerifiedChange(rootPath, operation, runtime = {}) {
  runtime.throwIfAborted?.()

  if (operation.kind === 'add') {
    const absolutePath = resolveWorkspacePath(rootPath, operation.path)
    await ensurePathAbsent(absolutePath, 'Add File target')
    return {
      kind: 'add',
      path: absolutePath,
      relativePath: operation.path,
      newContent: operation.content,
    }
  }

  if (operation.kind === 'delete') {
    const absolutePath = resolveWorkspacePath(rootPath, operation.path)
    const oldContent = await fs.readFile(absolutePath, 'utf8')
    return {
      kind: 'delete',
      path: absolutePath,
      relativePath: operation.path,
      oldContent,
    }
  }

  const absolutePath = resolveWorkspacePath(rootPath, operation.path)
  const oldContent = await fs.readFile(absolutePath, 'utf8')
  const newContent =
    Array.isArray(operation.hunks) && operation.hunks.length > 0
      ? applyUpdateHunksToContent(oldContent, operation)
      : oldContent

  if (operation.moveTo) {
    const destinationPath = resolveWorkspacePath(rootPath, operation.moveTo)
    if (destinationPath !== absolutePath) {
      await ensurePathAbsent(destinationPath, 'Move target')
    }
    return {
      kind: 'move',
      path: absolutePath,
      relativePath: operation.path,
      destinationPath,
      destinationRelativePath: operation.moveTo,
      oldContent,
      newContent,
    }
  }

  return {
    kind: 'update',
    path: absolutePath,
    relativePath: operation.path,
    oldContent,
    newContent,
  }
}

export async function verifyPatchAgainstWorkspace(rootPath, parsedPatch, runtime = {}) {
  const operations = Array.isArray(parsedPatch?.operations) ? parsedPatch.operations : []
  validatePatchOperationConflicts(rootPath, operations)

  const changes = []
  for (const operation of operations) {
    changes.push(await buildVerifiedChange(rootPath, operation, runtime))
  }

  const counts = buildPatchCounts(changes)
  const affectedPaths = changes.flatMap(change =>
    change.kind === 'move'
      ? [change.relativePath, change.destinationRelativePath]
      : [change.relativePath],
  )

  return {
    cwd: rootPath,
    patch: parsedPatch?.patch || '',
    changes,
    counts,
    affectedPaths: Array.from(new Set(affectedPaths.filter(Boolean))),
    summary: buildPatchSummaryFromCounts(counts) || `patched ${changes.length} file(s)`,
  }
}
