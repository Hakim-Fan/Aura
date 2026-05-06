import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildShellArgs, resolveCommandShell } from './shellRuntime.mjs'

test('resolveCommandShell prefers PowerShell on Windows hosts', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-shell-runtime-'))
  const pwshPath = path.join(tempDir, 'pwsh.exe')
  await fs.writeFile(pwshPath, '', { mode: 0o755 })
  await fs.chmod(pwshPath, 0o755)

  const shell = resolveCommandShell({
    platform: 'win32',
    env: { PATH: tempDir },
  })

  assert.equal(shell.file, pwshPath)
  assert.equal(shell.kind, 'powershell')
  assert.deepEqual(shell.args('node -v'), [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    'node -v',
  ])
})

test('buildShellArgs uses cmd flags for explicit cmd.exe shells', () => {
  assert.deepEqual(
    buildShellArgs({ file: 'cmd.exe', kind: 'cmd' }, 'echo hello'),
    ['/d', '/s', '/c', 'echo hello'],
  )
})

test('buildShellArgs keeps POSIX login shell behavior', () => {
  assert.deepEqual(buildShellArgs('/bin/sh', 'echo hello', false), ['-c', 'echo hello'])
  assert.deepEqual(buildShellArgs('/bin/zsh', 'echo hello', true), ['-lc', 'echo hello'])
})
