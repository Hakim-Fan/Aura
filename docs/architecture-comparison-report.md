# 新旧架构对比分析报告

> 日期：2026-05-14
> 版本：v1.0
> 分支：`feature_1.1.3-fix` (旧) vs `feature_1.2.0` (新)

---

## 一、架构设计对比

### 1. 执行模式

| 维度 | 旧架构 (`runRouteFirstAgent`) | 新架构 (`runAgentLoop`) |
|------|-------------------------------|-------------------------|
| **控制流** | `for` 循环 + `if` 判断 | 状态机 (`AgentLoopState`) |
| **模块化** | 单文件 2202 行 | 按职责拆分 7 个模块 |
| **终止条件** | `shouldRunFinalization` + `determineRouteStopReason` 分散判断 | 统一 `verifyTaskCompletion` |
| **入口点** | `runRouteFirstAgent` | `runRouteFirstAgentLoop` |

**评估**：新架构状态机模式更清晰，但旧架构的"分散判断"在某些场景下更灵活。

---

### 2. 循环控制

#### 旧架构
```javascript
// agent.mjs
for (let pass = 0; pass < MAX_ROUTE_RUNTIME_PASSES; pass++) {
  // 1. 压缩检查
  // 2. LLM 调用
  // 3. 工具执行
  // 4. 终止条件判断 (shouldRunFinalization + determineRouteStopReason)
  // 5. 可选：路由升级
  if (shouldRunFinalization(...)) break
  if (routeStopReason) break
  if (escalation) continue  // 升级后继续
}
```

#### 新架构
```javascript
// runAgentLoop.mjs
while (true) {
  state = AgentLoopState.REASONING
  const result = await executeState(state)

  if (result.type === 'tool_call') state = ACTION
  else if (result.type === 'text') {
    const completion = verifyTaskCompletion(...)
    if (completion.isComplete) state = FINALIZING
    else state = REASONING  // 继续
  }

  if (isTerminalState(state)) return terminateLoop(...)
  passCount++
}
```

**评估**：
- 新架构更易理解，状态转换清晰
- 旧架构的"终止条件"更细致（区分 `shouldRunFinalization` 和 `determineRouteStopReason`）

---

## 二、核心机制对比

### 1. Domain Failure Memory（域名失败记忆）

#### 旧架构实现
```javascript
// retrievalRuntime.mjs - 模块级变量，跨调用持久化
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

**关键特性**：
- 模块级 `Map`，生命周期与进程相同
- 记录 `consecutiveFailures`、`cooldownUntil`、`lastFailureAt`
- 冷却时间根据错误类别动态调整

#### 新架构问题
每次 `runProviderTurn` 调用时，retrieval context 重新初始化，**Domain Failure Memory 状态丢失**。

#### 建议迁移
```javascript
// 在 runAgentLoop.mjs 中创建跨调用 tracker
const domainFailureTracker = {
  memory: new Map(),
  recordFailure(domain, errorInfo) { /* ... */ },
  getActiveCooldown(domain) { /* ... */ },
}
```

---

### 2. Provider 错误恢复

#### 旧架构实现
```javascript
// agent.mjs - catch 块中的三层恢复

} catch (error) {
  const normalized = normalizeAgentError(error)

  // Layer 1: 尝试用已有 toolEvents 恢复回答
  if (normalized.source === 'provider' && hasRecoveryContext) {
    const recovered = await finalizeGoogleAnswer({ stage: 'recovery', ... })
    if (recovered.message.trim()) {
      return { ...recovered, recovered: true }
    }
  }

  // Layer 2: Recovery 失败，构建 fallback
  const fallbackMessage = buildPartialRecoveryMessage(toolEvents, normalized, ...)
  return { ...fallbackResult }
}
```

#### 新架构问题
```javascript
// runAgentLoop.mjs - 缺少恢复层
} catch (error) {
  if (isRetryableError && retryCount < MAX_RETRY_COUNT) {
    retryCount++
    continue
  }
  // 直接 terminateLoop，没有 recovery
  return terminateLoop(LoopTerminationReason.PROVIDER_ERROR, ...)
}
```

#### 建议迁移
添加 `tryProviderRecovery()` 和 `buildFallbackMessage()` 逻辑。

---

### 3. 路由升级（Escalation）

#### 旧架构实现
```javascript
// agent.mjs

