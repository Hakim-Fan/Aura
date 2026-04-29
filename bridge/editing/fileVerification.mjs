import crypto from 'node:crypto'
import fs from 'node:fs/promises'

function normalizeTextForComparison(value) {
  return String(value ?? '').replace(/\r\n/g, '\n')
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function sha256Text(value) {
  return sha256(Buffer.from(String(value ?? ''), 'utf8'))
}

function splitDiffLines(value) {
  const normalized = normalizeTextForComparison(value)
  if (!normalized) {
    return []
  }
  const lines = normalized.split('\n')
  if (normalized.endsWith('\n')) {
    lines.pop()
  }
  return lines
}

export function buildTextDiffStat(beforeContent, afterContent) {
  const beforeLines = splitDiffLines(beforeContent)
  const afterLines = splitDiffLines(afterContent)

  let prefixLength = 0
  while (
    prefixLength < beforeLines.length &&
    prefixLength < afterLines.length &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength + prefixLength < beforeLines.length &&
    suffixLength + prefixLength < afterLines.length &&
    beforeLines[beforeLines.length - 1 - suffixLength] ===
      afterLines[afterLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const removedLines = beforeLines.length - prefixLength - suffixLength
  const addedLines = afterLines.length - prefixLength - suffixLength

  return {
    beforeLines: beforeLines.length,
    afterLines: afterLines.length,
    addedLines,
    removedLines,
  }
}

export function buildTextMutationEvidence(beforeContent, afterContent) {
  const beforeSha256 = sha256Text(beforeContent)
  const afterSha256 = sha256Text(afterContent)

  return {
    beforeSha256,
    afterSha256,
    changed: beforeSha256 !== afterSha256,
    diffStat: buildTextDiffStat(beforeContent, afterContent),
  }
}

export async function verifyWorkspaceTextMutation(targetPath, options = {}) {
  const existedBefore = options.existedBefore === true
  const allowMissing = options.allowMissing === true
  const expectedContent =
    typeof options.expectedContent === 'string' ? options.expectedContent : null
  const beforeContent =
    typeof options.beforeContent === 'string'
      ? options.beforeContent
      : existedBefore === false
        ? ''
        : null
  const fallbackBeforeSha256 =
    typeof options.beforeSha256 === 'string' ? options.beforeSha256 : undefined

  let stats
  try {
    stats = await fs.stat(targetPath)
  } catch (error) {
    if (allowMissing && error && typeof error === 'object' && error.code === 'ENOENT') {
      const removalEvidence =
        beforeContent !== null
          ? {
              beforeSha256: sha256Text(beforeContent),
              afterSha256: '',
              changed: true,
              diffStat: buildTextDiffStat(beforeContent, ''),
            }
          : {
              beforeSha256: fallbackBeforeSha256,
              afterSha256: '',
              changed: fallbackBeforeSha256 ? true : undefined,
            }
      return {
        path: targetPath,
        exists: false,
        bytes: 0,
        sha256: '',
        ...removalEvidence,
        readBackOk: false,
        created: false,
        updated: false,
        removed: true,
        verified: true,
      }
    }
    throw error
  }

  const buffer = await fs.readFile(targetPath)
  const actualContent = buffer.toString('utf8')
  const afterSha256 = sha256(buffer)
  const mutationEvidence =
    beforeContent !== null
      ? buildTextMutationEvidence(beforeContent, actualContent)
      : {
          beforeSha256: fallbackBeforeSha256,
          afterSha256,
          changed: fallbackBeforeSha256
            ? fallbackBeforeSha256 !== afterSha256
            : undefined,
        }
  const readBackOk =
    expectedContent === null
      ? true
      : normalizeTextForComparison(actualContent) ===
        normalizeTextForComparison(expectedContent)

  return {
    path: targetPath,
    exists: true,
    bytes: stats.size,
    sha256: afterSha256,
    ...mutationEvidence,
    readBackOk,
    created: !existedBefore,
    updated: existedBefore,
    removed: false,
    verified: readBackOk,
  }
}
