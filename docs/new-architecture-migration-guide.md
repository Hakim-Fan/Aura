# 新架构补充清单：旧架构核心逻辑迁移指南

> 日期：2026-05-14
> 版本：v1.0
> 目的：记录 `feature_1.2.0` 新架构（`runAgentLoop.mjs`）需要从旧架构（`feature_1.1.3-fix`）补充的逻辑

---

## 背景

`feature_1.2.0` 引入了基于状态机的 `runAgentLoop.mjs` 架构，提升了代码模块化程度。但在测试中发现以下问题：

1. **Domain Cooldown 不跨 LLM 调用持久化** - 工具连续失败时，Domain Failure Memory 状态丢失
2. **缺少 Provider 错误恢复机制** - Provider 完全失败时，没有 fallback 回答
3. **缺少路由升级（Escalation）机制** - 工具连续失败时无法升级到更高级别能力层

---

## 1. Domain Failure Memory 持久化

### 问题描述

旧架构中，`retrievalRuntime.mjs` 使用模块级 `DOMAIN_FAILURE_MEMORY` Map 存储域名失败状态：

```javascript
// retrievalRuntime.mjs (旧架构)
const DOMAIN_FAILURE_MEMORY = new Map()

function maybeShortCircuitFetchCooldown(operation, args, now = Date.now()) {
  const domains = extractDomainsFromArgs(operation, args)
  const activeCooldown = findActiveCooldown(domains, now)
  if (!activeCooldown) return

  throw createStructuredError(
    `网页抓取暂时跳过了 ${activeCooldown.domain}，因为同一站点刚刚连续失败。`,
    { /* ... */ }
  )
}
```

**新架构问题**：每次 `runProviderTurn` 调用都会重新初始化 retrieval context，导致 Domain Failure Memory 状态丢失。

### 迁移方案

**Step 1**: 在 `runAgentLoop.mjs` 中创建跨调用的 failure tracker：

```javascript
// runAgentLoop.mjs
const domainFailureTracker = {
  memory: new Map(),
  maxEntries: 50,

  recordFailure(domain, errorInfo, now = Date.now()) {
    const previous = this.memory.get(domain)
    this.memory.set(domain, {
      consecutiveFailures: (previous?.consecutiveFailures || 0) + 1,
      cooldownUntil: now + this.resolveCooldownMs(errorInfo),
      lastFailureAt: now,
      lastCategory: errorInfo?.category || 'execution_failed',
      lastCode: errorInfo?.code,
    })
    this.cleanup(now)
  },

  resolveCooldownMs(errorInfo = {}) {
    if (errorInfo?.code === 'WEB_FETCH_PAGE_REQUIRES_BROWSER') return 3 * 60_000
    const COOLDOWN_BY_CATEGORY = {
      network: 45_000,
      rate_limit: 60_000,
      unavailable: 120_000,
    }
    return COOLDOWN_BY_CATEGORY[errorInfo?.category] || 45_000
  },

  getActiveCooldown(domain, now = Date.now()) {
    const entry = this.memory.get(domain)
    if (!entry) return null
    const remaining = entry.cooldownUntil - now
    return remaining > 0 && entry.consecutiveFailures >= 2
      ? { domain, ...entry, cooldownRemainingMs: remaining }
      : null
  },

  cleanup(now = Date.now()) {
    for (const [domain, entry] of this.memory) {
      if (entry.cooldownUntil < now - 10 * 60_000) {
        this.memory.delete(domain)
      }
    }
  },

  clear(domain) {
    this.memory.delete(domain)
  }
}
```

**Step 2**: 在 `executeReasoning` 中传递 tracker：

```javascript
async function executeReasoning(context) {
  const { settings, hooks, buildPrompt, workingMemory } = context

  // 初始化 retrieval context 时传入共享的 failure tracker
  const retrievalContext = {
    domainFailureTracker,  // 共享状态
  }

  const turnResult = await runProviderTurn({
    settings,
    systemPrompt: prompt,
    messages,
    tools: builtinTools,
    toolEvents,
    routeState: {},
    hooks: {
      ...hooks,
      retrievalContext,  // 传递给工具执行层
    },
    taskTracker: hooks?.taskTracker,
    currentTaskId: hooks?.currentTaskId,
  })
  // ...
}
```

