import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCompressedSummaryMessage,
  buildContextCompressionBudget,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  formatMessagesForCompaction,
  resolveContextWindowTokens,
  selectRecentUserMessagesForCompactionSummary,
  shouldCompressMessages,
  splitMessagesIntoTokenBatches,
} from './contextCompression.mjs'

test('estimateTextTokens uses the local tokenizer', () => {
  assert.equal(estimateTextTokens('hello world '.repeat(100)), 201)
  assert.equal(estimateTextTokens('你好世界'.repeat(100)), 500)
  assert.equal(estimateTextTokens('你好世界'.repeat(100), { model: 'gpt-4o' }), 200)
})

test('estimateMessageTokens counts distinct content and non-text parts together', () => {
  const textOnly = estimateMessageTokens({
    role: 'user',
    content: '请检查这个截图并总结问题。',
  })
  const imageOnly = estimateMessageTokens({
    role: 'user',
    parts: [{ type: 'image', name: 'screen.png', mimeType: 'image/png' }],
  })
  const combined = estimateMessageTokens({
    role: 'user',
    content: '请检查这个截图并总结问题。',
    parts: [{ type: 'image', name: 'screen.png', mimeType: 'image/png' }],
  })

  assert.ok(combined > textOnly)
  assert.ok(combined > imageOnly)
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
  assert.equal(budget.windowSource, 'model_metadata')
  assert.equal(budget.configuredContextWindowTokens, 256_000)
  assert.equal(budget.configuredThresholdTokens, 256_000)
  assert.equal(budget.maxOutputTokens, 20_000)
  assert.ok(budget.effectiveThresholdTokens < budget.compressionThresholdTokens)
})

test('buildContextCompressionBudget uses configured budget when model metadata is absent', () => {
  const budget = buildContextCompressionBudget({
    provider: 'google',
    model: 'gemini-1.5-pro',
    contextCompressionThresholdTokens: 64_000,
  })

  assert.equal(budget.contextWindowTokens, 64_000)
  assert.equal(budget.windowSource, 'settings')
  assert.equal(budget.configuredThresholdTokens, 64_000)
  assert.equal(budget.compressionThresholdTokens, Math.floor(64_000 * 0.85))
})

test('buildContextCompressionBudget subtracts tool schema tokens from effective threshold', () => {
  const baseBudget = buildContextCompressionBudget({
    provider: 'openai',
    model: 'gpt-4o',
    contextCompressionThresholdTokens: 80_000,
  })
  const budgetWithTools = buildContextCompressionBudget(
    {
      provider: 'openai',
      model: 'gpt-4o',
      contextCompressionThresholdTokens: 80_000,
    },
    {
      toolSchemaTokens: 12_000,
    },
  )

  assert.equal(budgetWithTools.toolSchemaTokens, 12_000)
  assert.equal(
    budgetWithTools.effectiveThresholdTokens,
    baseBudget.effectiveThresholdTokens - 12_000,
  )
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

test('resolveContextWindowTokens defaults to 256k when no model budget is available', () => {
  assert.equal(
    resolveContextWindowTokens({
      provider: 'openai',
      model: 'unknown-model',
    }),
    256_000,
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
      content: 'old oversized context '.repeat(16_000),
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

test('shouldCompressMessages can trigger from provider usage even when local estimate is low', () => {
  const result = shouldCompressMessages(
    [
      { role: 'user', content: 'small' },
      { role: 'assistant', content: 'small' },
    ],
    {
      provider: 'openai',
      model: 'gpt-main',
      contextCompressionThresholdTokens: 40_000,
    },
    {
      latestInputTokens: 32_000,
    },
  )

  assert.equal(result.shouldCompress, true)
  assert.equal(result.trigger, 'provider_usage')
})

test('selectRecentUserMessagesForCompactionSummary preserves latest user goals within budget', () => {
  const selected = selectRecentUserMessagesForCompactionSummary(
    [
      { role: 'user', content: 'old goal '.repeat(200) },
      { role: 'assistant', content: 'large tool result '.repeat(2000) },
      { role: 'user', content: 'new goal' },
    ],
    500,
  )

  assert.ok(selected.length >= 1)
  assert.match(selected.at(-1).content, /new goal/)
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
