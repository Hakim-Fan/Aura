import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findExecutable } from './shellRuntime.mjs'

const POSIX_COMMON_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/Library/Apple/usr/bin',
  '/System/Cryptexes/App/usr/bin',
  '/Applications/Codex.app/Contents/Resources',
]

function resolvePathEnvKey(baseEnv) {
  return Object.keys(baseEnv).find(key => key.toLowerCase() === 'path') || 'PATH'
}

function pathEntries(value = '') {
  return String(value)
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
}

function pushExistingPath(entries, nextPath) {
  if (!nextPath || entries.includes(nextPath) || !fs.existsSync(nextPath)) {
    return
  }
  entries.push(nextPath)
}

function windowsProgramPath(...parts) {
  const base = parts.shift()
  return base ? path.join(base, ...parts) : ''
}

function commonPathDirs(baseEnv = process.env) {
  if (process.platform !== 'win32') {
    return POSIX_COMMON_PATH_DIRS
  }

  const home = baseEnv.USERPROFILE || baseEnv.HOME || os.homedir()
  const systemRoot = baseEnv.SystemRoot || baseEnv.WINDIR || 'C:\\Windows'
  return [
    windowsProgramPath(baseEnv.LOCALAPPDATA, 'Microsoft', 'WindowsApps'),
    windowsProgramPath(home, 'AppData', 'Roaming', 'npm'),
    windowsProgramPath(home, 'scoop', 'shims'),
    windowsProgramPath(baseEnv.ProgramFiles, 'nodejs'),
    windowsProgramPath(baseEnv['ProgramFiles(x86)'], 'nodejs'),
    windowsProgramPath(baseEnv.LOCALAPPDATA, 'Programs', 'nodejs'),
    windowsProgramPath(baseEnv.ProgramFiles, 'PowerShell', '7'),
    windowsProgramPath(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    windowsProgramPath(baseEnv.ProgramFiles, 'Git', 'cmd'),
    windowsProgramPath(baseEnv.ProgramFiles, 'Git', 'bin'),
    windowsProgramPath(baseEnv['ProgramFiles(x86)'], 'Git', 'cmd'),
    windowsProgramPath(baseEnv['ProgramFiles(x86)'], 'Git', 'bin'),
    windowsProgramPath(baseEnv.ChocolateyInstall, 'bin'),
    'C:\\ProgramData\\chocolatey\\bin',
    windowsProgramPath(systemRoot, 'System32'),
    systemRoot,
  ]
}

function ensureShellShimDir(baseEnv, initialPath) {
  if (process.platform === 'win32') {
    return ''
  }

  const auraBin = path.join(os.homedir(), '.aura', 'bin')
  try {
    fs.mkdirSync(auraBin, { recursive: true })
  } catch {
    return ''
  }

  if (!findExecutable('python', initialPath) && findExecutable('python3', initialPath)) {
    const pythonShim = path.join(auraBin, 'python')
    try {
      fs.writeFileSync(pythonShim, '#!/bin/sh\nexec python3 "$@"\n', { mode: 0o755 })
      fs.chmodSync(pythonShim, 0o755)
    } catch {
      // The command will still fail with the normal shell error if the shim cannot be written.
    }
  }

  return auraBin
}

export function buildShellEnv(baseEnv = process.env) {
  const home = baseEnv.HOME || baseEnv.USERPROFILE || os.homedir()
  const pathKey = resolvePathEnvKey(baseEnv)
  const entries = []

  for (const candidate of [
    path.join(home, '.aura', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    ...commonPathDirs(baseEnv),
    path.dirname(process.execPath),
    ...pathEntries(baseEnv[pathKey]),
  ]) {
    pushExistingPath(entries, candidate)
  }

  const initialPath = entries.join(path.delimiter)
  const shimDir = ensureShellShimDir(baseEnv, initialPath)
  if (shimDir) {
    pushExistingPath(entries, shimDir)
  }

  const env = { ...baseEnv }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && key !== pathKey) {
      delete env[key]
    }
  }

  env[pathKey] = entries.join(path.delimiter)
  if (process.platform !== 'win32') {
    env.PATH = env[pathKey]
  }
  return env
}
