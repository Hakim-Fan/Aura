import fs from 'node:fs/promises'
import { createStructuredError } from '../runtimeErrors.mjs'
import { resolveWorkspacePath, truncate } from '../utils.mjs'
import { applyPatchInWorkspace } from './applyPatchTool.mjs'
import { verifyWorkspaceArtifact } from './artifactRuntime.mjs'
import {
  detectBinary,
  readTextBlock,
  readTextSlice,
  summarizeBinaryFile,
} from './readRuntime.mjs'
import {
  formatSearchResultText,
  searchWorkspaceCode,
} from './searchRuntime.mjs'
import {
  applyEditFileMutation,
  applyMultiEditFileMutation,
  applyReplaceLineRangeMutation,
  applyWriteFileMutation,
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

export function createEditingTools(context) {
  return [
    {
      ...readFileToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path)
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
        const target = resolveWorkspacePath(context.cwd, args.path)
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
        const target = resolveWorkspacePath(context.cwd, args.path)
        return applyWriteFileMutation(target, args.content, runtime)
      },
    },
    {
      ...editFileToolSpec,
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const target = resolveWorkspacePath(context.cwd, args.path)
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
        const target = resolveWorkspacePath(context.cwd, args.path)
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
        const target = resolveWorkspacePath(context.cwd, args.path)
        return applyMultiEditFileMutation(target, args.edits, runtime)
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
          : truncate(result)
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
