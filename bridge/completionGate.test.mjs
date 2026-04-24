import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCompletionGate } from './completionGate.mjs'

test('applyCompletionGate blocks completion claims when execution is unverified', () => {
  const result = applyCompletionGate(
    {
      message: '已完成，文档已经写到 docs/refactor.md 里了。',
      completionState: 'executed_unverified',
      evidenceSummary: {
        artifactPaths: ['docs/refactor.md'],
      },
    },
    {
      answerMode: 'execute',
    },
  )

  assert.match(result.message, /还缺少系统级验证证据/)
  assert.doesNotMatch(result.message, /^已完成/)
})

test('applyCompletionGate keeps verified completion messages intact', () => {
  const result = applyCompletionGate(
    {
      message: '已完成，补丁已经落盘并验证通过。',
      completionState: 'executed_verified',
      evidenceSummary: {
        artifactPaths: ['src/app.ts'],
      },
    },
    {
      answerMode: 'execute',
    },
  )

  assert.equal(result.message, '已完成，补丁已经落盘并验证通过。')
})

test('applyCompletionGate does not rewrite non-completion analysis', () => {
  const result = applyCompletionGate(
    {
      message: '我定位到了问题，下一步建议先跑一次针对性测试。',
      completionState: 'executed_unverified',
      evidenceSummary: {},
    },
    {
      answerMode: 'execute',
    },
  )

  assert.equal(result.message, '我定位到了问题，下一步建议先跑一次针对性测试。')
})
