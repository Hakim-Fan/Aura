import fs from 'node:fs/promises'
import path from 'node:path'
import {
  buildTextDiffPreview,
  buildTextMutationEvidence,
  verifyWorkspaceTextMutation,
} from './fileVerification.mjs'

function buildTransactionId() {
  return `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function pathLabelForChange(change) {
  if (!change || typeof change !== 'object') {
    return ''
  }
  if (change.kind === 'move') {
    return change.destinationRelativePath || change.destinationPath || change.relativePath || change.path || ''
  }
  return change.relativePath || change.path || ''
}

function affectedPathsForChanges(changes) {
  return Array.from(
    new Set(
      changes
        .flatMap(change =>
          change?.kind === 'move'
            ? [
                change.relativePath || change.path,
                change.destinationRelativePath || change.destinationPath,
              ]
            : [change?.relativePath || change?.path],
        )
        .filter(Boolean),
    ),
  )
}

function normalizeChangeEvidence(change) {
  const beforeContent =
    typeof change?.oldContent === 'string'
      ? change.oldContent
      : change?.kind === 'add'
        ? ''
        : ''
  const afterContent =
    change?.kind === 'delete'
      ? ''
      : typeof change?.newContent === 'string'
        ? change.newContent
        : ''
  const evidence =
    typeof change?.beforeSha256 === 'string' &&
    typeof change?.afterSha256 === 'string' &&
    change?.diffStat
      ? {
          beforeSha256: change.beforeSha256,
          afterSha256: change.afterSha256,
          changed: change.changed,
          diffStat: change.diffStat,
        }
      : buildTextMutationEvidence(beforeContent, afterContent)

  return {
    ...evidence,
    diffPreview: change?.diffPreview || buildTextDiffPreview(beforeContent, afterContent),
  }
}

export function summarizeEditingChangePreview(change) {
  const evidence = normalizeChangeEvidence(change)
  return {
    kind: change.kind,
    path: pathLabelForChange(change),
    movedFrom: change.kind === 'move' ? change.relativePath : undefined,
    beforeSha256: evidence.beforeSha256,
    afterSha256: evidence.afterSha256,
    changed: evidence.changed,
    diffStat: evidence.diffStat,
    diffPreview: evidence.diffPreview,
  }
}

function summarizeAppliedFiles(files) {
  return Array.isArray(files)
    ? files.map(file => ({
        kind: file.kind,
        path: file.relativePath || file.path,
        verified: file.verified === true,
      }))
    : []
}

function buildReversibleSnapshotChange(change) {
  return {
    kind: change.kind,
    path: change.path,
    relativePath: change.relativePath,
    destinationPath: change.destinationPath,
    destinationRelativePath: change.destinationRelativePath,
    oldContent: typeof change.oldContent === 'string' ? change.oldContent : '',
    newContent: typeof change.newContent === 'string' ? change.newContent : '',
  }
}

async function recordEditingTransactionSnapshot(normalized, runtime = {}) {
  if (typeof runtime.appControl !== 'function') {
    return false
  }

  try {
    const result = await runtime.appControl('record_edit_transaction_snapshot', {
      transactionId: normalized.id,
      operation: normalized.operation,
      affectedPaths: normalized.affectedPaths,
      changes: normalized.changes.map(buildReversibleSnapshotChange),
    })
    return result?.stored === true
  } catch {
    return false
  }
}

export function normalizeEditingTransaction(transaction = {}) {
  const changes = Array.isArray(transaction.changes) ? transaction.changes : []
  const affectedPaths =
    Array.isArray(transaction.affectedPaths) && transaction.affectedPaths.length > 0
      ? transaction.affectedPaths
      : affectedPathsForChanges(changes)
  const preview =
    Array.isArray(transaction.preview) && transaction.preview.length > 0
      ? transaction.preview
      : changes.map(summarizeEditingChangePreview)
  return {
    ...transaction,
    id: transaction.id || buildTransactionId(),
    operation: transaction.operation || 'edit_transaction',
    changes,
    affectedPaths,
    preview,
    summary:
      transaction.summary ||
      `${transaction.operation || 'edit_transaction'} ${changes.length} file(s)`,
  }
}

export function buildEditingTransactionPreview(transaction = {}, options = {}) {
  const normalized = normalizeEditingTransaction(transaction)
  const phase = options.phase || 'preview'
  return {
    stage: 'edit_transaction_preview',
    phase,
    transactionId: normalized.id,
    operation: 'edit_transaction',
    sourceOperation: normalized.operation,
    total: normalized.changes.length,
    affectedPaths: normalized.affectedPaths,
    preview: normalized.preview,
    files: normalized.preview,
    summary:
      options.summary ||
      (phase === 'approval_preview'
        ? `Editing approval preview ready for ${normalized.changes.length} file(s).`
        : normalized.summary),
  }
}

export async function applyEditingTransaction(transaction = {}, runtime = {}) {
  const normalized = normalizeEditingTransaction(transaction)
  const files = []

  runtime.onUpdate?.({
    stage: 'edit_transaction_begin',
    transactionId: normalized.id,
    operation: 'edit_transaction',
    sourceOperation: normalized.operation,
    total: normalized.changes.length,
    affectedPaths: normalized.affectedPaths,
    summary: normalized.summary,
  })

  runtime.onUpdate?.(buildEditingTransactionPreview(normalized))
  const reversible = await recordEditingTransactionSnapshot(normalized, runtime)

  runtime.onUpdate?.({
    stage: 'edit_transaction_apply',
    phase: 'applying',
    transactionId: normalized.id,
    operation: 'edit_transaction',
    sourceOperation: normalized.operation,
    completed: 0,
    total: normalized.changes.length,
    summary: `Applying ${normalized.operation} transaction to ${normalized.changes.length} file(s).`,
  })

  for (let index = 0; index < normalized.changes.length; index += 1) {
    const change = normalized.changes[index]
    runtime.throwIfAborted?.()

    if (change.kind === 'add') {
      await fs.mkdir(path.dirname(change.path), { recursive: true })
      await fs.writeFile(change.path, change.newContent, 'utf8')
      const verification = await verifyWorkspaceTextMutation(change.path, {
        existedBefore: false,
        expectedContent: change.newContent,
        beforeContent: '',
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
        beforeContent: change.oldContent,
      })
      files.push({
        kind: 'delete',
        path: verification.path || change.path,
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
        beforeContent: '',
      })
      const sourceVerification = await verifyWorkspaceTextMutation(change.path, {
        allowMissing: true,
        beforeContent: change.oldContent,
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
        beforeContent: change.oldContent,
      })
      files.push({
        kind: 'update',
        path: verification.path,
        relativePath: change.relativePath,
        ...verification,
      })
    }

    runtime.onUpdate?.({
      stage: 'edit_transaction_progress',
      phase: 'applied',
      transactionId: normalized.id,
      operation: 'edit_transaction',
      sourceOperation: normalized.operation,
      completed: index + 1,
      total: normalized.changes.length,
      path: pathLabelForChange(change),
      summary: `Applied ${index + 1}/${normalized.changes.length}: ${pathLabelForChange(change)}`,
    })
  }

  const ok = files.every(file => file.verified === true)
  runtime.onUpdate?.({
    stage: 'edit_transaction_verify',
    phase: 'verified',
    transactionId: normalized.id,
    operation: 'edit_transaction',
    sourceOperation: normalized.operation,
    verified: ok,
    totalFiles: files.length,
    files: summarizeAppliedFiles(files),
    summary: ok
      ? `Verified ${files.length} edited file(s).`
      : `Verification failed for ${files.length} edited file(s).`,
  })

  const primaryFile = files.length === 1 ? files[0] : {}
  const result = {
    operation: normalized.operation,
    transactionOperation: 'edit_transaction',
    transactionId: normalized.id,
    ok,
    verified: ok,
    reversible,
    ...primaryFile,
    ...(normalized.resultFields || {}),
    files,
    preview: normalized.preview,
    affectedPaths: normalized.affectedPaths,
    counts: normalized.counts || undefined,
    summary: normalized.summary,
  }

  runtime.onUpdate?.({
    stage: 'edit_transaction_end',
    transactionId: normalized.id,
    operation: 'edit_transaction',
    sourceOperation: normalized.operation,
    ok,
    verified: ok,
    totalFiles: files.length,
    files: summarizeAppliedFiles(files),
    summary: result.summary,
  })

  return result
}
