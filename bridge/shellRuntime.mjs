import fs from 'node:fs'
import path from 'node:path'

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']

function pathEntries(value = '') {
  return String(value)
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
}

function executableNames(name, platform = process.platform) {
  if (platform !== 'win32' || path.extname(name)) {
    return [name]
  }

  return [name, ...WINDOWS_EXECUTABLE_EXTENSIONS.map(extension => `${name}${extension}`)]
}

export function findExecutable(name, searchPath = process.env.PATH || process.env.Path || '', platform = process.platform) {
  for (const entry of pathEntries(searchPath)) {
    for (const executableName of executableNames(name, platform)) {
      const candidate = path.join(entry, executableName)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // Keep searching.
      }
    }
  }
  return ''
}

function resolveUnixShell(env, platform) {
  const searchPath = env.PATH || env.Path || ''
  const candidates = [
    env.SHELL,
    platform === 'darwin' ? '/bin/zsh' : '',
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
    '/usr/bin/sh',
  ]

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    if (path.isAbsolute(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
    const resolved = findExecutable(candidate, searchPath, platform)
    if (resolved) {
      return resolved
    }
  }

  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

function resolveWindowsShell(env) {
  const searchPath = env.PATH || env.Path || ''
  return (
    findExecutable('pwsh', searchPath, 'win32') ||
    findExecutable('powershell', searchPath, 'win32') ||
    findExecutable('powershell.exe', searchPath, 'win32') ||
    findExecutable('cmd', searchPath, 'win32') ||
    findExecutable('cmd.exe', searchPath, 'win32') ||
    'cmd.exe'
  )
}

function inferShellKind(file, platform = process.platform) {
  const baseName = path.basename(String(file || '')).toLowerCase()
  if (platform === 'win32') {
    if (baseName === 'pwsh' || baseName === 'pwsh.exe') {
      return 'powershell'
    }
    if (baseName === 'powershell' || baseName === 'powershell.exe') {
      return 'powershell'
    }
    if (baseName === 'cmd' || baseName === 'cmd.exe') {
      return 'cmd'
    }
  }
  return 'posix'
}

export function buildShellArgs(shell, command, login = true) {
  const shellKind = typeof shell === 'string' ? inferShellKind(shell) : shell?.kind || 'posix'
  switch (shellKind) {
    case 'powershell':
      return [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command,
      ]
    case 'cmd':
      return ['/d', '/s', '/c', command]
    default:
      return [login === false ? '-c' : '-lc', command]
  }
}

export function resolveCommandShell({ env = process.env, platform = process.platform, shell } = {}) {
  const file = shell || (platform === 'win32' ? resolveWindowsShell(env) : resolveUnixShell(env, platform))
  const kind = inferShellKind(file, platform)
  return {
    file,
    kind,
    args(command, login = true) {
      return buildShellArgs({ file, kind }, command, login)
    },
  }
}
