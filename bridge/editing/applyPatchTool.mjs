import { parsePatch } from './applyPatchParser.mjs'
import { applyVerifiedPatch } from './applyPatchRuntime.mjs'
import { verifyPatchAgainstWorkspace } from './applyPatchVerifier.mjs'

function buildOperationPathList(operations) {
  return Array.from(
    new Set(
      (Array.isArray(operations) ? operations : []).flatMap(operation =>
        operation?.kind === 'update' && operation.moveTo
          ? [operation.path, operation.moveTo]
          : [operation?.path],
      ),
    ),
  ).filter(Boolean)
}

export async function applyPatchInWorkspace(rootPath, patchText, runtime = {}) {
  const parsedPatch = parsePatch(patchText)
  runtime.onUpdate?.({
    stage: 'patch_begin',
    operationCount: parsedPatch.operations.length,
    paths: buildOperationPathList(parsedPatch.operations),
    summary: `Preparing patch with ${parsedPatch.operations.length} operation(s).`,
  })

  const verifiedPatch = await verifyPatchAgainstWorkspace(rootPath, parsedPatch, runtime)
  runtime.onUpdate?.({
    stage: 'patch_progress',
    phase: 'preview',
    total: verifiedPatch.changes.length,
    affectedPaths: verifiedPatch.affectedPaths,
    files: verifiedPatch.preview,
    summary: `Patch preview ready for ${verifiedPatch.changes.length} file(s).`,
  })
  runtime.onUpdate?.({
    stage: 'patch_progress',
    phase: 'verified',
    total: verifiedPatch.changes.length,
    affectedPaths: verifiedPatch.affectedPaths,
    summary: verifiedPatch.summary,
  })

  return applyVerifiedPatch(verifiedPatch, runtime)
}
