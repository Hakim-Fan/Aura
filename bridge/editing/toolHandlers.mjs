import fs from 'node:fs/promises'
import { createStructuredError } from '../runtimeErrors.mjs'
import { resolveFileAccessPath } from '../permissions/fileAccessPolicy.mjs'
import { resolveWorkspacePath, truncate } from '../utils.mjs'
import { parsePatch } from './applyPatchParser.mjs'
import { applyPatchInWorkspace } from './applyPatchTool.mjs'
import { verifyPatchAgainstWorkspace } from './applyPatchVerifier.mjs'
import { verifyWorkspaceArtifact } from './artifactRuntime.mjs'
import { buildEditingTransactionPreview } from './editingTransaction.mjs'
import {
  detectBinary,
  readTextBlock,
  readTextSlice,
  summarizeBinaryFile,
} from './readRuntime.mjs'
import {
  formatSearchResultText,
  formatStructuredSearchResultJson,
  searchWorkspaceCode,
} from './searchRuntime.mjs'
import {
  applyEditFileMutation,
  applyMultiEditFileMutation,
  applyReplaceLineRangeMutation,
  applyWriteFileMutation,
  prepareEditFileTransaction,
  prepareMultiEditFileTransaction,
  prepareReplaceLineRangeTransaction,
  prepareWriteFileTransaction,
} from './textMutationRuntime.mjs'
import {
  applyPatchToolSpec,
  editFileToolSpec,
  multiEditFileToolSpec,
  readBlockToolSpec,
  readFileToolSpec,
  replaceLineRangeToolSpec,
  searchCodeToolSpec,
  verifyArtifactToolSpec,
  writeFileToolSpec,
} from './toolSpecs.mjs'

export function normalizeApplyPatchToolInput(args = {}) {
  if (typeof args === 'string' && args.trim()) {
    return args
  }

  for (const key of ['patch', 'input', 'command', 'content']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) {
      return args[key]
    }
  }

  throw createStructuredError('apply_patch 需要一段结构化 patch 文本。', {
    source: 'tool',
    category: 'invalid_input',
    code: 'MISSING_PATCH_TEXT',
    detail:
      'Expected a patch string in args.patch. Also accepts args.input, args.command, or args.content for compatibility.',
    suggestedAction:
      '请传入以 "*** Begin Patch" 开头、以 "*** End Patch" 结尾的 patch 字符串。',
  })
}

function resolveEditablePath(rootPath, targetPath) {
  return resolveFileAccessPath(rootPath, targetPath).resolved
}

export async function buildEditingToolTransaction(rootPath, toolName, args = {}, runtime = {}) {
  if (toolName === 'apply_patch') {
    const patchText = normalizeApplyPatchToolInput(args)
    const parsedPatch = parsePatch(patchText)
    const verifiedPatch = await verifyPatchAgainstWorkspace(rootPath, parsedPatch, runtime)
    return {
      operation: 'apply_patch',
      changes: verifiedPatch.changes,
      counts: verifiedPatch.counts,
      affectedPaths: verifiedPatch.affectedPaths,
      preview: verifiedPatch.preview,
      summary: verifiedPatch.summary,
    }
  }

  if (toolName === 'write_file') {
    return prepareWriteFileTransaction(
      resolveEditablePath(rootPath, args.path),
      args.content,
      {
        toolPath: args.path,
      },
    )
  }

  if (toolName === 'edit_file') {
    return prepareEditFileTransaction(
      resolveEditablePath(rootPath, args.path),
      args.oldText,
      args.newText,
      {
        replaceAll: args.replaceAll,
        expectedReplacements: args.expectedReplacements,
        toolPath: args.path,
      },
    )
  }

  if (toolName === 'replace_line_range') {
    return prepareReplaceLineRangeTransaction(
      resolveEditablePath(rootPath, args.path),
      args.startLine,
      args.endLine,
      args.content,
      {
        expectedText: args.expectedText,
        toolPath: args.path,
      },
    )
  }

  if (toolName === 'multi_edit_file') {
    return prepareMultiEditFileTransaction(
      resolveEditablePath(rootPath, args.path),
      args.edits,
      {
        toolPath: args.path,
      },
      runtime,
    )
  }

  return null
}

export async function buildEditingToolApprovalPreview(rootPath, toolName, args = {}, runtime = {}) {
  const transaction = await buildEditingToolTransaction(rootPath, toolName, args, runtime)
  if (!transaction) {
    return undefined
  }
  return buildEditingTransactionPreview(transaction, {
    phase: 'approval_preview',
  })
}

export function createEditingTools(context) {
  return [
    {
      ...readFileToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveEditablePath(context.cwd, args.path)
        const content = await fs.readFile(target)
        if (detectBinary(content)) {
          return summarizeBinaryFile(target, content)
        }
        return truncate(readTextSlice(content.toString('utf8'), args))
      },
    },
    {
      ...readBlockToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveEditablePath(context.cwd, args.path)
        const content = await fs.readFile(target)
        if (detectBinary(content)) {
          return summarizeBinaryFile(target, content)
        }
        return truncate(readTextBlock(content.toString('utf8'), args))
      },
    },
    {
      ...applyPatchToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        return applyPatchInWorkspace(
          context.cwd,
          normalizeApplyPatchToolInput(args),
          runtime,
        )
      },
    },
    {
      ...writeFileToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveEditablePath(context.cwd, args.path)
        return applyWriteFileMutation(target, args.content, {
          toolPath: args.path,
        }, runtime)
      },
    },
    {
      ...editFileToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveEditablePath(context.cwd, args.path)
        return applyEditFileMutation(
          target,
          args.oldText,
          args.newText,
          {
            replaceAll: args.replaceAll,
            expectedReplacements: args.expectedReplacements,
            toolPath: args.path,
          },
          runtime,
        )
      },
    },
    {
      ...replaceLineRangeToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveEditablePath(context.cwd, args.path)
        return applyReplaceLineRangeMutation(
          target,
          args.startLine,
          args.endLine,
          args.content,
          {
            expectedText: args.expectedText,
            toolPath: args.path,
          },
          runtime,
        )
      },
    },
    {
      ...multiEditFileToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveEditablePath(context.cwd, args.path)
        return applyMultiEditFileMutation(target, args.edits, {
          toolPath: args.path,
        }, runtime)
      },
    },
    {
      ...searchCodeToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path || '.')
        const result = await searchWorkspaceCode(args.query, target, context.cwd, {
          signal: runtime.signal,
          contextLines: args.contextLines,
          maxMatches: args.maxMatches,
        })
        return args.format === 'text'
          ? truncate(formatSearchResultText(result))
          : formatStructuredSearchResultJson(result)
      },
    },
    {
      ...verifyArtifactToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path)
        return verifyWorkspaceArtifact(target, {
          displayPath: args.path,
          expectedKind: args.expectedKind,
        })
      },
    },
  ]
}
