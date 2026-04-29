import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const COMMON_PATH_DIRS = [
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

function findExecutable(name, searchPath) {
  for (const entry of pathEntries(searchPath)) {
    const candidate = path.join(entry, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Keep searching.
    }
  }
  return ''
}

function ensureShellShimDir(baseEnv, initialPath) {
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
  const home = baseEnv.HOME || os.homedir()
  const entries = []

  for (const candidate of [
    path.join(home, '.aura', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    ...COMMON_PATH_DIRS,
    path.dirname(process.execPath),
    ...pathEntries(baseEnv.PATH),
  ]) {
    pushExistingPath(entries, candidate)
  }

  const initialPath = entries.join(path.delimiter)
  const shimDir = ensureShellShimDir(baseEnv, initialPath)
  if (shimDir) {
    pushExistingPath(entries, shimDir)
  }

  return {
    ...baseEnv,
    PATH: entries.join(path.delimiter),
  }
}
