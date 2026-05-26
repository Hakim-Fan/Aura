import test from 'node:test'
import assert from 'node:assert/strict'
import { __testInternals } from './providers.mjs'

const {
  buildOpenAiAssistantToolCallTranscriptEntry,
  buildFinalizerPrompt,
  buildProviderRetryInfo,
  compactMessagesWithProvider,
  extractInlineToolCalls,
  getProviderFailureRecoveryMaxRetries,
  getProviderRetryDelayMs,
  hasWriteRepairAttemptSince,
  maybeSpillAssistantContent,
  maybeSpillToolOutputForTranscript,
  mergeOpenAiToolCalls,
  normalizeGoogleUsage,
  normalizeOpenAiUsage,
  parseToolArguments,
  readSseStream,
  resolveCompactionOutputTokens,
  resolveCompactionSettings,
  runProviderOperationWithRetry,
  shouldNudgeForObservableProgress,
  shouldInjectObservableProgressReplan,
  summarizePartialToolCalls,
  OBSERVABLE_PROGRESS_REPLAN_PROMPT,
  updateUnresolvedToolErrorForRepair,
} = __testInternals

test('provider usage preserves cached input token counters', () => {
  assert.deepEqual(
    normalizeOpenAiUsage({
      prompt_tokens: 2048,
      completion_tokens: 128,
      prompt_tokens_details: {
        cached_tokens: 1536,
      },
    }),
    {
      inputTokens: 2048,
      outputTokens: 128,
      cachedInputTokens: 1536,
    },
  )

  assert.deepEqual(
    normalizeGoogleUsage({
      promptTokenCount: 4096,
      candidatesTokenCount: 256,
      cachedContentTokenCount: 3072,
    }),
    {
      inputTokens: 4096,
      outputTokens: 256,
      cachedInputTokens: 3072,
    },
  )
})

test('custom OpenAI-compatible tool-call turns round-trip reasoning_content', () => {
  const entry = buildOpenAiAssistantToolCallTranscriptEntry({
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      },
    ],
    reasoningContent: 'Need to inspect the file first.',
    settings: { provider: 'custom' },
  })

  assert.equal(entry.reasoning_content, 'Need to inspect the file first.')
})

test('OpenAI tool-call turns keep the standard assistant message shape', () => {
  const entry = buildOpenAiAssistantToolCallTranscriptEntry({
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      },
    ],
    reasoningContent: 'OpenAI should not receive this non-standard field.',
    settings: { provider: 'openai' },
  })

  assert.equal('reasoning_content' in entry, false)
})

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

test('shouldNudgeForObservableProgress asks execution tasks for visible progress once', () => {
  assert.equal(
    shouldNudgeForObservableProgress({
      settings: { executionMode: 'long-task' },
      hooks: { routeState: { answerMode: 'execute' } },
      toolEvents: [],
      content: '已经分析出需要读取文件并生成产物，但是这一轮还没有调用任何工具产生可观察结果。当前回答继续描述方案、步骤、原因和预期结果，但没有真正读取文件、写入产物、执行验证或记录进度。',
      nudgeCount: 0,
    }),
    true,
  )
  assert.equal(
    shouldNudgeForObservableProgress({
      settings: { executionMode: 'long-task' },
      hooks: { routeState: { answerMode: 'execute' } },
      toolEvents: [{ id: 'tool-1', status: 'success' }],
      content: '已有工具结果。',
      nudgeCount: 0,
    }),
    false,
  )
  assert.equal(
    shouldNudgeForObservableProgress({
      settings: { executionMode: 'long-task' },
      hooks: { routeState: { answerMode: 'execute' } },
      toolEvents: [],
      content: '第一次已经提醒过。',
      nudgeCount: 1,
    }),
    false,
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
  assert.match(progressEvents[1]?.lastErrorSummary || '', /模型响应超时|模型连接在生成过程中被中断/)
})

test('runProviderOperationWithRetry discards failed attempt reasoning before retry', async () => {
  const discardEvents = []
  let attempts = 0

  const result = await runProviderOperationWithRetry(
    async (attemptState) => {
      attempts += 1
      attemptState.reasoningBlockId = 'reasoning-openai-step-1'
      if (attempts === 1) {
        attemptState.partialReasoning = 'first attempt reasoning'
        throw new Error('network timeout')
      }
      return 'ok'
    },
    {
      messages: [],
      hooks: {
        onReasoningDiscard(event) {
          discardEvents.push(event)
        },
      },
    },
  )

  assert.equal(result.value, 'ok')
  assert.equal(discardEvents.length, 1)
  assert.equal(discardEvents[0]?.blockId, 'reasoning-openai-step-1')
  assert.equal(discardEvents[0]?.attemptNumber, 1)
  assert.equal(discardEvents[0]?.nextAttemptNumber, 2)
})

test('runProviderOperationWithRetry can prepare a local replan prompt before retry', async () => {
  const injectedPrompts = []
  let attempts = 0

  const stalledError = new Error('模型服务流式输出长时间没有继续。')
  stalledError.errorInfo = {
    code: 'PROVIDER_STREAM_STALLED',
    retryable: true,
  }

  const result = await runProviderOperationWithRetry(
    async () => {
      attempts += 1
      if (attempts === 1) {
        throw stalledError
      }
      return 'ok'
    },
    {
      messages: [],
      prepareRetry({ error }) {
        if (shouldInjectObservableProgressReplan(error)) {
          injectedPrompts.push(OBSERVABLE_PROGRESS_REPLAN_PROMPT)
        }
      },
    },
  )

  assert.equal(result.value, 'ok')
  assert.equal(injectedPrompts.length, 1)
  assert.match(injectedPrompts[0], /不要简单重复原计划/)
  assert.match(injectedPrompts[0], /多个可观察、可验证、可恢复的小步骤/)
})

test('runProviderOperationWithRetry immediately retries stream disconnect errors', async () => {
  let attempts = 0

  const result = await runProviderOperationWithRetry(
    async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('ECONNRESET')
      }
      return 'ok'
    },
    { messages: [] },
  )

  assert.equal(result.value, 'ok')
  assert.equal(result.retryCount, 1)
  assert.equal(attempts, 2)
})

