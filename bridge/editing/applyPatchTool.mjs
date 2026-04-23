import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveWorkspacePath } from '../utils.mjs'
import { verifyWorkspaceTextMutation } from './fileVerification.mjs'

function normalizePatchText(value) {
  return String(value || '').replace(/\r\n/g, '\n')
}

function splitPatchLines(value) {
  const lines = normalizePatchText(value).split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function isOperationLine(line) {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  )
}

function ensurePatchPath(relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`${label} must not be empty.`)
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be workspace-relative, received absolute path: ${relativePath}`)
  }
  return relativePath.trim()
}

function joinAddFileContent(contentLines) {
  if (contentLines.length === 0) {
    return ''
  }
  return `${contentLines.join('\n')}\n`
}

function splitFileContent(content) {
  const normalized = normalizePatchText(content)
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

function parsePatch(patchText) {
  const lines = splitPatchLines(patchText)
  if (lines[0] !== '*** Begin Patch') {
    throw new Error('Patch must start with "*** Begin Patch".')
  }

  const operations = []
  let sawEndPatch = false
  let index = 1

  while (index < lines.length) {
    const line = lines[index]

    if (line === '*** End Patch') {
      sawEndPatch = true
      index += 1
      break
    }

    if (line.startsWith('*** Add File: ')) {
      const relativePath = ensurePatchPath(line.slice('*** Add File: '.length), 'Add file path')
      index += 1
      const contentLines = []

      while (index < lines.length && !isOperationLine(lines[index]) && lines[index] !== '*** End Patch') {
        const contentLine = lines[index]
        if (!contentLine.startsWith('+')) {
          throw new Error(`Add File patch lines must start with "+": ${contentLine}`)
        }
        contentLines.push(contentLine.slice(1))
        index += 1
      }

      operations.push({
        kind: 'add',
        path: relativePath,
        content: joinAddFileContent(contentLines),
      })
      continue
    }

    if (line.startsWith('*** Delete File: ')) {
      const relativePath = ensurePatchPath(line.slice('*** Delete File: '.length), 'Delete file path')
      operations.push({
        kind: 'delete',
        path: relativePath,
      })
      index += 1
      continue
    }

    if (line.startsWith('*** Update File: ')) {
      const relativePath = ensurePatchPath(line.slice('*** Update File: '.length), 'Update file path')
      index += 1
      let moveTo

      if (index < lines.length && lines[index].startsWith('*** Move to: ')) {
        moveTo = ensurePatchPath(lines[index].slice('*** Move to: '.length), 'Move target path')
        index += 1
      }

      const hunks = []
      while (index < lines.length) {
        const nextLine = lines[index]
        if (nextLine === '*** End Patch' || isOperationLine(nextLine)) {
          break
        }
        if (!nextLine.startsWith('@@')) {
          throw new Error(`Update File expected hunk header "@@", received: ${nextLine}`)
        }

        const hunk = {
          header: nextLine === '@@' ? '' : nextLine.slice(2).trim(),
          lines: [],
          endOfFile: false,
        }
        index += 1

        while (index < lines.length) {
          const changeLine = lines[index]
          if (changeLine === '*** End Patch' || isOperationLine(changeLine) || changeLine.startsWith('@@')) {
            break
          }
          if (changeLine === '*** End of File') {
            hunk.endOfFile = true
            index += 1
            continue
          }

          const prefix = changeLine.slice(0, 1)
          if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
            throw new Error(`Unexpected patch line inside hunk: ${changeLine}`)
          }

          hunk.lines.push({
            type:
              prefix === ' '
                ? 'context'
                : prefix === '+'
                  ? 'add'
                  : 'remove',
            text: changeLine.slice(1),
          })
          index += 1
        }

        if (hunk.lines.length === 0) {
          throw new Error(`Update File hunk for ${relativePath} must contain at least one change line.`)
        }

        hunks.push(hunk)
      }

      if (hunks.length === 0) {
        throw new Error(`Update File patch for ${relativePath} must include at least one hunk.`)
      }

      operations.push({
        kind: 'update',
        path: relativePath,
        moveTo,
        hunks,
      })
      continue
    }

    throw new Error(`Unexpected patch line: ${line}`)
  }

  if (!sawEndPatch) {
    throw new Error('Patch must end with "*** End Patch".')
  }

  const trailingLines = lines.slice(index).filter(line => line.trim())
  if (trailingLines.length > 0) {
    throw new Error(`Unexpected trailing patch content: ${trailingLines[0]}`)
  }

  if (operations.length === 0) {
    throw new Error('Patch must contain at least one file operation.')
  }

  return {
    operations,
  }
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
  const newContent = applyUpdateHunksToContent(oldContent, operation)

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

function buildPatchSummary(files) {
  const counts = files.reduce(
    (summary, file) => {
      summary[file.kind] = (summary[file.kind] || 0) + 1
      return summary
    },
    {
      add: 0,
      update: 0,
      delete: 0,
      move: 0,
    },
  )

  return [
    counts.add > 0 ? `added ${counts.add}` : null,
    counts.update > 0 ? `updated ${counts.update}` : null,
    counts.move > 0 ? `moved ${counts.move}` : null,
    counts.delete > 0 ? `deleted ${counts.delete}` : null,
  ]
    .filter(Boolean)
    .join(', ')
}

export async function applyPatchInWorkspace(rootPath, patchText, runtime = {}) {
  const parsed = parsePatch(patchText)
  const verifiedChanges = []

  for (const operation of parsed.operations) {
    verifiedChanges.push(await buildVerifiedChange(rootPath, operation, runtime))
  }

  const files = []
  for (const change of verifiedChanges) {
    runtime.throwIfAborted?.()

    if (change.kind === 'add') {
      await fs.mkdir(path.dirname(change.path), { recursive: true })
      await fs.writeFile(change.path, change.newContent, 'utf8')
      const verification = await verifyWorkspaceTextMutation(change.path, {
        existedBefore: false,
        expectedContent: change.newContent,
      })
      files.push({
        kind: 'add',
        path: verification.path,
        relativePath: change.relativePath,
        ...verification,
      })
      continue
    }

    if (change.kind === 'delete') {
      await fs.rm(change.path)
      const verification = await verifyWorkspaceTextMutation(change.path, {
        allowMissing: true,
      })
      files.push({
        kind: 'delete',
        path: change.path,
        relativePath: change.relativePath,
        ...verification,
      })
      continue
    }

    if (change.kind === 'move') {
      await fs.mkdir(path.dirname(change.destinationPath), { recursive: true })
      await fs.writeFile(change.destinationPath, change.newContent, 'utf8')
      await fs.rm(change.path)
      const verification = await verifyWorkspaceTextMutation(change.destinationPath, {
        existedBefore: false,
        expectedContent: change.newContent,
      })
      const sourceVerification = await verifyWorkspaceTextMutation(change.path, {
        allowMissing: true,
      })
      files.push({
        kind: 'move',
        path: verification.path,
        relativePath: change.destinationRelativePath,
        movedFrom: change.relativePath,
        sourceRemoved: sourceVerification.verified,
        ...verification,
      })
      continue
    }

    await fs.writeFile(change.path, change.newContent, 'utf8')
    const verification = await verifyWorkspaceTextMutation(change.path, {
      existedBefore: true,
      expectedContent: change.newContent,
    })
    files.push({
      kind: 'update',
      path: verification.path,
      relativePath: change.relativePath,
      ...verification,
    })
  }

  return {
    ok: files.every(file => file.verified === true),
    files,
    verified: files.every(file => file.verified === true),
    summary: buildPatchSummary(files) || `patched ${files.length} file(s)`,
  }
}