**Step 3**: 在 `retrievalRuntime.mjs` 或 `invokeTool` 层使用共享的 tracker：

```javascript
// tools.mjs - invokeToolWithRetry 或 retrievalRuntime.mjs
function maybeCheckDomainCooldown(args, domainFailureTracker) {
  const domain = extractHostname(args.url)
  const activeCooldown = domainFailureTracker?.getActiveCooldown(domain)
  if (activeCooldown) {
    throw createStructuredError(
      `网页抓取暂时跳过了 ${domain}，因为同一站点刚刚连续失败。`,
      {
        source: 'tool',
        category: 'network',
        code: 'RETRIEVAL_DOMAIN_COOLDOWN',
        detail: `Domain: ${domain}\nConsecutive failures: ${activeCooldown.consecutiveFailures}\nCooldown remaining: ${activeCooldown.cooldownRemainingMs}ms`,
        suggestedAction: '请先换一个来源、改用 web_search / web_research，或等待冷却结束后再抓取同一站点。',
        retryable: true,
      }
    )
  }
}
```

---

## 2. Provider 错误恢复机制

### 问题描述

旧架构在 `runRouteFirstAgent` 的 catch 块中有完整的错误恢复逻辑：

```javascript
// agent.mjs (旧架构) - catch 块
} catch (error) {
  const normalized = normalizeAgentError(error)

  if (normalized.source === 'provider' && hasRecoveryContext) {
    // 1. 尝试用已有 toolEvents 构建 recovery 回答
    const recovered = await finalizeGoogleAnswer({
      settings: buildEffectiveRunSettings(settings, routeState),
      systemPrompt: lastSystemPrompt,
      messages,
      toolEvents,
      reasoningText: partialReasoning,
      draftMessage: partialMessage,
      stage: 'recovery',
      hooks,
    })

    if (recovered.message.trim()) {
      return { ...recovered, recovered: true, status: 'completed' }
    }
  }

  // 2. Recovery 失败，构建 fallback 回答
  const fallbackMessage = buildPartialRecoveryMessage(
    toolEvents,
    normalized,
    partialMessage,
  )
  return {
    ...fallbackResult,
    status: 'completed',
  }
}
```

**新架构问题**：`runAgentLoop.mjs` 的 catch 块直接 `terminateLoop`，没有 recovery 尝试。

### 迁移方案

**Step 1**: 在 `runAgentLoop.mjs` 中添加 recovery 逻辑：

```javascript
// runAgentLoop.mjs

async function tryProviderRecovery(params) {
  const { error, toolEvents, messages, settings, hooks } = params

  const partialMessage = extractPartialProviderMessage(error)
  const partialReasoning = extractPartialProviderReasoning(error)

  if (!partialMessage && toolEvents.length === 0) {
    return null  // 没有可恢复的上下文
  }

  try {
    const recovered = settings.provider === 'google'
      ? await finalizeGoogleAnswer({
          settings,
          systemPrompt: buildPrompt(),  // 或传入上一次的 systemPrompt
          messages,
          toolEvents,
          reasoningText: partialReasoning,
          draftMessage: partialMessage,
          stage: 'recovery',
          hooks,
        })
      : await finalizeOpenAiCompatibleAnswer({
          settings,
          systemPrompt: buildPrompt(),
          messages,
          toolEvents,
          reasoningText: partialReasoning,
          draftMessage: partialMessage,
          stage: 'recovery',
          hooks,
        })

    if (recovered?.message?.trim()) {
      return {
        recovered: true,
        message: recovered.message,
        reasoning: [...(recovered.reasoning || []), ...partialReasoning],
      }
    }
  } catch (recoveryError) {
    // Recovery 是 best-effort，失败后继续 fallback
  }

  return null
}

function buildFallbackMessage(toolEvents, error, partialMessage = '') {
  const successfulEvents = toolEvents.filter(e => e.status === 'success').slice(-3)
  const completedSteps = successfulEvents
    .map((e, i) => `${i + 1}. ${e.name}: ${summarizeToolOutput(e.output) || e.summary}`)
    .join('\n')

  const recentFailures = toolEvents.filter(e => e.status === 'error').slice(-2)
  const failureSummary = recentFailures
    .map((e, i) => `${i + 1}. ${e.name}: ${e.errorInfo?.summary || e.name}`)
    .join('\n')

  return [
    '执行在模型生成最终回答时中断了，但我先把已经保留下来的内容和已完成进展整理给你。',
    partialMessage ? `模型中断前已经写出的内容：\n${partialMessage.slice(0, 6000)}` : null,
    completedSteps || '本轮已经执行过工具步骤，但还没来得及整理成完整结论。',
    failureSummary ? `中断前最近看到的问题：\n${failureSummary}` : null,
    error?.errorInfo?.suggestedAction
      ? `建议：${error.errorInfo.suggestedAction}`
      : '如果你愿意，我可以基于这些已完成步骤继续重试，而不用从头再来。',
  ].filter(Boolean).join('\n\n')
}
```

