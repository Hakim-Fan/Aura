import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyAgentTask } from './taskClassifier.mjs'

function userMessage(content, extra = {}) {
  return {
    role: 'user',
    content,
    ...extra,
  }
}

test('classifyAgentTask selects fast path for simple no-tool questions', () => {
  const result = classifyAgentTask({
    messages: [userMessage('解释一下什么是 Promise？')],
    settings: { executionMode: 'bounded' },
  })

  assert.equal(result.pathMode, 'fast')
  assert.equal(result.complexity, 'simple')
  assert.equal(result.risk, 'low')
  assert.equal(result.requiresTools, false)
  assert.equal(result.requiresWrite, false)
  assert.ok(result.reasons.includes('simple_no_tool_question'))
})

test('classifyAgentTask keeps workspace and file tasks on standard path', () => {
  const result = classifyAgentTask({
    messages: [userMessage('看一下 README.md 里安装步骤怎么描述的')],
  })

  assert.equal(result.pathMode, 'standard')
  assert.equal(result.requiresTools, true)
  assert.equal(result.workspaceRelated, true)
  assert.ok(result.reasons.includes('workspace_related'))
})

test('classifyAgentTask keeps write and execution tasks out of fast path', () => {
  const result = classifyAgentTask({
    messages: [userMessage('帮我修改 package.json 并运行测试')],
  })

  assert.equal(result.pathMode, 'standard')
  assert.equal(result.requiresWrite, true)
  assert.equal(result.requiresTools, true)
  assert.ok(result.reasons.includes('write_or_execute_intent'))
})

test('classifyAgentTask sends long or architecture tasks to long path', () => {
  const result = classifyAgentTask({
    messages: [userMessage('请做一个架构迁移方案，包含任务拆分、checkpoint、验证逻辑。')],
  })

  assert.equal(result.pathMode, 'long')
  assert.equal(result.complexity, 'complex')
  assert.ok(result.reasons.includes('complexity_keyword'))
})

test('classifyAgentTask keeps current web facts out of fast path', () => {
  const result = classifyAgentTask({
    messages: [userMessage('今天 OpenAI 最新模型是什么？')],
  })

  assert.equal(result.pathMode, 'standard')
  assert.equal(result.needsCurrentInfo, true)
  assert.equal(result.requiresTools, true)
  assert.ok(result.reasons.includes('current_or_web_info_needed'))
})

test('classifyAgentTask treats attachments as standard tool work', () => {
  const result = classifyAgentTask({
    messages: [
      userMessage('总结这个附件', {
        attachments: [{ id: 'attachment-1', name: 'report.pdf' }],
      }),
    ],
  })

  assert.equal(result.pathMode, 'standard')
  assert.equal(result.hasAttachments, true)
  assert.equal(result.requiresTools, true)
  assert.ok(result.reasons.includes('attachments_present'))
})
