import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  commandMightBeDangerous,
  evaluateToolExecutionPolicy,
  isKnownSafeCommand,
  looksLikeShellFileMutation,
} from './execPolicy.mjs'

test('execution policy prompts for shell access outside workspace', () => {
  const workspace = path.join(os.tmpdir(), 'aura-policy-workspace')
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'exec_command',
      approvalCategory: 'shell',
    },
    args: {
      cmd: 'cat /tmp/anthropics-skills/skills/docx/SKILL.md',
    },
    settings: {
      cwd: workspace,
    },
  })

  assert.equal(result.action, 'prompt')
  assert.equal(result.code, 'SHELL_EXTERNAL_PATH_ACCESS')
  assert.equal(result.details.externalPaths[0].scope, 'external')
})

test('execution policy prompts for file-tool reads outside workspace', () => {
  const workspace = path.join(os.tmpdir(), 'aura-policy-workspace')
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'read_file',
    },
    args: {
      path: path.join(os.tmpdir(), 'external-notes.txt'),
    },
    settings: {
      cwd: workspace,
    },
  })

  assert.equal(result.action, 'prompt')
  assert.equal(result.approvalCategory, 'external_file_read')
  assert.equal(result.code, 'FILE_EXTERNAL_READ_ACCESS')
})

test('execution policy allows file-tool reads inside bound external skill directories', () => {
  const workspace = path.join(os.tmpdir(), 'aura-policy-workspace')
  const externalSkillDir = path.join(os.tmpdir(), 'aura-bound-skills')
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'read_file',
    },
    args: {
      path: path.join(externalSkillDir, 'docx', 'SKILL.md'),
    },
    settings: {
      cwd: workspace,
      externalSkillDirs: [externalSkillDir],
    },
  })

  assert.equal(result.action, 'allow')
})

test('execution policy still prompts for writes inside bound external skill directories', () => {
  const workspace = path.join(os.tmpdir(), 'aura-policy-workspace')
  const externalSkillDir = path.join(os.tmpdir(), 'aura-bound-skills')
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'write_file',
      approvalCategory: 'file_write',
    },
    args: {
      path: path.join(externalSkillDir, 'docx', 'SKILL.md'),
      content: '# Mutated\n',
    },
    settings: {
      cwd: workspace,
      externalSkillDirs: [externalSkillDir],
    },
  })

  assert.equal(result.action, 'prompt')
  assert.equal(result.approvalCategory, 'external_file_write')
})

test('execution policy allows shell reads inside bound external skill directories', () => {
  const workspace = path.join(os.tmpdir(), 'aura-policy-workspace')
  const externalSkillDir = path.join(os.tmpdir(), 'aura-bound-skills')
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'exec_command',
      approvalCategory: 'shell',
    },
    args: {
      cmd: `cat ${path.join(externalSkillDir, 'docx', 'SKILL.md')}`,
    },
    settings: {
      cwd: workspace,
      externalSkillDirs: [externalSkillDir],
    },
  })

  assert.equal(result.action, 'allow')
})

test('execution policy expands home-relative file-tool paths before sandbox checks', () => {
  const workspace = path.join(os.tmpdir(), 'aura-policy-workspace')
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'read_file',
    },
    args: {
      path: '~/.config/starship.toml',
    },
    settings: {
      cwd: workspace,
    },
  })

  assert.equal(result.action, 'prompt')
  assert.equal(result.approvalCategory, 'external_file_read')
  assert.equal(
    result.details.externalPaths[0].resolved,
    path.join(os.homedir(), '.config', 'starship.toml'),
  )
})

test('execution policy blocks file-tool writes into Aura capability directories', () => {
  const workspace = path.join(os.tmpdir(), 'aura-policy-workspace')
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'write_file',
      approvalCategory: 'file_write',
    },
    args: {
      path: path.join(os.homedir(), '.aura', 'skills', 'demo', 'SKILL.md'),
      content: '# Demo\n',
    },
    settings: {
      cwd: workspace,
    },
  })

  assert.equal(result.action, 'deny')
  assert.equal(result.approvalCategory, 'external_file_write')
  assert.equal(result.code, 'FILE_AURA_CAPABILITY_MUTATION_BLOCKED')
})

test('execution policy blocks Aura capability directory mutations through shell', () => {
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'exec_command',
      approvalCategory: 'shell',
    },
    args: {
      cmd: 'mkdir -p ~/.aura/skills/docx',
    },
    settings: {
      cwd: path.join(os.tmpdir(), 'aura-policy-workspace'),
    },
  })

  assert.equal(result.action, 'deny')
  assert.equal(result.code, 'SHELL_AURA_CAPABILITY_MUTATION_BLOCKED')
  assert.match(result.suggestedAction, /aura_install_skill/)
})

test('execution policy blocks manual shell installers during capability admin tasks', () => {
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'exec_command',
      approvalCategory: 'shell',
    },
    args: {
      cmd: 'git clone https://github.com/anthropics/skills.git /tmp/skills',
    },
    settings: {
      cwd: path.join(os.tmpdir(), 'aura-policy-workspace'),
    },
    routeState: {
      isCapabilityAdminTask: true,
    },
  })

  assert.equal(result.action, 'deny')
  assert.equal(result.code, 'SHELL_CAPABILITY_ADMIN_MANUAL_INSTALL_BLOCKED')
  assert.match(result.suggestedAction, /aura_install_skill/)
})

test('execution policy denies catastrophic commands', () => {
  const dangerous = commandMightBeDangerous('rm -rf /')
  assert.equal(dangerous.action, 'deny')

  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'run_shell',
      approvalCategory: 'shell',
    },
    args: {
      command: 'rm -rf /',
    },
    settings: {
      cwd: process.cwd(),
    },
  })

  assert.equal(result.action, 'deny')
  assert.equal(result.code, 'SHELL_DELETE_ROOT')
})

test('execution policy detects shell source mutation and known-safe commands', () => {
  assert.equal(
    looksLikeShellFileMutation("python3 - <<'PY'\nfrom pathlib import Path\nPath('src/App.tsx').write_text('bad')\nPY"),
    true,
  )
  assert.equal(
    looksLikeShellFileMutation(
      'cat ~/.npm/_npx/*/node_modules/@anthropic-ai/aura-skills/docx/SKILL.md 2>/dev/null || cat ~/.aura/skills/docx/SKILL.md 2>/dev/null || echo "NOT FOUND"',
    ),
    false,
  )
  assert.equal(isKnownSafeCommand('pnpm typecheck'), true)
  assert.equal(isKnownSafeCommand('pnpm typecheck && rm -rf /'), false)
})

test('execution policy does not treat read-only stderr redirection as source mutation', () => {
  const result = evaluateToolExecutionPolicy({
    tool: {
      name: 'exec_command',
      approvalCategory: 'shell',
    },
    args: {
      cmd: 'cat ~/.npm/_npx/*/node_modules/@anthropic-ai/aura-skills/docx/SKILL.md 2>/dev/null || cat ~/.aura/skills/docx/SKILL.md 2>/dev/null || echo "NOT FOUND"',
    },
    settings: {
      cwd: path.join(os.tmpdir(), 'aura-policy-workspace'),
    },
  })

  assert.notEqual(result.code, 'SHELL_FILE_MUTATION_BLOCKED')
})
