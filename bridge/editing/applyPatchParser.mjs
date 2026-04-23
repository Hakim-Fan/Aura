import path from 'node:path'

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

export function parsePatch(patchText) {
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

      while (
        index < lines.length &&
        !isOperationLine(lines[index]) &&
        lines[index] !== '*** End Patch'
      ) {
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
          if (
            changeLine === '*** End Patch' ||
            isOperationLine(changeLine) ||
            changeLine.startsWith('@@')
          ) {
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

      if (hunks.length === 0 && !moveTo) {
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
    patch: normalizePatchText(patchText).trim(),
    operations,
  }
}