**Step 2**: 在 catch 块中使用 recovery：

```javascript
// runAgentLoop.mjs - catch 块
} catch (error) {
  lastError = error

  if (isExecutingState(state)) {
    const isRetryableError = error?.retryable !== false &&
      (error?.source === 'provider' || !error?.code)

    if (isRetryableError && retryCount < MAX_RETRY_COUNT) {
      retryCount++
      hooks?.onPhaseChange?.('retrying')
      hooks?.onError?.({ error, retryCount, maxRetries: MAX_RETRY_COUNT })
      continue
    }

    // 超过重试次数，尝试 Provider Recovery
    const recovery = await tryProviderRecovery({
      error,
      toolEvents,
      messages,
      settings,
      hooks,
    })

    if (recovery) {
      state = AgentLoopState.COMPLETED
      return terminateLoop(
        LoopTerminationReason.TASK_GOAL_ACHIEVED,
        toolEvents,
        workingMemory,
        { type: 'text', content: recovery.message, reasoning: recovery.reasoning }
      )
    }

    // Recovery 失败，构建 fallback
    const fallbackMessage = buildFallbackMessage(toolEvents, error)
    state = AgentLoopState.COMPLETED
    return terminateLoop(
      LoopTerminationReason.PROVIDER_ERROR,
      toolEvents,
      workingMemory,
      { type: 'text', content: fallbackMessage },
      error
    )
  }
  throw error
}
```

---

## 3. 路由升级（Escalation）机制

### 问题描述

旧架构有完整的路由升级机制：

```javascript
// agent.mjs (旧架构)
const routeEscalationCount = 0
const visitedTiers = new Set([routeState.capabilityTier])

for (let pass = 0; pass < MAX_ROUTE_RUNTIME_PASSES; pass++) {
  // ... 执行推理

  // 检测是否需要升级
  const inferredEscalation = inferRouteEscalationFromMessage(
    result.message,
    availableEscalations,
  )

  if (inferredEscalation && !routeStopReason) {
    const nextRouteState = escalateRouteState(routeState, inferredEscalation)
    routeNotes.push(buildRouteEscalationNote({...}))
    routeEscalationCount += 1
    routeState = nextRouteState
    visitedTiers.add(routeState.capabilityTier)
    continue  // 使用更高能力层重试
  }
}

// getRouteEscalationTargets 逻辑
export function getRouteEscalationTargets(routeState, options = {}) {
  return routeState.allowEscalationTo.filter(targetTier => {
    if (visitedTiers?.has(targetTier)) return false
    if (targetTier === 'local-write' && budgets.writeEscalationsRemaining <= 0) return false
    if (targetTier === 'browser-interactive' && budgets.browserEscalationsRemaining <= 0) return false
    return true
  })
}
```

