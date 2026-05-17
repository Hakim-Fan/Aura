import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModelPlanningUserPrompt,
  buildModelPlanningSystemPrompt,
  parseModelPlanningResult,
} from './modelPlanningRuntime.mjs'

test('model planning parser accepts direct answers', () => {
  const result = parseModelPlanningResult(JSON.stringify({
    type: 'direct_answer',
    answer: '你好，我是 Aura。',
  }))

  assert.equal(result.type, 'direct_answer')
  assert.equal(result.answer, '你好，我是 Aura。')
})

test('model planning parser accepts executable plans', () => {
  const result = parseModelPlanningResult(`\`\`\`json
{"type":"plan","goal":"解析 docx","risk":"medium","steps":[{"id":"1","description":"读取附件标题","kind":"context","acceptance":"已经理解 docx 解析方法","requiredEvidence":["skill_read"]},{"id":"2","description":"生成实体表","kind":"execute","acceptance":"输出实体表定义","requiredEvidence":["file_parsed","structured_output"]}],"successCriteria":["每个子标题都有表"]}
\`\`\``)

  assert.equal(result.type, 'plan')
  assert.equal(result.goal, '解析 docx')
  assert.equal(result.risk, 'medium')
  assert.equal(result.steps.length, 2)
  assert.equal(result.steps[0].kind, 'context')
  assert.equal(result.steps[0].acceptance, '已经理解 docx 解析方法')
  assert.deepEqual(result.steps[1].requiredEvidence, ['file_parsed', 'structured_output'])
  assert.equal(result.successCriteria[0], '每个子标题都有表')
})

test('model planning parser accepts planning router output', () => {
  const result = parseModelPlanningResult(JSON.stringify({
    taskRelation: {
      type: 'continue_current',
      targetTaskId: 'task-123',
      confidence: 0.91,
      reason: '用户要求继续刚才的文档任务',
    },
    executionMode: 'plan_then_execute',
    contextRequest: {
      includeRecentMessages: true,
      includeCurrentTaskSummary: true,
      includeWorkMemory: true,
      includeArtifacts: true,
      includeFileSummaries: true,
      needsFreshFileRead: false,
      reason: '已有读取摘要可复用',
    },
    response: {
      type: 'plan',
      goal: '继续生成 Markdown 文档',
      risk: 'medium',
      steps: [
        { id: '1', description: '恢复上次任务结果' },
        { id: '2', description: '写入 Markdown 文件' },
      ],
    },
  }))

  assert.equal(result.type, 'plan')
  assert.equal(result.goal, '继续生成 Markdown 文档')
  assert.equal(result.taskRelation.type, 'continue_current')
  assert.equal(result.taskRelation.targetTaskId, 'task-123')
  assert.equal(result.contextRequest.includeWorkMemory, true)
  assert.equal(result.contextRequest.needsFreshFileRead, false)
})

test('model planning user prompt includes attachment summaries', () => {
  const prompt = buildModelPlanningUserPrompt({
    settings: {
      locale: 'zh-CN',
    },
    messages: [
      {
        role: 'user',
        content: '分析这个文档',
        attachments: [
          {
            name: '建设内容.docx',
            type: 'file',
            path: '/tmp/建设内容.docx',
          },
        ],
      },
    ],
  })
  const parsed = JSON.parse(prompt)

  assert.equal(parsed.latestUserRequest, '分析这个文档')
  assert.equal(parsed.hasAttachments, true)
  assert.equal(parsed.attachments[0].name, '建设内容.docx')
  assert.equal(parsed.locale, 'zh-CN')
})

test('model planning user prompt includes carryover memory and task ids', () => {
  const prompt = buildModelPlanningUserPrompt({
    settings: {
      locale: 'zh-CN',
    },
    logContext: {
      sessionId: 'session-1',
      taskId: 'task-1',
    },
    carryoverContext:
      'Prior work memory: 已读取 requirements.docx，文件未变化，摘要可复用。',
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '上次读取了文档但还没有生成 markdown。',
        completionState: 'not_executed',
        steps: [
          {
            id: 'step-1',
            title: '读取文档',
            status: 'completed',
          },
        ],
      },
      {
        id: 'latest-user',
        role: 'user',
        content: '继续输出 markdown',
      },
    ],
  })
  const parsed = JSON.parse(prompt)

  assert.equal(parsed.latestUserRequest, '继续输出 markdown')
  assert.equal(parsed.logContext.sessionId, 'session-1')
  assert.match(parsed.priorWorkMemoryAndCarryover, /requirements\.docx/)
  assert.equal(parsed.recentAssistantExecutions[0].completionState, 'not_executed')
  assert.equal(parsed.recentAssistantExecutions[0].steps[0].status, 'completed')
})

test('model planning user prompt carries recent file parts as attachment context', () => {
  const prompt = buildModelPlanningUserPrompt({
    settings: {
      locale: 'zh-CN',
    },
    messages: [
      {
        id: 'older-user',
        role: 'user',
        content: '附件有一个 docx 文档，请分析它。',
        parts: [
          {
            type: 'text',
            text: '附件有一个 docx 文档，请分析它。\n\n当前工作区还附加了以下可读取文件：\n- /workspace/attachments/建设内容.docx',
          },
          {
            type: 'file',
            name: '建设内容.docx',
            path: '/workspace/attachments/建设内容.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        ],
      },
      {
        id: 'latest-user',
        role: 'user',
        content: '继续完成上面任务',
      },
    ],
  })
  const parsed = JSON.parse(prompt)

  assert.equal(parsed.latestUserRequest, '继续完成上面任务')
  assert.equal(parsed.hasAttachments, true)
  assert.equal(parsed.attachments[0].name, '建设内容.docx')
  assert.match(parsed.recentUserRequests[0].content, /docx/)
})

test('model planning system prompt carries the configured locale policy', () => {
  const prompt = buildModelPlanningSystemPrompt({
    locale: 'zh-CN',
  })

  assert.match(prompt, /Primary response locale: 简体中文 \(zh-CN\)/)
  assert.match(prompt, /Language policy: all user-facing answers/i)
})
