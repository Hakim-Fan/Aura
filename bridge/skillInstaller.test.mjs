import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveAuraSkillInstallSource } from './skillInstaller.mjs'

const remoteSkill = [
  '---',
  'name: Remote Skill',
  'description: Installed from a parsed command.',
  '---',
  '',
  '# Remote Skill',
].join('\n')

test('resolveAuraSkillInstallSource stages direct SKILL.md content', async () => {
  const staged = await resolveAuraSkillInstallSource({
    cwd: process.cwd(),
    content: [
      '---',
      'name: Inline Skill',
      'description: Installed from pasted content.',
      '---',
      '',
      '# Inline Skill',
    ].join('\n'),
    sourceType: 'content',
  })

  try {
    assert.equal(staged.inferredSkillId, 'inline-skill')
    assert.equal(staged.name, 'Inline Skill')
    assert.match(await fs.readFile(staged.stagedPath, 'utf8'), /Installed from pasted content/)
  } finally {
    await staged.cleanup()
  }
})

test('resolveAuraSkillInstallSource treats npx commands as source clues instead of scripts to execute', async () => {
  const seenUrls = []
  const staged = await resolveAuraSkillInstallSource({
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'aura-skill-installer-')),
    source: 'npx -y some-foreign-installer https://example.com/SKILL.md',
    sourceType: 'npx',
    fetchImpl: async url => {
      seenUrls.push(url)
      return new Response(remoteSkill, { status: 200 })
    },
  })

  try {
    assert.deepEqual(seenUrls, ['https://example.com/SKILL.md'])
    assert.equal(staged.inferredSkillId, 'remote-skill')
    assert.match(await fs.readFile(staged.stagedPath, 'utf8'), /Remote Skill/)
  } finally {
    await staged.cleanup()
  }
})
