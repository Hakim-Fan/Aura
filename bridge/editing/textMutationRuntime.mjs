import fs from 'node:fs/promises'
import path from 'node:path'
import { createStructuredError } from '../runtimeErrors.mjs'
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
    throw createStructuredError('edit_file 的 oldText 不能为空。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'EMPTY_OLD_TEXT',
      detail: 'oldText must not be empty.',
      suggestedAction:
        '请先用 read_file 获取当前文件内容，再提供要替换的精确 oldText。',
    })
  }

  const source = String(content)
  const occurrences = source.split(oldText).length - 1
  if (occurrences === 0) {
    throw createStructuredError('edit_file 的 oldText 没有匹配到当前文件内容。', {
      source: 'tool',
      category: 'text_context_mismatch',
      code: 'OLD_TEXT_NOT_FOUND',
      detail: 'oldText was not found in the target file.',
      suggestedAction:
        '请先用 read_file 的 mode=edit_context 重新读取目标区域；如果 exact oldText 不稳定，请改用 replace_line_range。',
      repairHint: {
        useTool: 'read_file',
        args: options.toolPath
          ? {
              path: options.toolPath,
              mode: 'edit_context',
            }
          : undefined,
        nextTool: 'replace_line_range',
      },
    })
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

function splitContentLines(content) {
  const source = String(content)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const endsWithEol = source.endsWith('\n')
  const lines = source.split(/\r?\n/)
  if (endsWithEol) {
    lines.pop()
  }
  return {
    eol,
    endsWithEol,
    lines,
  }
}

function normalizeReplacementLines(content) {
  const source = String(content || '')
  const lines = source.split(/\r?\n/)
  if (source.endsWith('\n')) {
    lines.pop()
  }
  return lines
}

function applyLineRangeReplacement(content, startLine, endLine, newText, options = {}) {
  const parsedStart = Number(startLine)
  const parsedEnd = Number(endLine)
  if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd)) {
    throw createStructuredError('replace_line_range 的 startLine 和 endLine 必须是有效数字。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'INVALID_LINE_RANGE',
      detail: `Received startLine=${startLine}, endLine=${endLine}.`,
      suggestedAction:
        '请先用 read_file 重新读取目标范围，再用读取结果里的 startLine/endLine 调用 replace_line_range。',
      repairHint: {
        useTool: 'read_file',
        nextTool: 'replace_line_range',
      },
    })
  }

  const { eol, endsWithEol, lines } = splitContentLines(content)
  const start = Math.floor(parsedStart)
  const end = Math.floor(parsedEnd)
  if (start < 1 || end < start || end > lines.length) {
    const reason =
      end < start
        ? 'endLine 小于 startLine，行号范围可能传反了。'
        : `行号范围超出目标文件的 ${lines.length} 行。`
    throw createStructuredError('replace_line_range 的行号范围无效。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'INVALID_LINE_RANGE',
      detail: `Line range ${start}-${end} is invalid for a file with ${lines.length} line(s). ${reason}`,
      suggestedAction:
        '请先用 read_file 重新读取目标范围，再用读取结果里的 startLine/endLine 调用 replace_line_range；确保 startLine <= endLine。',
      repairHint: {
        useTool: 'read_file',
        nextTool: 'replace_line_range',
      },
    })
  }

  if (looksLikeLineNumberedContent(newText)) {
    throw createStructuredError('replace_line_range 的 content 不能包含 read_file 行号前缀。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'LINE_NUMBER_PREFIX_IN_REPLACEMENT',
      detail:
        'Replacement content appears to include line-number prefixes such as "12:" or "L12:".',
      suggestedAction:
        '请使用不带行号前缀的原始文本作为 content；可以用 read_file 的 mode=raw 或 mode=edit_context 获取可回写文本。',
      repairHint: {
        useTool: 'read_file',
        nextTool: 'replace_line_range',
      },
    })
  }

  const selectedText = lines.slice(start - 1, end).join(eol)
  if (
    typeof options.expectedText === 'string' &&
    options.expectedText.length > 0 &&
    selectedText !== options.expectedText
  ) {
    throw createStructuredError('replace_line_range 的 expectedText 与当前行范围不一致。', {
      source: 'tool',
      category: 'text_context_mismatch',
      code: 'EXPECTED_TEXT_MISMATCH',
      detail: 'expectedText did not match the selected line range.',
      suggestedAction:
        '请用 read_file 的 mode=edit_context 重新读取同一行范围，然后用最新 text 作为 expectedText。',
      repairHint: {
        useTool: 'read_file',
        args: options.toolPath
          ? {
              path: options.toolPath,
              startLine: start,
              endLine: end,
              mode: 'edit_context',
            }
          : undefined,
        nextTool: 'replace_line_range',
      },
    })
  }

  const replacementLines = normalizeReplacementLines(newText)
  const nextLines = [
    ...lines.slice(0, start - 1),
    ...replacementLines,
    ...lines.slice(end),
  ]
  const nextContent = nextLines.join(eol) + (endsWithEol ? eol : '')

  return {
    startLine: start,
    endLine: end,
    replacedLineCount: end - start + 1,
    insertedLineCount: replacementLines.length,
    beforeLength: String(content).length,
    afterLength: nextContent.length,
    nextContent,
  }
}

