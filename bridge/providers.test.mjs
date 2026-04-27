import test from 'node:test'
import assert from 'node:assert/strict'
import { __testInternals } from './providers.mjs'

const {
  buildProviderRetryInfo,
  extractInlineToolCalls,
  getProviderFailureRecoveryMaxRetries,
  getProviderRetryDelayMs,
  mergeOpenAiToolCalls,
  parseToolArguments,
} = __testInternals

test('mergeOpenAiToolCalls keeps append-only tool argument chunks parseable', () => {
  const toolCalls = []

  mergeOpenAiToolCalls(toolCalls, [
    {
      index: 0,
      id: 'call_read_file',
      function: {
        name: 'read_file',
        arguments: '{"path":"src/views/',
      },
    },
  ])
  mergeOpenAiToolCalls(toolCalls, [
    {
      index: 0,
      function: {
        arguments: 'home/CalcRecordDetailView.vue"}',
      },
    },
  ])

  assert.deepEqual(parseToolArguments(toolCalls[0].function.arguments), {
    path: 'src/views/home/CalcRecordDetailView.vue',
  })
})

test('mergeOpenAiToolCalls keeps cumulative tool argument chunks parseable', () => {
  const toolCalls = []

  mergeOpenAiToolCalls(toolCalls, [
    {
      index: 0,
      id: 'call_read_file',
      function: {
        name: 'read_file',
        arguments: '{"path":"src/v',
      },
    },
  ])
  mergeOpenAiToolCalls(toolCalls, [
    {
      index: 0,
      function: {
        arguments: '{"path":"src/views/home/Calc',
      },
    },
  ])
  mergeOpenAiToolCalls(toolCalls, [
    {
      index: 0,
      function: {
        arguments: '{"path":"src/views/home/CalcRecordDetailView.vue"}',
      },
    },
  ])

  assert.deepEqual(parseToolArguments(toolCalls[0].function.arguments), {
    path: 'src/views/home/CalcRecordDetailView.vue',
  })
})

test('parseToolArguments surfaces a structured provider error for malformed JSON', () => {
  assert.throws(
    () => parseToolArguments('{"path":"src/views",}'),
    error =>
      error?.errorInfo?.code === 'INVALID_TOOL_ARGUMENTS_JSON' &&
      error?.errorInfo?.category === 'invalid_input' &&
      /无法解析的工具参数/.test(error?.message || ''),
  )
})

test('extractInlineToolCalls converts codex-style raw tool markers into executable tool calls', () => {
  const extracted = extractInlineToolCalls(
    [
      '我先查看实现。',
      '<|tool_calls_section_begin|> <|tool_call_begin|> functions.read_file:0 <|tool_call_argument_begin|> {"file_path":"src/views/home/CalcRecordDetailView.vue"} <|tool_call_end|> <|tool_calls_section_end|>',
    ].join('\n'),
  )

  assert.equal(extracted.text, '我先查看实现。')
  assert.equal(extracted.toolCalls.length, 1)
  assert.equal(extracted.toolCalls[0].function.name, 'read_file')
  assert.deepEqual(parseToolArguments(extracted.toolCalls[0].function.arguments), {
    path: 'src/views/home/CalcRecordDetailView.vue',
    filePath: 'src/views/home/CalcRecordDetailView.vue',
  })
})

test('provider failure recovery uses a fixed five-retry policy when enabled', () => {
  assert.equal(
    getProviderFailureRecoveryMaxRetries({
      enableProviderFailureRecovery: true,
      providerFailureRecoveryMaxAttempts: 1,
    }),
    5,
  )
  assert.equal(
    getProviderFailureRecoveryMaxRetries({
      enableProviderFailureRecovery: true,
      providerFailureRecoveryMaxAttempts: 99,
    }),
    5,
  )
  assert.equal(
    getProviderFailureRecoveryMaxRetries({
      enableProviderFailureRecovery: false,
      providerFailureRecoveryMaxAttempts: 5,
    }),
    0,
  )
})

test('provider retry delays follow the fixed progressive backoff strategy', () => {
  assert.equal(getProviderRetryDelayMs(1), 0)
  assert.equal(getProviderRetryDelayMs(2), 1_200)
  assert.equal(getProviderRetryDelayMs(3), 3_000)
  assert.equal(getProviderRetryDelayMs(4), 7_000)
  assert.equal(getProviderRetryDelayMs(5), 15_000)
  assert.equal(getProviderRetryDelayMs(9), 15_000)
})

test('buildProviderRetryInfo exposes live retry progress metadata', () => {
  assert.deepEqual(
    buildProviderRetryInfo(2, 5, {
      stage: 'response',
      inProgress: true,
      nextRetryDelayMs: 3_000,
      nextAttemptNumber: 3,
      lastErrorSummary: '模型服务请求失败。',
    }),
    {
      attemptedRetries: 2,
      configuredMaxRetries: 5,
      configuredMaxAttempts: 6,
      stage: 'response',
      stageLabel: '主回答',
      recovered: false,
      inProgress: true,
      nextRetryDelayMs: 3_000,
      nextAttemptNumber: 3,
      lastErrorSummary: '模型服务请求失败。',
    },
  )
})
