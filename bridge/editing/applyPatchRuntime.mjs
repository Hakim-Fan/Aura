import { applyEditingTransaction } from './editingTransaction.mjs'

export async function applyVerifiedPatch(verifiedPatch, runtime = {}) {
  const changes = Array.isArray(verifiedPatch?.changes) ? verifiedPatch.changes : []
  const total = changes.length

  runtime.onUpdate?.({
    stage: 'patch_progress',
    phase: 'applying',
    completed: 0,
    total,
    summary: verifiedPatch?.summary || `Applying patch to ${total} file(s).`,
  })

  const transaction = {
    operation: 'apply_patch',
    changes,
    counts: verifiedPatch?.counts || undefined,
    affectedPaths: verifiedPatch?.affectedPaths || undefined,
    preview: verifiedPatch?.preview || undefined,
    summary: verifiedPatch?.summary || `patched ${changes.length} file(s)`,
  }

  const result = await applyEditingTransaction(transaction, {
    ...runtime,
    onUpdate(update) {
      runtime.onUpdate?.(update)
      if (update?.stage === 'edit_transaction_progress' && update.phase === 'applied') {
        runtime.onUpdate?.({
          stage: 'patch_progress',
          phase: 'applied',
          completed: update.completed,
          total: update.total,
          path: update.path,
          summary: update.summary,
        })
      }
    },
  })

  runtime.onUpdate?.({
    stage: 'patch_end',
    ok: result.ok,
    verified: result.verified,
    totalFiles: result.files.length,
    summary: result.summary,
    files: result.files.map(file => ({
      kind: file.kind,
      path: file.relativePath,
      verified: file.verified === true,
    })),
  })
  return result
}