// 维护已访问的 tier
const visitedTiers = new Set([routeState.capabilityTier])

// 检测升级需求
const inferredEscalation = inferRouteEscalationFromMessage(result.message, availableEscalations)
if (inferredEscalation && !routeStopReason) {
  const nextRouteState = escalateRouteState(routeState, inferredEscalation)
  routeEscalationCount += 1
  routeState = nextRouteState
  visitedTiers.add(routeState.capabilityTier)
  continue  // 使用更高能力层重试
}

// 升级预算控制
export function getRouteEscalationTargets(routeState, options = {}) {
  return routeState.allowEscalationTo.filter(targetTier => {
    if (visitedTiers?.has(targetTier)) return false
    if (targetTier === 'local-write' && budgets.writeEscalationsRemaining <= 0) return false
    return true
  })
}
```

#### 新架构问题
- 没有 `routeState`、`capabilityTier` 概念
- 没有 escalation 预算控制
- 工具连续失败时无法升级能力层

#### 建议迁移
```javascript
const CapabilityTier = {
  READ_ONLY: 'read-only',
  LOCAL_WRITE: 'local-write',
  WEB_LOOKUP: 'web-lookup',
  BROWSER_INTERACTIVE: 'browser-interactive',
}

function detectToolEscalationNeed(toolEvents) {
  const recentErrors = toolEvents.filter(e => e.status === 'error')
  if (recentErrors.length >= 3) {
    // 根据错误类型决定升级目标
  }
}
```

---

### 4. 证据策略（Evidence Policy）

#### 旧架构实现
```javascript
// agent.mjs

// 在返回前执行证据检查
result = enforceEvidencePolicy(result, toolEvents, promptRouteState, runtimeBlocks)
result = applyCompletionGate(result, routeState)

// enforceEvidencePolicy: 检查未验证的写入
// applyCompletionGate: 根据 completionPolicy 添加标记
```

#### 新架构实现
```javascript
// taskCompletion.mjs

export function verifyTaskCompletion(llmResponse, context) {
  const issues = []

  // 1. 检查未验证写入
  const unverifiedWrites = findUnverifiedWriteEvents(toolEvents)
  if (unverifiedWrites.length > 0) {
    issues.push({ type: 'unverified_write', ... })
  }

  // 2. 检查孤儿工具
  const orphanedTools = findOrphanedToolEvents(toolEvents, messages)

  // 3. 评估答案质量
  const answerQuality = assessAnswerQuality(text)
}
```

**评估**：
- 新架构的 `verifyTaskCompletion` 更结构化
- 旧架构的 `enforceEvidencePolicy` 更注重"证据完整性"

---

### 5. Checkpoint Manager

#### 旧架构实现
```javascript
// agent.mjs

const checkpointManager = createCheckpointManager({
  hooks: {
    onCheckpointCreated: (checkpoint) => hooks?.onProgress?.({ type: 'checkpoint', checkpoint }),
    onCheckpointCommitted: (checkpoint) => hooks?.onProgress?.({ type: 'checkpoint_committed', checkpoint }),
  },
})

