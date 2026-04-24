import fs from 'node:fs/promises'
import path from 'node:path'
import { verifyWorkspaceTextMutation } from './fileVerification.mjs'

function buildProgressLabel(change) {
  if (!change || typeof change !== 'object') {
    return ''
  }

  if (change.kind === 'move') {
    return `${change.relativePath} -> ${change.destinationRelativePath}`
  }

  return change.relativePath || ''
}

function summarizeAppliedFiles(files) {
  return Array.isArray(files)
    ? files.map(file => ({
        kind: file.kind,
        path: file.relativePath,
        verified: file.verified === true,
      }))
    : []
}

export async function applyVerifiedPatch(verifiedPatch, runtime = {}) {
  const changes = Array.isArray(verifiedPatch?.changes) ? verifiedPatch.changes : []
  const total = changes.length
  const files = []

  runtime.onUpdate?.({
    stage: 'patch_progress',
    phase: 'applying',
    completed: 0,
    total,
    summary: verifiedPatch?.summary || `Applying patch to ${total} file(s).`,
  })

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]
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
    } else if (change.kind === 'delete') {
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
    } else if (change.kind === 'move') {
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
    } else {
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

    runtime.onUpdate?.({
      stage: 'patch_progress',
      phase: 'applied',
      completed: index + 1,
      total,
      path: buildProgressLabel(change),
      summary: `Applied ${index + 1}/${total}: ${buildProgressLabel(change)}`,
    })
  }

  const ok = files.every(file => file.verified === true)
  const result = {
    ok,
    files,
    verified: ok,
    counts: verifiedPatch?.counts || undefined,
    affectedPaths: verifiedPatch?.affectedPaths || undefined,
    summary: verifiedPatch?.summary || `patched ${files.length} file(s)`,
  }

  runtime.onUpdate?.({
    stage: 'patch_end',
    ok,
    verified: ok,
    totalFiles: files.length,
    summary: result.summary,
    files: summarizeAppliedFiles(files),
  })

  return result
}