**新架构问题**：`runAgentLoop.mjs` 没有 `routeState`、`escalation` 相关逻辑，工具连续失败时无法升级能力层。

### 迁移方案

**Step 1**: 定义能力层级和升级预算：

```javascript
// runAgentLoop.mjs

const CapabilityTier = {
  READ_ONLY: 'read-only',           // 基础只读
  LOCAL_WRITE: 'local-write',       // 本地写文件
  WEB_LOOKUP: 'web-lookup',         // 网络搜索
  BROWSER_INTERACTIVE: 'browser-interactive',  // 浏览器交互
}

const createEscalationBudget = () => ({
  writeEscalationsRemaining: 1,
  browserEscalationsRemaining: 1,
  searchBudget: 5,
})

// 能力层级定义
const TIER_CAPABILITIES = {
  'read-only': {
    canReadFiles: true,
    canSearchCode: true,
    canWebSearch: false,
    canWriteFiles: false,
    canBrowserUse: false,
  },
  'local-write': {
    canReadFiles: true,
    canSearchCode: true,
    canWebSearch: false,
    canWriteFiles: true,
    canBrowserUse: false,
  },
  'web-lookup': {
    canReadFiles: true,
    canSearchCode: true,
    canWebSearch: true,
    canWriteFiles: false,
    canBrowserUse: false,
  },
  'browser-interactive': {
    canReadFiles: true,
    canSearchCode: true,
    canWebSearch: true,
    canWriteFiles: true,
    canBrowserUse: true,
  },
}
```

**Step 2**: 在 `runAgentLoop` 中初始化 routeState：

```javascript
export async function runRouteFirstAgentLoop({ request }) {
  const {
    settings,
    messages,
    hooks = {},
    toolEvents: externalToolEvents = [],
  } = request

  // 初始化路由状态
  let routeState = {
    capabilityTier: CapabilityTier.READ_ONLY,
    budgets: createEscalationBudget(),
    allowEscalationTo: [CapabilityTier.LOCAL_WRITE, CapabilityTier.WEB_LOOKUP],
    visitedTiers: new Set([CapabilityTier.READ_ONLY]),
  }

  // ...
}
```

**Step 3**: 添加工具失败检测和 escalation 触发：

```javascript
// runAgentLoop.mjs

function detectToolEscalationNeed(toolEvents, routeState) {
  const recentErrors = toolEvents
    .filter(e => e.status === 'error' && Date.now() - e.timestamp < 60000)

  if (recentErrors.length < 3) return null

  // 分析失败模式
  const errorCategories = recentErrors.map(e => e.errorInfo?.category)

  // 如果都是网络相关错误，尝试升级到 web-lookup
  if (errorCategories.every(c => c === 'network')) {
    return CapabilityTier.WEB_LOOKUP
  }

  // 如果有文件写入相关错误
  if (recentErrors.some(e => e.name.includes('write') || e.name.includes('edit'))) {
    return CapabilityTier.LOCAL_WRITE
  }

  return null
}

function escalateRouteState(routeState, targetTier) {
  const nextState = {
    ...routeState,
    capabilityTier: targetTier,
    visitedTiers: new Set([...routeState.visitedTiers, targetTier]),
  }

  if (targetTier === CapabilityTier.LOCAL_WRITE) {
    nextState.budgets = {
      ...routeState.budgets,
      writeEscalationsRemaining: Math.max(0, routeState.budgets.writeEscalationsRemaining - 1),
    }
  }

  if (targetTier === CapabilityTier.BROWSER_INTERACTIVE) {
    nextState.budgets = {
      ...routeState.budgets,
      browserEscalationsRemaining: Math.max(0, routeState.budgets.browserEscalationsRemaining - 1),
    }
  }

  return nextState
}
```

**Step 4**: 在循环中检测并触发 escalation：

