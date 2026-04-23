import crypto from 'node:crypto'
import fs from 'node:fs/promises'

function normalizeTextForComparison(value) {
  return String(value ?? '').replace(/\r\n/g, '\n')
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export async function verifyWorkspaceTextMutation(targetPath, options = {}) {
  const existedBefore = options.existedBefore === true
  const allowMissing = options.allowMissing === true
  const expectedContent =
    typeof options.expectedContent === 'string' ? options.expectedContent : null

  let stats
  try {
    stats = await fs.stat(targetPath)
  } catch (error) {
    if (allowMissing && error && typeof error === 'object' && error.code === 'ENOENT') {
      return {
        path: targetPath,
        exists: false,
        bytes: 0,
        sha256: '',
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
  const readBackOk =
    expectedContent === null
      ? true
      : normalizeTextForComparison(actualContent) ===
        normalizeTextForComparison(expectedContent)

  return {
    path: targetPath,
    exists: true,
    bytes: stats.size,
    sha256: sha256(buffer),
    readBackOk,
    created: !existedBefore,
    updated: existedBefore,
    removed: false,
    verified: readBackOk,
  }
}
