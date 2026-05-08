import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSkillPrompt } from './extensions.mjs'

test('buildSkillPrompt lists enabled skills without injecting preferred tool routing', () => {
  const prompt = buildSkillPrompt([
    {
      id: 'web-research',
      name: 'Web Research',
      description: 'Find and compare public sources.',
      allowedTools: ['web_search', 'web_fetch'],
    },
  ])

  assert.match(prompt, /Web Research/)
  assert.match(prompt, /id: web-research/)
  assert.match(prompt, /aura_read_skill with skillId "web-research"/)
  assert.doesNotMatch(prompt, /preferred tools/i)
})
