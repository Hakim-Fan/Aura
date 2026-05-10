import test from 'node:test'
import assert from 'node:assert/strict'
import {
  peekDeterministicIntentClassification,
  resolveIntentClassification,
} from './intentClassifier.mjs'

test('deterministic classifier no longer infers external facts from generic latest/search wording alone', () => {
  const result = peekDeterministicIntentClassification(
    [
      {
        role: 'user',
        content: '搜索一下今天的 AI 新闻',
      },
    ],
    {
      hardSignals: {
        explicitWebLookupRead: false,
        publicWebUrlReference: false,
        explicitWebInteraction: false,
        explicitSystemBrowserRequest: false,
      },
      settings: {},
    },
  )

  assert.equal(result, null)
})

test('deterministic classifier exposes capability admin tools for skill installation', () => {
  const result = peekDeterministicIntentClassification(
    [
      {
        role: 'user',
        content:
          '帮我安装这个 Aura skill：https://github.com/anthropics/skills/tree/main/skills/docx',
      },
    ],
    {
      hardSignals: {},
      settings: {},
    },
  )

  assert.equal(result.answerMode, 'execute')
  assert.equal(result.isCapabilityAdmin, true)
  assert.equal(result.needsExternalFacts, true)
  assert.equal(result.confidence, 'high')
})

test('resolveIntentClassification uses deterministic capability admin route before provider calls', async () => {
  const result = await resolveIntentClassification(
    [
      {
        role: 'user',
        content: '安装 docx skill',
      },
    ],
    {
      provider: 'openai',
      apiKey: '',
      model: '',
    },
  )

  assert.equal(result.source, 'deterministic')
  assert.equal(result.classification.isCapabilityAdmin, true)
})