test('readSseStream treats premature close before completion as retryable disconnect', async () => {
  const encoder = new TextEncoder()
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
      controller.close()
    },
  }))
  const payloads = []

  await assert.rejects(
    readSseStream(
      response,
      async payload => {
        payloads.push(payload)
      },
      {
        messages: [],
        requireCompletionSignal: true,
        firstChunkTimeoutMs: 1_000,
        idleTimeoutMs: 1_000,
      },
    ),
    error => {
      assert.equal(error.code, 'PROVIDER_STREAM_DISCONNECTED')
      assert.equal(error.errorInfo?.retryable, true)
      return true
    },
  )

  assert.equal(payloads.length, 1)
})

test('readSseStream accepts caller-confirmed completion without DONE marker', async () => {
  const encoder = new TextEncoder()
  let complete = false
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"done":true}\n\n'))
      controller.close()
    },
  }))

  await readSseStream(
    response,
    async payload => {
      const parsed = JSON.parse(payload)
      complete = parsed.done === true
    },
    {
      messages: [],
      requireCompletionSignal: true,
      isComplete: () => complete,
      firstChunkTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    },
  )

  assert.equal(complete, true)
})

test('runProviderOperationWithRetry escalates partial stream stalls without provider retry', async () => {
  const retryEvents = []
  let attempts = 0
  const stalledError = new Error('模型服务流式输出长时间没有继续。')
  stalledError.code = 'PROVIDER_STREAM_STALLED'
  stalledError.errorInfo = {
    code: 'PROVIDER_STREAM_STALLED',
    retryable: true,
  }

  await assert.rejects(
    runProviderOperationWithRetry(
      async (attemptState) => {
        attempts += 1
        attemptState.receivedOutput = true
        attemptState.partialReasoning = 'partial reasoning before stall'
        throw stalledError
      },
      {
        messages: [],
        hooks: {
          onRetryProgress(retryInfo) {
            retryEvents.push(retryInfo)
          },
        },
      },
    ),
    error => {
      assert.equal(error.code, 'PROVIDER_STREAM_STALLED')
      assert.equal(error.errorInfo?.partialReasoning, 'partial reasoning before stall')
      return true
    },
  )

  assert.equal(attempts, 1)
  assert.equal(retryEvents.length, 0)
})

test('runProviderOperationWithRetry attaches partial streamed tool calls on stall', async () => {
  const stalledError = new Error('模型服务流式输出长时间没有继续。')
  stalledError.code = 'PROVIDER_STREAM_STALLED'
  stalledError.errorInfo = {
    code: 'PROVIDER_STREAM_STALLED',
    retryable: true,
  }

  await assert.rejects(
    runProviderOperationWithRetry(
      async (attemptState) => {
        attemptState.receivedOutput = true
        attemptState.partialToolCalls = summarizePartialToolCalls([
          {
            id: 'call-write',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: '{"path":"prototype.html","content":"<html><body>',
            },
          },
        ])
        throw stalledError
      },
      { messages: [] },
    ),
    error => {
      assert.equal(error.code, 'PROVIDER_STREAM_STALLED')
      assert.equal(error.errorInfo?.partialToolCalls?.[0]?.name, 'write_file')
      assert.equal(error.errorInfo?.partialToolCalls?.[0]?.path, 'prototype.html')
      assert.equal(error.errorInfo?.partialToolCalls?.[0]?.completeJson, false)
      assert.match(error.errorInfo?.partialToolCalls?.[0]?.argumentsPreview || '', /prototype\.html/)
      return true
    },
  )
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

test('maybeSpillToolOutputForTranscript saves large tool output as an artifact reference', () => {
  const context = { cwd: process.cwd() }
  const result = maybeSpillToolOutputForTranscript({
    toolOutput: 'converted markdown paragraph '.repeat(7000),
    settings: { model: 'gpt-test' },
    hooks: {
      workMemoryContext: context,
    },
    toolName: 'convert_doc_to_markdown',
    toolCallId: 'call-1',
    providerKind: 'openai',
    stage: 'step-1',
  })

  assert.match(result, /Large tool output saved/)
  assert.match(result, /Tool: convert_doc_to_markdown/)
  assert.match(result, /Artifact: tool_output-/)
  assert.match(result, /read_artifact_slice/)
  assert.equal(context.artifactStore.artifacts.length, 1)
  assert.equal(context.artifactStore.artifacts[0].type, 'tool_output')
  assert.equal(context.artifactStore.artifacts[0].metadata.toolName, 'convert_doc_to_markdown')
  assert.match(context.artifactStore.artifacts[0].chunks[0].content.text, /converted markdown paragraph/)
  assert.equal(context.checkpointHints.length, 1)
  assert.equal(context.checkpointHints[0].reason, 'large_tool_output_spilled')
  assert.equal(context.checkpointHints[0].artifacts[0].id, context.artifactStore.artifacts[0].id)
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