// 每个 pass 创建 checkpoint
const checkpoint = checkpointManager.createCheckpoint(currentTaskId, `pass-${pass}`, snapshot, {
  pass,
  routeState: { capabilityTier: routeState.capabilityTier },
})
checkpointId = checkpoint.id
```

#### 新架构问题
`runAgentLoop.mjs` 有 `workingMemory`，但没有 checkpoint 机制。

#### 建议
添加轻量级 checkpoint：
```javascript
const checkpointManager = {
  snapshots: [],
  createSnapshot(data) { /* ... */ },
  getLatestSnapshot() { /* ... */ },
}
```

---

## 三、错误处理对比

### 1. 重试机制

| 层级 | 旧架构 | 新架构 |
|------|--------|--------|
| **Provider 层** | `runProviderOperationWithRetry` (5次: 0,1,3,8,20s) | 相同逻辑 |
| **AgentLoop 层** | 无（Provider 失败直接 throw） | `retryCount < MAX_RETRY_COUNT` 时 `continue` |
| **工具层** | `invokeToolWithRetry` | 相同逻辑 |

**问题**：新架构在工具层失败后，缺少跨 LLM 调用的失败感知。

### 2. 错误分类

```javascript
// providers.mjs - 错误分类
function classifyProviderHttpCategory(status) {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 429) return 'rate_limit'
  if (status >= 500 && status <= 599) return 'unavailable'
  return 'execution_failed'
}
```

两者一致，无需迁移。

---

## 四、记忆层对比

### 1. Working Memory

| 维度 | 旧架构 | 新架构 |
|------|--------|--------|
| **存储位置** | `context.workMemories` | `workingMemory` (独立 manager) |
| **压缩策略** | 无专门设计 | "永不压缩 tool_result" |
| **Prune 策略** | 无 | 优先删除非 tool_result 类型 |

**评估**：新架构的 Working Memory 设计更优，明确了"永不压缩"的语义。

### 2. Context Compression

| 维度 | 旧架构 | 新架构 |
|------|--------|--------|
| **压缩时机** | `maybeCompressMessagesForContext` | `contextCompressor.mjs` |
| **恢复机制** | 无专门设计 | `compressionRecovery.mjs` |
| **连续性** | 依赖自然语言摘要 | 保留 checkpoint 和 pending task |

**评估**：
- 新架构的压缩恢复机制更完善
- 旧架构依赖 LLM 自然语言摘要，可能丢失关键信息

---

## 五、模块依赖对比

### 旧架构依赖图
```
agent.mjs (主入口, 2202行)
├── agentRouting.mjs (路由逻辑)
├── agentPrompting.mjs (Prompt 构建)
├── agentEvidence.mjs (证据策略)
├── completionGate.mjs (完成门)
├── contextCompression.mjs (压缩)
├── checkpoint.mjs (检查点)
├── runtimeErrors.mjs (错误处理)
├── tools.mjs (工具调用)
│   └── retrievalRuntime.mjs (检索运行时)
└── providers.mjs (模型调用)
    └── runGoogleAgent / runOpenAiCompatibleAgent
```

### 新架构依赖图
```
agent.mjs (主入口, 精简后约 1500 行)
└── agent/runAgentLoop.mjs (状态机入口)
    ├── agent.mjs (runProviderTurn)
    ├── memory/
    │   ├── taskCompletion.mjs (任务完成验证)
    │   ├── workingMemory.mjs (工作记忆)
    │   ├── promptBuilder.mjs (Prompt 构建)
    │   ├── contextCompressor.mjs (压缩)
    │   └── compressionRecovery.mjs (恢复)
    ├── events/stateEmitter.mjs (事件推送)
    └── tools.mjs / providers.mjs
