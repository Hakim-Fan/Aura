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