function looksLikeLineNumberedContent(content) {
  const meaningfulLines = String(content || '')
    .split(/\r?\n/)
    .map(line => line.trimStart())
    .filter(Boolean)
  if (meaningfulLines.length < 2) {
    return false
  }
  return meaningfulLines.every(line => /^(?:L)?\d+:\s?/.test(line))
}

export async function applyWriteFileMutation(targetPath, content, runtime = {}) {
  runtime.throwIfAborted?.()
  emitMutationEvent(runtime, {
    stage: 'text_mutation_begin',
    operation: 'write_file',
    path: targetPath,
  })

  const existedBefore = await pathExists(targetPath)
  const beforeContent = existedBefore ? await fs.readFile(targetPath, 'utf8') : ''
  runtime.throwIfAborted?.()
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, content, 'utf8')

  const verification = await verifyWorkspaceTextMutation(targetPath, {
    existedBefore,
    expectedContent: content,
    beforeContent,
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

export async function applyReplaceLineRangeMutation(
  targetPath,
  startLine,
  endLine,
  newText,
  options = {},
  runtime = {},
) {
  runtime.throwIfAborted?.()
  emitMutationEvent(runtime, {
    stage: 'text_mutation_begin',
    operation: 'replace_line_range',
    path: targetPath,
    startLine,
    endLine,
  })

  const content = await fs.readFile(targetPath, 'utf8')
  const replacement = applyLineRangeReplacement(
    content,
    startLine,
    endLine,
    newText,
    {
      expectedText: options.expectedText,
      toolPath: options.toolPath,
    },
  )
  runtime.throwIfAborted?.()
  await fs.writeFile(targetPath, replacement.nextContent, 'utf8')

  const verification = await verifyWorkspaceTextMutation(targetPath, {
    existedBefore: true,
    expectedContent: replacement.nextContent,
    beforeContent: content,
  })

  const result = {
    operation: 'replace_line_range',
    path: targetPath,
    startLine: replacement.startLine,
    endLine: replacement.endLine,
    replacedLineCount: replacement.replacedLineCount,
    insertedLineCount: replacement.insertedLineCount,
    beforeLength: replacement.beforeLength,
    afterLength: replacement.afterLength,
    ...verification,
  }

  emitMutationEvent(runtime, {
    stage: 'text_mutation_end',
    operation: 'replace_line_range',
    path: targetPath,
    verified: result.verified === true,
    startLine: result.startLine,
    endLine: result.endLine,
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
    beforeContent: content,
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
    beforeContent: originalContent,
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
