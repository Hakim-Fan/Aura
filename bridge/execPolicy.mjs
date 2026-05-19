import os from 'node:os'
import path from 'node:path'
import { evaluateFileToolAccessPolicy } from './permissions/fileAccessPolicy.mjs'
import { parseArgString } from './utils.mjs'

const SOURCE_WRITE_EXTENSIONS =
  'cjs|css|go|html|java|js|jsx|json|kt|mjs|md|py|rs|scss|svelte|swift|toml|ts|tsx|vue|ya?ml'

const SHELL_SCRIPT_FILE_WRITE_PATTERN =
  /\b(?:python3?|node|ruby|perl|php)\b[\s\S]*(?:\.write_text\s*\(|\.write_bytes\s*\(|\bopen\s*\([^)]*,\s*['"][wa]\b|\bwriteFile(?:Sync)?\s*\(|\bcreateWriteStream\s*\()/i

const SHELL_IN_PLACE_EDIT_PATTERN =
  /\b(?:sed|perl)\b[\s\S]*(?:\s-i(?:\s|$|['"])|--in-place\b)/i

const SHELL_REDIRECT_SOURCE_WRITE_PATTERN = new RegExp(
  `\\b(?:cat|tee|printf|echo)\\b[^\\n;&|]*(?:^|[^\\d])(?:>|>>)\\s*['"]?[^\\s'";|&]+\\.(?:${SOURCE_WRITE_EXTENSIONS})\\b`,
  'i',
)

const SHELL_CONTROL_PATTERN = /\s*(?:&&|\|\||;|\||\n)\s*/u

const CRITICAL_DANGEROUS_PATTERNS = [
  {
    code: 'SHELL_DELETE_ROOT',
    pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+){0,3}(?:--no-preserve-root\s+)?(?:\/|["']\/["'])(?:\s|$)/u,
    reason: 'Command attempts to recursively delete the filesystem root.',
  },
  {
    code: 'SHELL_DELETE_HOME',
    pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+){0,3}(?:~|\$HOME|["']~["']|["']\$HOME["'])(?:\s|\/|$)/u,
    reason: 'Command attempts to recursively delete the user home directory.',
  },
  {
    code: 'SHELL_FORMAT_DISK',
    pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|diskutil\s+erase|diskutil\s+partition|newfs(?:_[a-z0-9]+)?|format\s+[a-z]:)\b/iu,
    reason: 'Command appears to format or repartition a disk.',
  },
  {
    code: 'SHELL_RAW_DISK_WRITE',
    pattern: /\bdd\b[\s\S]*\bof=(?:\/dev\/|\\\\\.\\)/iu,
    reason: 'Command appears to write raw bytes to a device.',
  },
]

const HIGH_RISK_PATTERNS = [
  {
    code: 'SHELL_PRIVILEGE_ESCALATION',
    pattern: /(?:^|[\s;&|])(?:sudo|doas|su)(?:\s|$)/u,
    reason: 'Command requests elevated privileges.',
  },
  {
    code: 'SHELL_SYSTEM_AUTOMATION',
    pattern: /(?:^|[\s;&|])(?:osascript|powershell|pwsh|reg|sc|launchctl|systemctl)(?:\s|$)/iu,
    reason: 'Command can automate or mutate system-level state.',
  },
  {
    code: 'SHELL_NETWORK_INSTALLER',
    pattern: /\b(?:curl|wget)\b[\s\S]*(?:\|\s*(?:sh|bash|zsh)|\b(?:sh|bash|zsh)\s*<)/iu,
    reason: 'Command pipes downloaded code into a shell.',
  },
  {
    code: 'SHELL_PACKAGE_INSTALL',
    pattern: /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun|pip|pip3|cargo|gem|brew|apt|apt-get|dnf|yum|pacman)\s+(?:add|install|global|i|update|upgrade)\b/iu,
    reason: 'Command installs or updates packages.',
  },
  {
    code: 'SHELL_RECURSIVE_PERMISSION_CHANGE',
    pattern: /\b(?:chmod|chown)\b[\s\S]*(?:\s-R\b|--recursive\b)/iu,
    reason: 'Command recursively changes permissions or ownership.',
  },
]

const KNOWN_SAFE_COMMANDS = [
  /^(?:pwd|ls|find|rg|grep|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files)|pnpm\s+(?:test|typecheck|build|lint)|npm\s+run\s+(?:test|typecheck|build|lint)|yarn\s+(?:test|typecheck|build|lint)|bun\s+(?:test|typecheck|build|lint)|cargo\s+(?:check|test|build|fmt|clippy)|node\s+--check|tsc\b)/u,
]

const CAPABILITY_ADMIN_MANUAL_INSTALL_PATTERN =
  /(?:^|[\s;&|])(?:git\s+clone|curl|wget|npx|npm\s+(?:exec|install|i)|pnpm\s+(?:dlx|add|install)|yarn\s+(?:dlx|add|install)|bunx|cp|mv|mkdir|tar|unzip)(?:\s|$)/iu

function buildDecision(action, fields = {}) {
  const riskLevel = fields.riskLevel || (action === 'deny' ? 'critical' : action === 'prompt' ? 'high' : 'low')
  return {
    action,
    riskLevel,
    approvalCategory: fields.approvalCategory || 'shell',
    code: fields.code || `SHELL_POLICY_${action.toUpperCase()}`,
    summary: fields.summary || 'Shell execution policy decision.',
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

function normalizeCommand(tool, args) {
  if (tool?.name === 'run_shell') {
    return typeof args?.command === 'string' ? args.command.trim() : ''
  }
  if (tool?.name === 'exec_command') {
    return typeof args?.cmd === 'string' ? args.cmd.trim() : ''
  }
  if (tool?.name === 'write_stdin') {
    return typeof args?.chars === 'string' ? args.chars.trim() : ''
  }
  return ''
}

export function looksLikeShellFileMutation(command) {
  return (
    SHELL_SCRIPT_FILE_WRITE_PATTERN.test(command) ||
    SHELL_IN_PLACE_EDIT_PATTERN.test(command) ||
    SHELL_REDIRECT_SOURCE_WRITE_PATTERN.test(command)
  )
}

export function isKnownSafeCommand(command) {
  const normalized = String(command || '').trim()
  if (!normalized) {
    return false
  }
  if (SHELL_CONTROL_PATTERN.test(normalized)) {
    return false
  }
  return KNOWN_SAFE_COMMANDS.some(pattern => pattern.test(normalized))
}

function matchPattern(command, patterns) {
  return patterns.find(entry => entry.pattern.test(command)) || null
}

export function commandMightBeDangerous(command) {
  const normalized = String(command || '').trim()
  if (!normalized) {
    return null
  }
  const critical = matchPattern(normalized, CRITICAL_DANGEROUS_PATTERNS)
  if (critical) {
    return {
      ...critical,
      action: 'deny',
      riskLevel: 'critical',
    }
  }
  const highRisk = matchPattern(normalized, HIGH_RISK_PATTERNS)
  if (highRisk) {
    return {
      ...highRisk,
      action: 'prompt',
      riskLevel: 'high',
    }
  }
  return null
}

function looksLikeManualCapabilityInstallCommand(command) {
  return CAPABILITY_ADMIN_MANUAL_INSTALL_PATTERN.test(String(command || '').trim())
}

function stripShellDecorators(token) {
  return String(token || '')
    .replace(/^[<>]+/u, '')
    .replace(/^[A-Z_][A-Z0-9_]*=/iu, '')
    .replace(/[),;]+$/u, '')
    .trim()
}

function expandPathToken(token, cwd, homeDir) {
  let value = stripShellDecorators(token)
  if (!value || value.startsWith('-')) {
    return null
  }
  if (value.startsWith('file://')) {
    value = value.slice('file://'.length)
  }
  if (value === '~' || value.startsWith('~/')) {
    return path.resolve(homeDir, value.slice(2))
  }
  if (value === '$HOME' || value.startsWith('$HOME/')) {
    return path.resolve(homeDir, value.slice('$HOME/'.length))
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value)
  }
  if (value.startsWith('../') || value === '..') {
    return path.resolve(cwd, value)
  }
  return null
}

function pathIsInside(candidate, root) {
  const normalizedCandidate = path.resolve(candidate)
  const normalizedRoot = path.resolve(root)
  const comparableCandidate = process.platform === 'win32'
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate
  const comparableRoot = process.platform === 'win32'
    ? normalizedRoot.toLowerCase()
    : normalizedRoot
  return (
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(`${comparableRoot}${path.sep}`)
  )
}

function inferPathAccess(command, token) {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const before = new RegExp(`(?:>|>>|<)\\s*["']?${escapedToken}`, 'u')
  if (before.test(command)) {
    return command.includes(`>>${token}`) || command.includes(`> ${token}`) || command.includes(`>${token}`)
      ? 'write'
      : 'read'
  }
  if (/\b(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|install)\b/u.test(command)) {
    return 'write'
  }
  return 'read'
}

export function collectExternalPathReferences(command, cwd) {
  const homeDir = os.homedir()
  const auraHome = path.join(homeDir, '.aura')
  const workspaceRoot = path.resolve(cwd)
  const references = []
  const seen = new Set()
  const words = parseArgString(command)

  for (const word of words) {
    const resolved = expandPathToken(word, workspaceRoot, homeDir)
    if (!resolved || pathIsInside(resolved, workspaceRoot)) {
      continue
    }
    const key = `${resolved}:${word}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    references.push({
      token: stripShellDecorators(word),
      resolvedPath: resolved,
      scope: pathIsInside(resolved, auraHome) ? 'aura_home' : 'external',
      access: inferPathAccess(command, stripShellDecorators(word)),
    })
  }

  return references
}

function isAuraCapabilityPathReference(entry) {
  if (!entry || entry.scope !== 'aura_home') {
    return false
  }
  return /(?:^|[/\\])\.aura[/\\](?:skills|plugins|mcp)(?:[/\\]|$)/u.test(
    entry.resolvedPath,
  )
}

function buildPolicyPreview(decision, command) {
  return JSON.stringify(
    {
      phase: 'exec_policy_review',
      guardian: decision.guardian,
      riskLevel: decision.riskLevel,
      code: decision.code,
      reason: decision.reason,
      suggestedAction: decision.suggestedAction,
      command,
      details: decision.details,
    },
    null,
    2,
  )
}

export function formatExecutionPolicyPreview(decision, command) {
  return buildPolicyPreview(decision, command)
}

export function evaluateToolExecutionPolicy({
  tool,
  args,
  settings = {},
  routeState = {},
} = {}) {
  const fileAccessDecision = evaluateFileToolAccessPolicy({ tool, args, settings })
  if (fileAccessDecision) {
    return fileAccessDecision
  }

  const command = normalizeCommand(tool, args)
  if (!command) {
    return buildDecision('allow', {
      summary: 'No shell command found for policy evaluation.',
    })
  }

  if (tool?.approvalCategory !== 'shell' && tool?.name !== 'write_stdin') {
    return buildDecision('allow', {
      summary: 'Tool does not require shell execution policy.',
    })
  }

  if (
    routeState?.isCapabilityAdminTask === true &&
    looksLikeManualCapabilityInstallCommand(command) &&
    !isKnownSafeCommand(command)
  ) {
    return buildDecision('deny', {
      code: 'SHELL_CAPABILITY_ADMIN_MANUAL_INSTALL_BLOCKED',
      riskLevel: 'high',
      summary: '已阻止在能力管理任务中使用 shell 手工安装。',
      reason:
        'This turn is classified as Aura capability management, and the command looks like manual download/copy/clone/package-install work. Capability installation should use audited Aura tools so the runtime can stage, validate, copy, enable, and report the result consistently.',
      suggestedAction:
        '请直接调用 aura_install_skill 处理 URL/GitHub/npm/npx/粘贴内容来源；已有本地 skill 文件或目录时调用 aura_import_skill。',
      details: {
        command,
      },
    })
  }

  const dangerous = commandMightBeDangerous(command)
  if (dangerous?.action === 'deny') {
    return buildDecision('deny', {
      code: dangerous.code,
      riskLevel: dangerous.riskLevel,
      summary: '已阻止危险 shell 命令。',
      reason: dangerous.reason,
      suggestedAction:
        '请改用范围更小、可审计的命令；如果你确实要执行高风险系统操作，需要在 Aura 外部手动完成。',
      details: {
        command,
      },
    })
  }

  if (dangerous?.action === 'prompt') {
    return buildDecision('prompt', {
      code: dangerous.code,
      riskLevel: dangerous.riskLevel,
      summary: '高风险 shell 命令需要用户审批。',
      reason: dangerous.reason,
      suggestedAction:
        '请确认命令来源、目标路径和影响范围；优先使用 Aura 专用工具或更小范围的命令。',
      details: {
        command,
      },
    })
  }

  const cwd = typeof settings.cwd === 'string' && settings.cwd.trim()
    ? settings.cwd.trim()
    : ''
  if (cwd) {
    const externalPaths = collectExternalPathReferences(command, cwd)
    if (externalPaths.length > 0) {
      const writesAuraHome = externalPaths.some(
        entry => entry.scope === 'aura_home' && entry.access === 'write',
      )
      const writesAuraCapability = externalPaths.some(
        entry => entry.access === 'write' && isAuraCapabilityPathReference(entry),
      )
      if (writesAuraCapability) {
        return buildDecision('deny', {
          code: 'SHELL_AURA_CAPABILITY_MUTATION_BLOCKED',
          riskLevel: 'high',
          summary: '已阻止使用 shell 修改 Aura 能力目录。',
          reason:
            'The command writes under ~/.aura skills/plugins/MCP directories. Aura-managed capabilities must be installed through audited Aura tools instead of shell copying or installer scripts.',
          suggestedAction:
            '请调用 aura_install_skill、aura_import_skill、aura_enable_skill、aura_import_plugin 或对应的 Aura 专用工具完成安装/启用。',
          details: {
            command,
            workspaceRoot: path.resolve(cwd),
            externalPaths,
          },
        })
      }
      return buildDecision('prompt', {
        code: writesAuraHome
          ? 'SHELL_AURA_HOME_MUTATION'
          : 'SHELL_EXTERNAL_PATH_ACCESS',
        riskLevel: writesAuraHome ? 'high' : 'medium',
        summary: writesAuraHome
          ? '写入 Aura 应用目录需要用户审批。'
          : '访问工作区外路径需要用户审批。',
        reason: writesAuraHome
          ? 'The command writes under ~/.aura, which changes Aura-managed application state.'
          : 'The command references paths outside the current workspace sandbox.',
        suggestedAction: writesAuraHome
          ? '安装或导入 skill/plugin 时优先使用 aura_install_skill、aura_import_skill、aura_enable_skill 等专用工具。'
          : '如果只是分析文件，请先把外部文件导入当前工作区，或让用户明确批准本次外部路径访问。',
        details: {
          command,
          workspaceRoot: path.resolve(cwd),
          externalPaths,
        },
      })
    }
  }

  if (looksLikeShellFileMutation(command)) {
    return buildDecision('deny', {
      code: 'SHELL_FILE_MUTATION_BLOCKED',
      riskLevel: 'high',
      summary: '已阻止使用 shell 直接修改源码文件。',
      reason:
        'The command appears to create or modify source files through shell redirection, in-place editing, or script file writes.',
      suggestedAction:
        '请使用 apply_patch、replace_line_range、edit_file 或 write_file；执行验证命令可以继续使用 shell。',
      details: {
        command,
      },
    })
  }

  return buildDecision('allow', {
    riskLevel: isKnownSafeCommand(command) ? 'low' : 'medium',
    summary: 'Shell command is allowed by execution policy.',
    reason: isKnownSafeCommand(command)
      ? 'Command matches the known-safe command set.'
      : 'No dangerous pattern or workspace escape was detected.',
    details: {
      command,
    },
  })
}
