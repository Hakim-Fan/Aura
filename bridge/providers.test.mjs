import test from 'node:test'
import assert from 'node:assert/strict'
import { __testInternals } from './providers.mjs'

const {
  buildFinalizerPrompt,
  buildProviderRetryInfo,
  compactMessagesWithProvider,
  extractInlineToolCalls,
  getProviderFailureRecoveryMaxRetries,
  getProviderRetryDelayMs,
  hasWriteRepairAttemptSince,
  maybeSpillAssistantContent,
  mergeOpenAiToolCalls,
  parseToolArguments,
  resolveCompactionOutputTokens,
  resolveCompactionSettings,
  runProviderOperationWithRetry,
  updateUnresolvedToolErrorForRepair,
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

test('parseToolArguments accepts raw apply_patch bodies for apply_patch', () => {
  const rawPatch = [
    '*** Begin Patch',
    '*** Update File: src/sample.txt',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n')

  assert.deepEqual(parseToolArguments(rawPatch, 'apply_patch'), {
    patch: rawPatch,
  })
})

test('parseToolArguments extracts freeform apply_patch bodies from malformed wrappers', () => {
  const rawPatch = [
    '*** Begin Patch',
    '*** Add File: note.txt',
    '+hello',
    '*** End Patch',
  ].join('\n')

  assert.deepEqual(
    parseToolArguments(`{"patch": "${rawPatch}"}`, 'apply_patch'),
    {
      patch: rawPatch,
    },
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

test('extractInlineToolCalls removes xml-style raw tool markers from visible text', () => {
  const extracted = extractInlineToolCalls(
    [
      '我先找一下文档。',
      '<tool_call>',
      '<function=glob_files>',
      '<parameter=pattern>**/*.docx</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n'),
  )

  assert.equal(extracted.text, '我先找一下文档。')
  assert.equal(extracted.toolCalls.length, 1)
  assert.equal(extracted.toolCalls[0].function.name, 'glob_files')
  assert.deepEqual(parseToolArguments(extracted.toolCalls[0].function.arguments), {
    pattern: '**/*.docx',
  })
})

test('extractInlineToolCalls converts json tool markers and strips hallucinated tool results', () => {
  const extracted = extractInlineToolCalls(
    [
      '我先执行。',
      '<tool_call>',
      '{"name":"bash","arguments":{"command":"git clone https://github.com/anthropics/skills.git /tmp/skills 2>&1"}}',
      '</tool_call>',
      '<tool_result>',
      'Cloning into /tmp/skills...',
      '</tool_result>',
      '<tool_call>',
      '{"name":"bash","arguments":{"command":"cat /tmp/skills/skills/docx/skill.md"}}',
      '</tool_call>',
      '<tool_result>',
      '# Docx Skill',
      '</tool_result>',
      '已完成安装。',
    ].join('\n'),
  )

  assert.equal(extracted.text, '我先执行。')
  assert.equal(extracted.toolCalls.length, 1)
  assert.equal(extracted.toolCalls[0].function.name, 'run_shell')
  assert.deepEqual(parseToolArguments(extracted.toolCalls[0].function.arguments), {
    command: 'git clone https://github.com/anthropics/skills.git /tmp/skills 2>&1',
  })
})

test('provider failure recovery uses a fixed five-retry policy', () => {
  assert.equal(getProviderFailureRecoveryMaxRetries(), 5)
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

test('runProviderOperationWithRetry clears in-progress retry state after a successful retry', async () => {
  const progressEvents = []
  let attempts = 0

  const result = await runProviderOperationWithRetry(
    async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('network timeout')
      }
      return 'ok'
    },
    {
      messages: [],
      hooks: {
        onRetryProgress(retryInfo) {
          progressEvents.push(retryInfo)
        },
      },
    },
  )

  assert.equal(result.value, 'ok')
  assert.equal(result.retryCount, 1)
  assert.equal(progressEvents.length, 2)
  assert.equal(progressEvents[0]?.inProgress, true)
  assert.equal(progressEvents[0]?.attemptedRetries, 1)
  assert.equal(progressEvents[0]?.nextRetryDelayMs, 0)
  assert.equal(progressEvents[0]?.nextAttemptNumber, 2)
  assert.equal(progressEvents[1]?.inProgress, undefined)
  assert.equal(progressEvents[1]?.attemptedRetries, 1)
  assert.match(progressEvents[1]?.lastErrorSummary || '', /模型连接在生成过程中被中断/)
})

test('buildFinalizerPrompt can omit duplicated tool and reasoning digests', () => {
  const prompt = buildFinalizerPrompt({
    toolEvents: [
      {
        name: 'read_file',
        status: 'success',
        output: 'const meaning = 42;',
      },
    ],
    reasoningText: '先读取文件，再整理答案。',
    draftMessage: '我已经定位到问题。',
    completionState: 'needs_final_answer_after_tool_results',
    includeToolDigest: false,
    includeReasoningText: false,
  })

  assert.match(prompt, /当前已有但不完整的回答/)
  assert.doesNotMatch(prompt, /本轮工具结果摘要/)
  assert.doesNotMatch(prompt, /本轮原始思考流/)
})

test('maybeSpillAssistantContent saves long intermediate output as an artifact summary', () => {
  const context = { cwd: process.cwd() }
  const toolEvents = []
  const reasoningDeltas = []
  const result = maybeSpillAssistantContent({
    content: 'large table row '.repeat(7000),
    settings: { model: 'gpt-test' },
    hooks: {
      workMemoryContext: context,
      onToolEvent(event) {
        assert.equal(event.name, 'assistant_output_spillover')
      },
      onReasoningDelta(delta) {
        reasoningDeltas.push(delta)
      },
    },
    toolEvents,
    providerKind: 'openai',
    reason: 'tool_calls',
    order: 2,
    stage: 'step-1',
  })

  assert.equal(result.spilled, true)
  assert.match(result.content, /Large intermediate assistant output saved/)
  assert.match(result.content, /Artifact: draft-/)
  assert.equal(context.artifactStore.artifacts.length, 1)
  assert.ok(context.artifactStore.artifacts[0].chunks.length > 1)
  assert.match(context.artifactStore.artifacts[0].chunks[0].content.text, /large table row/)
  assert.ok(context.artifactStore.artifacts[0].chunks[0].content.text.length <= 8000)
  assert.equal(toolEvents.length, 1)
  assert.match(toolEvents[0].summary, /Long intermediate assistant output saved/)
  assert.equal(reasoningDeltas.length, 1)
})

test('resolveCompactionSettings prefers a dedicated analysis profile and model when configured', () => {
  const resolved = resolveCompactionSettings({
    provider: 'openai',
    apiKey: 'primary-key',
    baseUrl: 'https://primary.example/v1',
    model: 'gpt-main',
    analysisProviderProfileId: 'analysis',
    analysisModel: 'gemini-2.5-flash',
    providerProfiles: [
      {
        id: 'primary',
        provider: 'openai',
        apiKey: 'primary-key',
        baseUrl: 'https://primary.example/v1',
        models: [{ id: 'gpt-main', enabled: true }],
      },
      {
        id: 'analysis',
        provider: 'google',
        apiKey: 'analysis-key',
        baseUrl: 'https://google.example/v1beta',
        models: [{ id: 'gemini-2.5-flash', enabled: true }],
      },
    ],
  })

  assert.equal(resolved.provider, 'google')
  assert.equal(resolved.apiKey, 'analysis-key')
  assert.equal(resolved.baseUrl, 'https://google.example/v1beta')
  assert.equal(resolved.model, 'gemini-2.5-flash')
})

test('resolveCompactionOutputTokens leaves room for preserved recent context', () => {
  assert.equal(resolveCompactionOutputTokens(10_000, 1_500), 8_000)
  assert.equal(resolveCompactionOutputTokens(3_200, 2_900), 800)
})

test('compactMessagesWithProvider reduces preserved recent messages when they exceed the target budget', async () => {
  const messages = [
    { role: 'user', content: 'older context '.repeat(600) },
    { role: 'assistant', content: 'older reply '.repeat(600) },
    ...Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'recent oversized context '.repeat(1_200),
    })),
  ]

  const result = await compactMessagesWithProvider({
    settings: {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-main',
    },
    messages,
    targetTokens: 6_000,
    keepRecentCount: 6,
    callProvider: async () => 'summary',
  })

  assert.equal(result.length, 1)
  assert.match(result[0]?.content || '', /\[Compressed summary/)
})

test('compactMessagesWithProvider carries forward earlier batch summaries into later batches', async () => {
  const prompts = []
  const messages = Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index} ` + 'payload '.repeat(500),
  }))

  const result = await compactMessagesWithProvider({
    settings: {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-main',
    },
    messages,
    targetTokens: 5_000,
    keepRecentCount: 0,
    maxInputBatchTokens: 1_200,
    callProvider: async (_settings, options) => {
      prompts.push(options.userPrompt)
      return `summary-${prompts.length}`
    },
  })

  assert.ok(prompts.length > 1)
  assert.match(prompts[1], /Running summary from earlier batches:/)
  assert.match(prompts[1], /summary-1/)
  assert.match(result[0]?.content || '', /summary-\d+/)
  assert.match(result[0]?.content || '', new RegExp(`summary-${prompts.length}`))
})

test('compactMessagesWithProvider retries with smaller batches after context errors', async () => {
  const batchSizes = []
  const messages = [
    { role: 'user', content: 'older context '.repeat(1_000) },
    { role: 'assistant', content: 'older reply '.repeat(1_000) },
    { role: 'user', content: 'latest instruction' },
  ]

  const result = await compactMessagesWithProvider({
    settings: {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-main',
    },
    messages,
    targetTokens: 4_000,
    keepRecentCount: 0,
    maxInputBatchTokens: 2_400,
    callProvider: async (_settings, options) => {
      batchSizes.push(options.userPrompt.length)
      if (batchSizes.length === 1) {
        const error = new Error('context length exceeded')
        error.status = 400
        throw error
      }
      return `summary-${batchSizes.length}`
    },
  })

  assert.ok(batchSizes.length > 1)
  assert.match(result[0]?.content || '', /summary-\d+/)
})

test('compactMessagesWithProvider embeds recent user messages into the summary', async () => {
  const result = await compactMessagesWithProvider({
    settings: {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-main',
    },
    messages: [
      { role: 'user', content: 'please remember the exact goal' },
      { role: 'assistant', content: 'tool output '.repeat(2_000) },
      { role: 'user', content: 'new exact instruction' },
    ],
    targetTokens: 4_000,
    keepRecentCount: 0,
    callProvider: async () => 'summary',
  })

  assert.match(result[0]?.content || '', /Recent User Messages Preserved Verbatim/)
  assert.match(result[0]?.content || '', /new exact instruction/)
})

test('tool-error repair state stays unresolved after read-only inspection', () => {
  const events = [
    {
      name: 'apply_patch',
      status: 'error',
      errorInfo: {
        category: 'patch_context_mismatch',
      },
    },
  ]

  let unresolved = updateUnresolvedToolErrorForRepair(events, 0, false)
  assert.equal(unresolved, true)

  events.push({
    name: 'read_file',
    status: 'success',
  })
  unresolved = updateUnresolvedToolErrorForRepair(events, 1, unresolved)
  assert.equal(unresolved, true)

  events.push({
    name: 'replace_line_range',
    status: 'success',
  })
  unresolved = updateUnresolvedToolErrorForRepair(events, 2, unresolved)
  assert.equal(unresolved, false)
})

test('invalid edit parameters do not consume write repair attempts', () => {
  const events = [
    {
      name: 'replace_line_range',
      status: 'error',
      errorInfo: {
        category: 'invalid_input',
        code: 'INVALID_LINE_RANGE',
      },
    },
  ]

  assert.equal(hasWriteRepairAttemptSince(events, 0), false)

  events.push({
    name: 'replace_line_range',
    status: 'error',
    errorInfo: {
      category: 'text_context_mismatch',
    },
  })

  assert.equal(hasWriteRepairAttemptSince(events, 1), true)
})