```

---

## 六、值得迁移的旧架构设计

### P0 - 必须迁移（线上问题）

| # | 设计 | 原因 | 迁移位置 |
|---|------|------|----------|
| 1 | Domain Failure Memory 持久化 | web_fetch 重复失败 | `runAgentLoop.mjs` |
| 2 | Provider 错误恢复机制 | Provider 失败无 fallback | `runAgentLoop.mjs` |

### P1 - 应该迁移（功能完善）

| # | 设计 | 原因 | 迁移位置 |
|---|------|------|----------|
| 3 | 路由升级（Escalation）机制 | 提升长任务成功率 | `runAgentLoop.mjs` |
| 4 | 升级预算控制 | 防止无限升级 | `runAgentLoop.mjs` |

### P2 - 可以迁移（增强体验）

| # | 设计 | 原因 | 迁移位置 |
|---|------|------|----------|
| 5 | Checkpoint Manager | 提升压缩恢复可靠性 | `runAgentLoop.mjs` |
| 6 | `buildPartialRecoveryMessage` | 提供更好的错误提示 | `runAgentLoop.mjs` |

---

## 七、新架构独有优势

以下特性是旧架构没有的，新架构应保留：

| # | 特性 | 说明 |
|---|------|------|
| 1 | **状态机架构** | 更清晰的执行流程 |
| 2 | **分层 Prompt 构建** | `promptBuilder.mjs` 分层设计 |
| 3 | **压缩恢复机制** | `compressionRecovery.mjs` |
| 4 | **结构化任务验证** | `verifyTaskCompletion` |
| 5 | **实时事件推送** | `stateEmitter.mjs` |

---

## 八、迁移优先级总结

```
┌─────────────────────────────────────────────────────────────┐
│                      迁移优先级图谱                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  P0 (立即)          P1 (本周)           P2 (下周)           │
│  ┌─────────┐        ┌─────────┐        ┌─────────┐        │
│  │Domain   │        │Escalation│        │Checkpoint│        │
│  │Failure  │        │ Mechanism │        │ Manager  │        │
│  │Memory   │        └─────────┘        └─────────┘        │
│  │Persist  │                                                     │
│  ├─────────┤                                                  │
│  │Provider │                                                  │
│  │Recovery │                                                  │
│  └─────────┘                                                  │
│                                                             │
│  问题严重性: 高 → 低                                         │
│  迁移复杂度: 中 → 中/高 → 低                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 九、测试建议

### 必测场景

1. **Domain Failure Memory 持久化**
   - 第一次 LLM 调用失败后，第二次调用同一 domain 应该立即触发 cooldown

2. **Provider 错误恢复**
   - 模拟 Provider 完全失败，验证 fallback message 是否正确生成

3. **路由升级**
   - 连续 3 次工具失败后，应该触发 escalation

### 测试用例示例

```javascript
describe('Domain Failure Memory', () => {
  it('cooldown persists across LLM calls', async () => {
    // Arrange
    const tracker = createDomainFailureTracker()
    tracker.recordFailure('github.com', { category: 'network' })

    // Act - 模拟新 LLM 调用
    const cooldown = tracker.getActiveCooldown('github.com')

    // Assert
    expect(cooldown).not.toBeNull()
    expect(cooldown.consecutiveFailures).toBe(1)
  })
})

describe('Escalation', () => {
  it('escalates after 3 consecutive tool failures', async () => {
    // Arrange
    const toolEvents = [
      { status: 'error', name: 'web_fetch', timestamp: Date.now() - 5000 },
      { status: 'error', name: 'web_fetch', timestamp: Date.now() - 4000 },
      { status: 'error', name: 'web_fetch', timestamp: Date.now() - 3000 },
    ]

    // Act
    const escalation = detectToolEscalationNeed(toolEvents)

    // Assert
    expect(escalation).toBe(CapabilityTier.WEB_LOOKUP)
  })
})
```

---

## 十、总结

| 对比维度 | 旧架构 | 新架构 | 建议 |
|----------|--------|--------|------|
| 代码结构 | 单文件，职责耦合 | 模块化，职责清晰 | 新架构更优 |
| 执行模式 | for 循环 + 分散判断 | 状态机 | 新架构更优 |
| Domain Cooldown | 模块级持久化 | 调用级丢失 | 迁移旧架构 |
| Provider Recovery | 三层恢复 | 直接失败 | 迁移旧架构 |
| Escalation | 完整实现 | 缺失 | 迁移旧架构 |
| Working Memory | 无专门设计 | 永不压缩 | 新架构更优 |
| Context Compression | 自然语言摘要 | 结构化恢复 | 新架构更优 |

**总体建议**：
1. 优先补充 P0 问题（Domain Failure Memory + Provider Recovery）
2. 尽快实现 P1 的 Escalation 机制
3. 保留新架构的 Working Memory 和压缩恢复设计

---

> 文档版本历史
> - v1.0 (2026-05-14): 初始版本