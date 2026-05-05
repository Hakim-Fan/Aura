import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCompressedSummaryMessage,
  buildContextCompressionBudget,
  estimateMessagesTokens,
  estimateTextTokens,
  formatMessagesForCompaction,
  resolveContextWindowTokens,
  shouldCompressMessages,
  splitMessagesIntoTokenBatches,
} from './contextCompression.mjs'

test('estimateTextTokens counts CJK text more densely than ASCII text', () => {
  assert.ok(estimateTextTokens('hello world '.repeat(100)) < 400)
  assert.ok(estimateTextTokens('你好世界'.repeat(100)) >= 560)
})

test('formatMessagesForCompaction preserves text and summarizes binary parts without data URLs', () => {
  const formatted = formatMessagesForCompaction([
    {
      role: 'user',
      content: 'Please inspect this screenshot.',
      parts: [
        {
          type: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${'a'.repeat(200)}`,
        },
      ],
    },
  ])

  assert.match(formatted, /Please inspect this screenshot/)
  assert.match(formatted, /\[Image attachment\]/)
  assert.match(formatted, /screen\.png/)
  assert.doesNotMatch(formatted, /data:image\/png/)
})

test('buildContextCompressionBudget uses model metadata when available', () => {
  const budget = buildContextCompressionBudget({
    provider: 'openai',
    model: 'large-context',
    contextCompressionThresholdTokens: 256_000,
    activeProviderProfileId: 'p1',
    providerProfiles: [
      {
        id: 'p1',
        provider: 'openai',
        models: [
          {
            id: 'large-context',
            enabled: true,
            contextWindowTokens: 200_000,
            maxOutputTokens: 20_000,
          },
        ],
      },
    ],
  })

  assert.equal(budget.contextWindowTokens, 200_000)
  assert.equal(budget.configuredThresholdTokens, 256_000)
  assert.equal(budget.maxOutputTokens, 20_000)
  assert.ok(budget.effectiveThresholdTokens < budget.compressionThresholdTokens)
})

test('buildContextCompressionBudget honors a smaller configured compression threshold', () => {
  const budget = buildContextCompressionBudget({
    provider: 'google',
    model: 'gemini-1.5-pro',
    contextCompressionThresholdTokens: 64_000,
  })

  assert.equal(budget.contextWindowTokens, 1_000_000)
  assert.equal(budget.configuredThresholdTokens, 64_000)
  assert.equal(budget.compressionThresholdTokens, 64_000)
})

test('resolveContextWindowTokens infers large Gemini windows when metadata is absent', () => {
  assert.equal(
    resolveContextWindowTokens({
      provider: 'google',
      model: 'gemini-1.5-pro',
    }),
    1_000_000,
  )
})

test('shouldCompressMessages only triggers beyond the effective token threshold', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'long context '.repeat(1200),
  }))
  const result = shouldCompressMessages(
    messages,
    {
      provider: 'custom',
      baseUrl: 'http://localhost:11434',
      model: 'local-model',
    },
    {
      keepRecentCount: 4,
    },
  )

  assert.equal(result.shouldCompress, true)
  assert.ok(result.estimatedTokens > result.budget.effectiveThresholdTokens)
})

test('shouldCompressMessages can trigger for short conversations with oversized history', () => {
  const messages = [
    {
      role: 'user',
      content: 'old oversized context '.repeat(4000),
    },
    {
      role: 'user',
      content: 'continue',
    },
  ]
  const result = shouldCompressMessages(
    messages,
    {
      provider: 'custom',
      baseUrl: 'http://localhost:11434',
      model: 'local-model',
    },
    {
      keepRecentCount: 6,
    },
  )

  assert.equal(result.shouldCompress, true)
})

test('splitMessagesIntoTokenBatches keeps every message without truncating text', () => {
  const messages = [
    { role: 'user', content: 'alpha '.repeat(500) },
    { role: 'assistant', content: 'beta '.repeat(500) },
    { role: 'user', content: 'gamma '.repeat(500) },
  ]
  const originalTokens = estimateMessagesTokens(messages)
  const batches = splitMessagesIntoTokenBatches(messages, Math.ceil(originalTokens / 2))

  assert.equal(batches.flat().length, messages.length)
  assert.deepEqual(batches.flat(), messages)
  assert.ok(batches.length > 1)
})

test('splitMessagesIntoTokenBatches splits oversized single messages without dropping content', () => {
  const content = '0123456789'.repeat(4000)
  const batches = splitMessagesIntoTokenBatches(
    [
      {
        role: 'user',
        content,
      },
    ],
    1_200,
  )
  const reconstructed = batches
    .flat()
    .map(message => message.content.replace(/^\[Chunk \d+\/\d+ of an oversized user message\.\]\n\n/u, ''))
    .join('')

  assert.equal(reconstructed, content)
  assert.ok(batches.flat().length > 1)
})

test('buildCompressedSummaryMessage returns an assistant summary message', () => {
  assert.deepEqual(
    buildCompressedSummaryMessage('## User Goals\nShip it.', 8, {
      beforeTokens: 10_000,
      afterTokens: 500,
    }),
    {
      role: 'assistant',
      content:
        '[Compressed summary of 8 earlier conversation message(s).]\nEstimated tokens: 10000 -> 500.\n\n## User Goals\nShip it.',
      parts: [],
    },
  )
})
