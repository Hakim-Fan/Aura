import os from 'node:os'
import path from 'node:path'
import { parsePatch } from '../editing/applyPatchParser.mjs'

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'replace_line_range',
  'multi_edit_file',
])

const READ_TOOLS = new Set(['read_file', 'read_block'])

function pathIsInside(candidate, root) {
  const normalizedCandidate = path.resolve(candidate)
  const normalizedRoot = path.resolve(root)
  const comparableCandidate =
    process.platform === 'win32' ? normalizedCandidate.toLowerCase() : normalizedCandidate
  const comparableRoot =
    process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  return (
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(`${comparableRoot}${path.sep}`)
  )
}

function expandUserPath(target = '.') {
  const value = String(target || '.')
  if (value === '~' || value.startsWith('~/')) {
    return path.resolve(os.homedir(), value.slice(2))
  }
  if (value === '$HOME' || value.startsWith('$HOME/')) {
    return path.resolve(os.homedir(), value.slice('$HOME/'.length))
  }
  if (value === '${HOME}' || value.startsWith('${HOME}/')) {
    return path.resolve(os.homedir(), value.slice('${HOME}/'.length))
  }
  return value
}

export function resolveFileAccessPath(cwd, target = '.') {
  const root = path.resolve(cwd)
  const expandedTarget = expandUserPath(target)
  const resolved = path.isAbsolute(expandedTarget)
    ? path.resolve(expandedTarget)
    : path.resolve(root, expandedTarget)
  return {
    root,
    resolved,
    external: !pathIsInside(resolved, root),
  }
}

function normalizeApplyPatchInput(args = {}) {
  if (typeof args === 'string' && args.trim()) {
    return args
  }
  for (const key of ['patch', 'input', 'command', 'content']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) {
      return args[key]
    }
  }
  return ''
}

function collectApplyPatchTargets(args = {}) {
  const patchText = normalizeApplyPatchInput(args)
  if (!patchText) {
    return []
  }
  try {
    const parsed = parsePatch(patchText)
    return (Array.isArray(parsed?.operations) ? parsed.operations : []).flatMap(operation =>
      operation?.kind === 'update' && operation.moveTo
        ? [operation.path, operation.moveTo]
        : [operation?.path],
    ).filter(Boolean)
  } catch {
    return []
  }
}

export function fileAccessOperationForTool(toolName, args = {}) {
  if (READ_TOOLS.has(toolName)) {
    return {
      access: 'read',
      paths: typeof args.path === 'string' ? [args.path] : [],
    }
  }
  if (WRITE_TOOLS.has(toolName)) {
    return {
      access: 'write',
      paths: typeof args.path === 'string' ? [args.path] : [],
    }
  }
  if (toolName === 'apply_patch') {
    return {
      access: 'write',
      paths: collectApplyPatchTargets(args),
    }
  }
  return null
}

function buildDecision(action, fields = {}) {
  const riskLevel = fields.riskLevel || (action === 'deny' ? 'high' : 'medium')
  return {
    action,
    riskLevel,
    approvalCategory: fields.approvalCategory,
    code: fields.code || `FILE_ACCESS_${action.toUpperCase()}`,
    summary: fields.summary || 'File access policy decision.',
    reason: fields.reason || '',
    suggestedAction: fields.suggestedAction || '',
    details: fields.details || {},
    guardian: {
      decision: action === 'deny' ? 'deny' : action === 'prompt' ? 'prompt' : 'allow',
      risk_level: riskLevel,
      user_authorization: action === 'prompt' ? 'required' : 'not_required',
      rationale: fields.reason || fields.summary || '',
    },
  }
}

export function isAuraCapabilityPath(resolvedPath) {
  const auraHome = path.join(os.homedir(), '.aura')
  return (
    pathIsInside(resolvedPath, path.join(auraHome, 'skills')) ||
    pathIsInside(resolvedPath, path.join(auraHome, 'plugins')) ||
    pathIsInside(resolvedPath, path.join(auraHome, 'mcp'))
  )
}

export function evaluateFileToolAccessPolicy({ tool, args, settings = {} } = {}) {
  const cwd = typeof settings.cwd === 'string' && settings.cwd.trim()
    ? settings.cwd.trim()
    : ''
  const operation = fileAccessOperationForTool(tool?.name, args)
  if (!cwd || !operation || operation.paths.length === 0) {
    return null
  }

  const resolvedPaths = operation.paths.map(target => ({
    target,
    ...resolveFileAccessPath(cwd, target),
  }))
  const externalPaths = resolvedPaths.filter(entry => entry.external)
  if (externalPaths.length === 0) {
    return null
  }

  const writesAuraCapability =
    operation.access === 'write' &&
    externalPaths.some(entry => isAuraCapabilityPath(entry.resolved))
  if (writesAuraCapability) {
    return buildDecision('deny', {
      approvalCategory: 'external_file_write',
      code: 'FILE_AURA_CAPABILITY_MUTATION_BLOCKED',
      riskLevel: 'high',
      summary: '已阻止修改 Aura 能力目录。',
      reason:
        'The requested file write targets ~/.aura skills/plugins/MCP directories, which must be managed through audited Aura capability tools.',
      suggestedAction:
        '请使用 aura_install_skill、aura_import_skill、aura_enable_skill 或对应专用工具。',
      details: {
        workspaceRoot: path.resolve(cwd),
        access: operation.access,
        externalPaths,
      },
    })
  }

  const approvalCategory =
    operation.access === 'write' ? 'external_file_write' : 'external_file_read'
  return buildDecision('prompt', {
    approvalCategory,
    code:
      operation.access === 'write'
        ? 'FILE_EXTERNAL_WRITE_ACCESS'
        : 'FILE_EXTERNAL_READ_ACCESS',
    riskLevel: operation.access === 'write' ? 'medium' : 'low',
    summary:
      operation.access === 'write'
        ? '写入工作区外文件需要用户审批。'
        : '读取工作区外文件需要用户审批。',
    reason:
      operation.access === 'write'
        ? 'The tool writes a path outside the current workspace sandbox.'
        : 'The tool reads a path outside the current workspace sandbox.',
    suggestedAction:
      operation.access === 'write'
        ? '请确认目标路径和影响范围；批准后仅执行本次工具写入。'
        : '请确认该外部文件可被读取，或先把文件导入工作区。',
    details: {
      workspaceRoot: path.resolve(cwd),
      access: operation.access,
      externalPaths,
    },
  })
}
