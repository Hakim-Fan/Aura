import test from 'node:test'
import assert from 'node:assert/strict'
import { peekDeterministicIntentClassification } from './intentClassifier.mjs'

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
