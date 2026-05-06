import path from 'node:path'

export function truncate(text, maxLength = 12000) {
  if (typeof text !== 'string') {
    return truncate(JSON.stringify(text, null, 2), maxLength)
  }
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength)}\n...<truncated>`
}

export function normalizeBaseUrl(baseUrl, fallback) {
  return (baseUrl || fallback).replace(/\/+$/, '')
}

export function parseLooseJson(input, fallback = {}) {
  if (!input || !input.trim()) {
    return fallback
  }

  try {
    return JSON.parse(input)
  } catch {
    return fallback
  }
}

export function parseArgString(input) {
  if (!input.trim()) {
    return []
  }

  const matches = input.match(/"[^"]*"|'[^']*'|[^\s]+/g) || []
  return matches.map(part => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1)
    }
    return part
  })
}

export function parseCommandSpec(commandInput, argsInput = '') {
  const commandText = typeof commandInput === 'string' ? commandInput.trim() : ''
  const argsText = typeof argsInput === 'string' ? argsInput.trim() : ''

  if (!commandText) {
    return {
      command: '',
      args: parseArgString(argsText),
    }
  }

  const inlineParts = parseArgString(commandText)
  const fallbackCommand = inlineParts[0] || commandText
  const inlineArgs = inlineParts.slice(1)
  const extraArgs = parseArgString(argsText)

  return {
    command: fallbackCommand,
    args: [...inlineArgs, ...extraArgs],
  }
}

export function resolveWorkspacePath(cwd, target = '.') {
  const root = path.resolve(cwd)
  const resolved = path.resolve(root, target)
  const safeRoot = `${root}${path.sep}`
  const comparableRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparableResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const comparableSafeRoot = `${comparableRoot}${path.sep}`
  if (comparableResolved !== comparableRoot && !comparableResolved.startsWith(comparableSafeRoot)) {
    throw new Error(`Path escapes workspace root: ${target}`)
  }
  return resolved
}

export function formatToolError(error) {
  if (error instanceof Error) {
    return error.stack || error.message
  }
  return String(error)
}

export function stringifyOutput(value) {
  if (typeof value === 'string') {
    return truncate(value)
  }
  return truncate(JSON.stringify(value, null, 2))
}
