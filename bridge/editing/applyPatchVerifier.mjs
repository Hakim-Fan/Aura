import fs from 'node:fs/promises'
import { createStructuredError } from '../runtimeErrors.mjs'
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

function normalizePatchLine(value) {
  return String(value || '')
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, ' ')
}

function patchLinesMatch(actual, expected, mode) {
  switch (mode) {
    case 'exact':
      return actual === expected
    case 'rstrip':
      return actual.trimEnd() === expected.trimEnd()
    case 'trim':
      return actual.trim() === expected.trim()
    case 'normalized':
      return normalizePatchLine(actual) === normalizePatchLine(expected)
    default:
      return false
  }
}

function findSequenceStartWithMode(lines, sequence, startIndex, mode) {
  if (sequence.length === 0) {
    return -1
  }
  if (sequence.length > lines.length) {
    return -1
  }

  for (let index = Math.max(0, startIndex); index <= lines.length - sequence.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (!patchLinesMatch(lines[index + offset], sequence[offset], mode)) {
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

function findSequenceStart(lines, sequence, startIndex) {
  for (const mode of ['exact', 'rstrip', 'trim', 'normalized']) {
    const start = findSequenceStartWithMode(lines, sequence, startIndex, mode)
    if (start >= 0) {
      return start
    }
  }
  return -1
}

function buildPatchContextMismatchError(operation, hunk, cursor, headerStart, lineCount) {
  const anchorLine = headerStart >= 0 ? headerStart + 1 : cursor + 1
  const startLine = Math.max(1, anchorLine - 20)
  const endLine = Math.min(lineCount, anchorLine + 80)
  const expectedText = hunk.lines
    .filter(entry => entry.type === 'context' || entry.type === 'remove')
    .map(entry => entry.text)
    .join('\n')
  return createStructuredError(
    `Patch context did not match the current content of ${operation.path}.`,
    {
      source: 'tool',
      category: 'patch_context_mismatch',
      code: 'PATCH_CONTEXT_MISMATCH',
      detail: [
        `Patch context did not match the current content of ${operation.path}.`,
        hunk.header ? `Hunk header: ${hunk.header}` : null,
        expectedText ? `Expected context:\n${expectedText}` : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      suggestedAction:
        '请用 repairHint 中的 read_file 参数重新读取目标文件最新上下文，再基于返回内容生成新的 apply_patch；不要重复提交同一个失效补丁。',
      repairHint: {
        useTool: 'read_file',
        args: {
          path: operation.path,
          startLine,
          endLine,
          mode: 'edit_context',
        },
        nextTool: 'apply_patch',
      },
    },
  )
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

    const headerStart = hunk.header
      ? findSequenceStart(lines, [hunk.header], cursor)
      : -1
    const searchCursor = headerStart >= 0 ? headerStart + 1 : cursor
    const start = findSequenceStart(lines, oldLines, searchCursor)
    if (start < 0) {
      throw buildPatchContextMismatchError(
        operation,
        hunk,
        cursor,
        headerStart,
        lines.length,
      )
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
