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

test('resolveAuraSkillInstallSource stages a GitHub tree URL through the contents API', async () => {
  const requestedUrls = []
  const skillContent = [
    '---',
    'name: Docx Skill',
    'description: GitHub tree install.',
    '---',
    '',
    '# Docx Skill',
  ].join('\n')
  const staged = await resolveAuraSkillInstallSource({
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'aura-skill-installer-')),
    source: 'https://github.com/anthropics/skills/tree/main/skills/docx',
    fetchImpl: async url => {
      requestedUrls.push(url)
      if (String(url).includes('/contents/skills/docx?ref=main')) {
        return new Response(
          JSON.stringify([
            {
              type: 'file',
              path: 'skills/docx/SKILL.md',
              url: 'https://api.github.com/file/skill',
            },
            {
              type: 'file',
              path: 'skills/docx/LICENSE.txt',
              url: 'https://api.github.com/file/license',
            },
          ]),
          { status: 200 },
        )
      }
      if (String(url).endsWith('/file/skill')) {
        return new Response(
          JSON.stringify({
            type: 'file',
            path: 'skills/docx/SKILL.md',
            encoding: 'base64',
            content: Buffer.from(skillContent, 'utf8').toString('base64'),
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          type: 'file',
          path: 'skills/docx/LICENSE.txt',
          encoding: 'base64',
          content: Buffer.from('license', 'utf8').toString('base64'),
        }),
        { status: 200 },
      )
    },
  })

  try {
    assert.equal(staged.inferredSkillId, 'docx-skill')
    assert.equal(staged.name, 'Docx Skill')
    assert.ok(requestedUrls.some(url => String(url).includes('/contents/skills/docx?ref=main')))
  } finally {
    await staged.cleanup()
  }
})
