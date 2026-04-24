import fs from 'node:fs/promises'
import path from 'node:path'
import { verifyWorkspaceTextMutation } from './fileVerification.mjs'

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function emitMutationEvent(runtime, event) {
  runtime.onUpdate?.(event)
}

function applyExactTextReplacement(content, oldText, newText, options = {}) {
  if (!oldText) {
    throw new Error('oldText must not be empty.')
  }

  const source = String(content)
  const occurrences = source.split(oldText).length - 1
  if (occurrences === 0) {
    throw new Error('oldText was not found in the target file.')
  }

  const replaceAll = options.replaceAll === true
  const expectedReplacements =
    typeof options.expectedReplacements === 'number' && Number.isFinite(options.expectedReplacements)
      ? Math.max(1, Math.round(options.expectedReplacements))
      : replaceAll
        ? occurrences
        : 1

  if (occurrences < expectedReplacements) {
    throw new Error(
      `Expected at least ${expectedReplacements} matching occurrence(s), but found ${occurrences}.`,
    )
  }

  const replacedCount = replaceAll ? occurrences : 1
  const nextContent = replaceAll
    ? source.split(oldText).join(newText)
    : source.replace(oldText, newText)

  return {
    replacedCount,
    beforeLength: source.length,
    afterLength: nextContent.length,
    nextContent,
  }
}

export async function applyWriteFileMutation(targetPath, content, runtime = {}) {
  runtime.throwIfAborted?.()
  emitMutationEvent(runtime, {
    stage: 'text_mutation_begin',
    operation: 'write_file',
    path: targetPath,
  })

  const existedBefore = await pathExists(targetPath)
  runtime.throwIfAborted?.()
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, content, 'utf8')

  const verification = await verifyWorkspaceTextMutation(targetPath, {
    existedBefore,
    expectedContent: content,
  })

  const result = {
    operation: 'write_file',
    ...verification,
  }

  emitMutationEvent(runtime, {
    stage: 'text_mutation_end',
    operation: 'write_file',
    path: targetPath,
    verified: result.verified === true,
    bytes: result.bytes,
  })

  return result
}

export async function applyEditFileMutation(
  targetPath,
  oldText,
  newText,
  options = {},
  runtime = {},
) {
  runtime.throwIfAborted?.()
  emitMutationEvent(runtime, {
    stage: 'text_mutation_begin',
    operation: 'edit_file',
    path: targetPath,
  })

  const content = await fs.readFile(targetPath, 'utf8')
  const replacement = applyExactTextReplacement(content, oldText, newText, options)
  runtime.throwIfAborted?.()
  await fs.writeFile(targetPath, replacement.nextContent, 'utf8')

  const verification = await verifyWorkspaceTextMutation(targetPath, {
    existedBefore: true,
    expectedContent: replacement.nextContent,
  })

  const result = {
    operation: 'edit_file',
    path: targetPath,
    replacedCount: replacement.replacedCount,
    beforeLength: replacement.beforeLength,
    afterLength: replacement.afterLength,
    ...verification,
  }

  emitMutationEvent(runtime, {
    stage: 'text_mutation_end',
    operation: 'edit_file',
    path: targetPath,
    verified: result.verified === true,
    replacedCount: result.replacedCount,
  })

  return result
}

export async function applyMultiEditFileMutation(targetPath, edits, runtime = {}) {
  runtime.throwIfAborted?.()
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('edits must contain at least one replacement.')
  }

  emitMutationEvent(runtime, {
    stage: 'text_mutation_begin',
    operation: 'multi_edit_file',
    path: targetPath,
    totalEdits: edits.length,
  })

  const originalContent = await fs.readFile(targetPath, 'utf8')
  let nextContent = originalContent
  const results = []

  for (let index = 0; index < edits.length; index += 1) {
    runtime.throwIfAborted?.()
    const edit = edits[index]
    const replacement = applyExactTextReplacement(
      nextContent,
      edit.oldText,
      edit.newText,
      {
        replaceAll: edit.replaceAll,
        expectedReplacements: edit.expectedReplacements,
      },
    )
    nextContent = replacement.nextContent
    results.push({
      replacedCount: replacement.replacedCount,
      beforeLength: replacement.beforeLength,
      afterLength: replacement.afterLength,
    })
    emitMutationEvent(runtime, {
      stage: 'text_mutation_progress',
      operation: 'multi_edit_file',
      path: targetPath,
      completedEdits: index + 1,
      totalEdits: edits.length,
      replacedCount: replacement.replacedCount,
    })
  }

  runtime.throwIfAborted?.()
  await fs.writeFile(targetPath, nextContent, 'utf8')
  const verification = await verifyWorkspaceTextMutation(targetPath, {
    existedBefore: true,
    expectedContent: nextContent,
  })

  const result = {
    operation: 'multi_edit_file',
    path: targetPath,
    editsApplied: results.length,
    results,
    ...verification,
  }

  emitMutationEvent(runtime, {
    stage: 'text_mutation_end',
    operation: 'multi_edit_file',
    path: targetPath,
    verified: result.verified === true,
    editsApplied: result.editsApplied,
  })

  return result
}
