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
{"type":"plan","goal":"解析 docx","risk":"medium","steps":[{"id":"1","description":"读取附件标题"},{"id":"2","description":"生成实体表"}],"successCriteria":["每个子标题都有表"]}
\`\`\``)

  assert.equal(result.type, 'plan')
  assert.equal(result.goal, '解析 docx')
  assert.equal(result.risk, 'medium')
  assert.equal(result.steps.length, 2)
  assert.equal(result.successCriteria[0], '每个子标题都有表')
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