```javascript
// runAgentLoop.mjs - 主循环中

// 在 executeState 之后检查是否需要 escalation
const escalationTarget = detectToolEscalationNeed(toolEvents, routeState)

if (escalationTarget && routeState.budgets[getBudgetKey(escalationTarget)] > 0) {
  routeState = escalateRouteState(routeState, escalationTarget)
  hooks?.onPhaseChange?.('preparing')
  continue  // 使用更高能力层重试
}
```

---

## 4. 其他值得补充的逻辑

### 4.1 Checkpoint Manager 跨调用持久化

旧架构有 checkpoint 机制，新架构虽然引入了 `workingMemory`，但没有 checkpoint：

```javascript
// 建议添加
const checkpointManager = {
  snapshots: [],
  maxSnapshots: 10,

  createSnapshot(data) {
    const snapshot = {
      id: `cp-${Date.now()}`,
      timestamp: Date.now(),
      data,
    }
    this.snapshots.push(snapshot)
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift()
    }
    return snapshot
  },

  getLatestSnapshot() {
    return this.snapshots[this.snapshots.length - 1]
  },
}
```

### 4.2 证据策略（Evidence Policy）

旧架构在返回前会执行 `enforceEvidencePolicy` 和 `applyCompletionGate`：

```javascript
// 建议添加
function applyEvidencePolicy(result, toolEvents, routeState) {
  // 检查是否有未验证的写入操作
  const unverifiedWrites = findUnverifiedWriteEvents(toolEvents)
  if (unverifiedWrites.length > 0) {
    result.evidenceWarning = `注意：有 ${unverifiedWrites.length} 个写入操作尚未验证。`
  }
  return result
}

function applyCompletionGate(result, routeState) {
  // 根据 completionState 添加标记
  if (routeState?.completionPolicy?.requiresEvidenceForDone) {
    result.needsVerification = true
  }
  return result
}
```

---

## 5. 迁移优先级

| 优先级 | 功能 | 原因 | 工作量 |
|--------|------|------|--------|
| P0 | Domain Failure Memory 持久化 | **线上问题**：工具重复失败无法感知 cooldown | 中 |
| P0 | Provider 错误恢复机制 | **线上问题**：Provider 彻底失败时没有 fallback | 中 |
| P1 | 路由升级（Escalation）机制 | 提升长任务成功率 | 高 |
| P2 | Checkpoint Manager | 提升压缩后恢复可靠性 | 中 |
| P2 | 证据策略 | 提升完成判断准确性 | 低 |

---

## 6. 测试建议

```javascript
// tests/unit/runAgentLoop.mjs.test.mjs

describe('Domain Failure Memory', () => {
  it('should persist cooldown across LLM calls', async () => {
    const tracker = createDomainFailureTracker()

    // 第一次调用：记录失败
    tracker.recordFailure('github.com', { category: 'network' })
    expect(tracker.getActiveCooldown('github.com')).not.toBeNull()

    // 模拟新 LLM 调用（tracker 应该保持状态）
    const cooldown = tracker.getActiveCooldown('github.com')
    expect(cooldown.consecutiveFailures).toBe(1)
  })

  it('should clear cooldown after timeout', async () => {
    const tracker = createDomainFailureTracker()
    tracker.recordFailure('github.com', { category: 'network' })

    // 模拟时间流逝
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60000)

    expect(tracker.getActiveCooldown('github.com')).toBeNull()
  })
})

describe('Provider Recovery', () => {
  it('should return fallback message when recovery fails', async () => {
    const result = await runAgentLoopWithRecovery({
      settings: { provider: 'openai' },
      messages: [{ role: 'user', content: 'test' }],
      hooks: {},
    })

    expect(result.status).toBe('completed')
    expect(result.message).toContain('已完成')
  })
})
```

---

## 7. 参考文件

- `bridge/agent.mjs` (旧架构 - 需从 `feature_1.1.3-fix` 分支获取)
- `bridge/retrievalRuntime.mjs` (旧架构 - Domain Failure Memory)
- `bridge/agentRouting.mjs` (旧架构 - Escalation 逻辑)
- `bridge/agent/runAgentLoop.mjs` (新架构)
