function normalizeShellScript(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim()
}

function unquoteShellWord(value) {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }

  return text
}

const SHELL_WORD_PATTERN = `(?:\"[^\"]+\"|'[^']+'|[^&\\n]+?)`
const HEREDOC_APPLY_PATCH_PATTERN = new RegExp(
  `^(?:cd\\s+(?<workdir>${SHELL_WORD_PATTERN})\\s*&&\\s*)?apply_patch\\s*<<(?<quote>['"]?)(?<marker>[A-Za-z_][A-Za-z0-9_]*)\\k<quote>\\s*\\n(?<body>[\\s\\S]*?)\\n\\k<marker>\\s*$`,
  'u',
)

function parseHeredocApplyPatch(script) {
  const match = HEREDOC_APPLY_PATCH_PATTERN.exec(script)
  if (!match?.groups) {
    return null
  }

  const patch = String(match.groups.body || '').trim()
  if (!patch.startsWith('*** Begin Patch') || !patch.endsWith('*** End Patch')) {
    return {
      kind: 'invalid',
      reason:
        'apply_patch heredoc was detected, but the body did not contain a complete structured patch.',
    }
  }

  return {
    kind: 'valid',
    invocation: 'heredoc',
    patch,
    workdir: unquoteShellWord(match.groups.workdir || ''),
  }
}

function parseDirectApplyPatch(script) {
  const directMatch = /^(?:cd\s+(?<workdir>(?:"[^"]+"|'[^']+'|[^&\n]+?))\s*&&\s*)?apply_patch\b(?<rest>[\s\S]*)$/u.exec(
    script,
  )
  if (!directMatch?.groups) {
    return null
  }

  const rest = String(directMatch.groups.rest || '')
  const beginIndex = rest.indexOf('*** Begin Patch')
  const endIndex = rest.lastIndexOf('*** End Patch')
  if (beginIndex < 0 || endIndex < beginIndex) {
    return {
      kind: 'invalid',
      reason:
        'apply_patch was referenced, but no complete "*** Begin Patch" ... "*** End Patch" body was found.',
    }
  }

  const prefix = rest.slice(0, beginIndex).trim()
  const suffix = rest.slice(endIndex + '*** End Patch'.length).trim()
  const patch = rest
    .slice(beginIndex, endIndex + '*** End Patch'.length)
    .trim()

  const prefixAllowed = prefix === '' || prefix === '"' || prefix === "'"
  const suffixAllowed = suffix === '' || suffix === '"' || suffix === "'"
  if (!prefixAllowed || !suffixAllowed) {
    return {
      kind: 'invalid',
      reason:
        'apply_patch direct invocation must not include extra shell operators or trailing commands around the structured patch body.',
    }
  }

  return {
    kind: 'valid',
    invocation: 'direct',
    patch,
    workdir: unquoteShellWord(directMatch.groups.workdir || ''),
  }
}

export function parseApplyPatchShellCommand(command) {
  const script = normalizeShellScript(command)
  if (!script || !/\bapply_patch\b/u.test(script)) {
    return null
  }

  const heredocResult = parseHeredocApplyPatch(script)
  if (heredocResult) {
    return heredocResult
  }

  if (/<<['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/u.test(script)) {
    return {
      kind: 'invalid',
      reason:
        'apply_patch heredoc invocation was detected, but it did not match a supported whole-command form.',
    }
  }

  const directResult = parseDirectApplyPatch(script)
  if (directResult) {
    return directResult
  }

  return {
    kind: 'invalid',
    reason:
      'apply_patch was referenced, but the shell command did not match a supported direct or heredoc invocation.',
  }
}
