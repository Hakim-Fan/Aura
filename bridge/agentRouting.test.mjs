import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inferRouteStateFromClassification,
  inferRouteStateFromKeywords,
} from './agentRouting.mjs'

test('local-first turns keep a small opportunistic web search budget', () => {
  const routeState = inferRouteStateFromClassification(
    {
      answerMode: 'advise',
      needsExternalFacts: false,
      webInteractionRequired: false,
      workspaceRelated: true,
      isCapabilityAdmin: false,
      systemBrowserRequested: false,
      taskComplexity: 'low',
      planDepth: 'single_step',
      confidence: 'high',
    },
    {},
  )

  assert.equal(routeState.capabilityTier, 'local-readonly')
  assert.equal(routeState.budgets.searchesRemaining, 2)
  assert.equal(routeState.webRetrievalAvailable, true)
})

test('keyword fallback no longer infers tool routes from natural-language browser or web terms', () => {
  const routeState = inferRouteStateFromKeywords([
    {
      role: 'user',
      content: '打开浏览器登录官网并查看今天的最新信息',
    },
  ])

  assert.equal(routeState.answerMode, 'advise')
  assert.equal(routeState.needsExternalFacts, false)
  assert.equal(routeState.webInteractionRequired, false)
})

test('attachments with generation action force execute mode', () => {
  const routeState = inferRouteStateFromKeywords([
    {
      role: 'user',
      content: '把这个附件转换成 markdown 并写入工作区',
      attachments: [
        {
          id: 'att-1',
          name: 'input.pdf',
          path: '/tmp/input.pdf',
        },
      ],
    },
  ])

  assert.equal(routeState.answerMode, 'execute')
  assert.equal(routeState.workspaceRelated, true)
  assert.equal(routeState.capabilityTier, 'local-write')
})

test('local document generation request forces execute mode without attachment metadata', () => {
  const routeState = inferRouteStateFromKeywords([
    {
      role: 'user',
      content: '工作目录下有一个word 文档，帮我将文档中每个子标题均生成对应数据实体表',
    },
  ])

  assert.equal(routeState.answerMode, 'execute')
  assert.equal(routeState.workspaceRelated, true)
  assert.equal(routeState.capabilityTier, 'local-write')
})

test('skill implementation questions stay read-only diagnostics', () => {
  const routeState = inferRouteStateFromKeywords([
    {
      role: 'user',
      content: '这个 docx skill 有让你用py 解决吗？我怎么看是node 啊',
    },
  ])

  assert.equal(routeState.answerMode, 'diagnose')
  assert.equal(routeState.workspaceRelated, true)
  assert.notEqual(routeState.capabilityTier, 'local-write')
})
