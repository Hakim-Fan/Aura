# Aura Web Tools 重构详设

基于：

1. [docs/web_tools_review.md](/Users/fanhuaze/Documents/YunWork/desk-agent/docs/web_tools_review.md)
2. [docs/WEB_SEARCH_GUIDE.md](/Users/fanhuaze/Documents/YunWork/desk-agent/docs/WEB_SEARCH_GUIDE.md)
3. `docs/open-claw` 中拷贝的 runtime / provider / guard / security 参考实现

本文档目标不是“照搬 open-claw”，而是为当前仓库给出一套可以直接开工、尽量一步到位的重构方案。

---

## 1. 结论

本次重构建议采用：

1. 搜索 provider 只保留三类：
   - `tavily`
   - `brave`
   - `duckduckgo`
2. `google-html` / `bing-html` / `baidu-html` 直接删除，不再继续维护。
3. `auto` provider 的优先级固定为：
   - 显式指定 provider
   - `tavily`（配置了 key）
   - `brave`（配置了 key）
   - `duckduckgo`（无 key fallback）
4. `web_fetch` 继续保留，但内部架构同步按 open-claw 的 runtime / provider / infra 思路拆开。
5. 对外工具名仍保持：
   - `web_search`
   - `web_fetch`
6. 对外结果结构尽量保持兼容，避免影响现有：
   - UI 卡片
   - route-first prompt
   - evidence 收集

一句话说，这次不是“重写 web 工具”，而是“保留现有工具外壳，把内部彻底改成可扩展 provider runtime”。

---

## 2. 为什么要这样做

当前实现的核心问题不是单点 bug，而是结构性问题：

1. [bridge/webTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs:1) 同时承担了 provider 选择、HTTP 请求、HTML 抽取、结果排序、错误建模和工具注册。
2. 搜索 provider 目前是硬编码字符串分支，[bridge/webTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs:1151) 和 [bridge/webTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs:1231) 已经不适合继续扩展。
3. `web_fetch` 现在事实上并没有 provider runtime，[bridge/webTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs:1508) 只允许 `http-readability` 一种 provider。
4. 现有设置体系里没有独立的 web tools 配置域，[src/types.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/types.ts:532) 只有 `browser.search`，它属于 `browser_search`，不应该复用给 `web_search`。
5. 当前 UI 和 evidence 逻辑已经依赖现有工具结构，[src/views/ChatView.tsx](/Users/fanhuaze/Documents/YunWork/desk-agent/src/views/ChatView.tsx:1127) 和 [bridge/agentEvidence.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agentEvidence.mjs:193)，所以不能直接暴露 provider 原始返回。

这意味着最正确的路径不是继续在 `bridge/webTools.mjs` 上打补丁，而是先把层次拆出来。

---

## 3. 本次重构目标

### 3.1 业务目标

1. `web_search` 在真实场景里默认可用，优先使用 Tavily / Brave API。
2. 没有 API key 时自动回退 DuckDuckGo。
3. `web_fetch` 抽取质量比现在更稳定，默认用 Readability。
4. 用户能在设置页配置 Tavily / Brave。
5. route-first 的研究链路与 provider 能力一致，不再建立在 Google/Bing/Baidu HTML 抓取上。

### 3.2 工程目标

1. 保持工具名和大部分输出兼容。
2. 内部改成 runtime + provider + infra + extraction 的结构。
3. 删除不稳定 provider，而不是继续维持历史包袱。
4. 为后续增加 Firecrawl / Jina / 自定义 provider 留接口，但这次先不做完整插件系统。

### 3.3 非目标

1. 这次不做 open-claw 那种完整插件加载器。
2. 这次不做第三方 marketplace 式 provider 发现。
3. 这次不做浏览器渲染抓取 fallback。
4. 这次不把 `browser_search` 和 `web_search` 合并。

---

## 4. 设计原则

### 4.1 保持外部稳定，内部重构

下列接口视为本次重构的兼容边界：

1. `web_search` / `web_fetch` 工具名保持不变。
2. `createWebTools(...)` 仍然是 builtin tool 注册入口。
3. `web_search` 结果仍返回：
   - `query`
   - `provider`
   - `tookMs`
   - `results`
   - `total`
4. `web_fetch` 结果仍返回：
   - `url`
   - `provider`
   - `title`
   - `content`
   - `contentFormat`
   - `sourceAssessment`
   - `riskFlags`
   - `evidenceBlocks`

### 4.2 provider 原始结果不能直接上抛

Tavily / Brave / DuckDuckGo 的返回格式都不同。上层只认 Aura 自己的标准结构。

因此必须有两层模型：

1. provider 内部标准结构
2. tool 对外结果结构

### 4.3 独立的 web settings 域

`browser.search` 是浏览器搜索页偏好，不适合承担 web tool 配置。

必须新增顶层 `web` 设置域，而不是复用：

1. `browser.search.engine`
2. `browser.search.region`
3. `browser.search.language`

---

## 5. 目标架构

重构后目录建议如下：

```text
bridge/
  web/
    index.mjs
    shared/
      errors.mjs
      text.mjs
      cache.mjs
      result-normalizers.mjs
    net/
      guardedFetch.mjs
    security/
      externalContent.mjs
    search/
      runtime.mjs
      ranking.mjs
      query.mjs
      providerRegistry.mjs
      providerTypes.mjs
      providers/
        tavily.mjs
        brave.mjs
        duckduckgo.mjs
    fetch/
      runtime.mjs
      providerRegistry.mjs
      providerTypes.mjs
      extraction/
        readability.mjs
        basicHtml.mjs
      providers/
        httpReadability.mjs
```

保留 [bridge/webTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs:1) 作为兼容 façade：

1. 只负责注册 `web_search` / `web_fetch`
2. 只负责 tool schema、summary、runtime 调用
3. 逻辑全部转发给 `bridge/web/index.mjs`

---

## 6. 设置设计

### 6.1 类型设计

在 [src/types.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/types.ts:532) 新增：

```ts
export type WebSearchProviderId = 'auto' | 'tavily' | 'brave' | 'duckduckgo'

export type WebFetchProviderId = 'auto' | 'http-readability'

export type WebSearchProviderSettings = {
  tavilyApiKey: string
  braveApiKey: string
}

export type WebSearchSettings = {
  enabled: boolean
  provider: WebSearchProviderId
  timeoutSeconds: number
  cacheTtlMinutes: number
  maxResults: number
  providers: WebSearchProviderSettings
}

export type WebFetchSettings = {
  enabled: boolean
  provider: WebFetchProviderId
  timeoutSeconds: number
  maxCharsCap: number
  maxResponseBytes: number
  maxRedirects: number
  readability: boolean
}

export type WebToolsSettings = {
  search: WebSearchSettings
  fetch: WebFetchSettings
}
```

然后把 `AgentSettings` 扩展为：

```ts
export type AgentSettings = {
  ...
  web: WebToolsSettings
}
```

### 6.2 默认值

在 [src/lib/storage.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/lib/storage.ts:127) 的 `defaultSettings` 中新增：

```ts
web: {
  search: {
    enabled: true,
    provider: 'auto',
    timeoutSeconds: 12,
    cacheTtlMinutes: 30,
    maxResults: 5,
    providers: {
      tavilyApiKey: '',
      braveApiKey: '',
    },
  },
  fetch: {
    enabled: true,
    provider: 'auto',
    timeoutSeconds: 15,
    maxCharsCap: 20000,
    maxResponseBytes: 750000,
    maxRedirects: 3,
    readability: true,
  },
}
```

### 6.3 迁移与 normalize

在 [src/lib/storage.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/lib/storage.ts:886) 的 normalize 流程中新增：

1. `normalizeWebSearchSettings`
2. `normalizeWebFetchSettings`
3. `normalizeWebToolsSettings`

要求：

1. 老用户没有 `web` 字段时自动补默认值。
2. key 字段非字符串时回落为 `''`。
3. 数值字段统一做上下界裁剪。

### 6.4 设置页设计

在 [src/SettingsWindowApp.tsx](/Users/fanhuaze/Documents/YunWork/desk-agent/src/SettingsWindowApp.tsx:442) 现有 browser 设置 helper 旁边新增：

1. `updateWebSettings`
2. `updateWebSearchSettings`
3. `updateWebFetchSettings`
4. `updateWebSearchProviderSettings`

设置 UI 新增一个独立 section，例如 “Web Research / Web Search”：

1. 开关：启用 `web_search`
2. Provider 选择：
   - Auto
   - Tavily
   - Brave
   - DuckDuckGo
3. Tavily API Key 输入框
4. Brave API Key 输入框
5. 搜索超时
6. 缓存 TTL
7. `web_fetch` 最大字符数
8. `web_fetch` 最大响应字节数
9. Readability 开关

必须明确提示：

1. `browser.search` 影响 `browser_search`
2. `web.search` 影响 `web_search`

---

## 7. Bridge 接口设计

### 7.1 上下文传递

当前 [bridge/agent.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agent.mjs:833) 构造的 `context` 只有：

1. `cwd`
2. `appControl`
3. `todoState`

重构后建议补一份只读 settings snapshot：

```js
const context = {
  cwd: settings.cwd,
  appControl: hooks.appControl,
  todoState: runtime.todoState || { items: [] },
  settings,
}
```

原因：

1. `web_search` / `web_fetch` 运行时需要读取配置。
2. 当前 `createWebTools(context)` 已经接收了 `context`，只是 [bridge/webTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs:1612) 还没有使用。
3. 比每次 web tool 调用都通过 IPC 拉 live settings 更简单，也更稳定。

### 7.2 tool schema 调整

`web_search` 的 `provider` 取值改为：

1. `auto`
2. `tavily`
3. `brave`
4. `duckduckgo`

删除：

1. `google-html`
2. `bing-html`
3. `baidu-html`

`web_fetch` 的 `provider` 当前只暴露：

1. `auto`
2. `http-readability`

---

## 8. Search runtime 设计

### 8.1 provider 合同

定义一个最小版 provider 接口，参考 open-claw 的 contract，但只保留当前需要的字段：

```ts
export type NormalizedSearchHit = {
  title: string
  url: string
  snippet: string
  site?: string
  publishedAt?: string
  content?: string
}

export type WebSearchProvider = {
  id: 'tavily' | 'brave' | 'duckduckgo'
  label: string
  requiresCredential: boolean
  isConfigured: (settings: AgentSettings) => boolean
  search: (
    args: {
      query: string
      limit: number
      freshness?: 'day' | 'week' | 'month' | 'year'
      locale?: string
      domains?: string[]
    },
    runtime: WebRuntimeContext,
  ) => Promise<{
    provider: string
    answer?: string
    rawResults: NormalizedSearchHit[]
  }>
}
```

### 8.2 auto 选择顺序

`resolveWebSearchProviderOrder(settings, explicitProvider)` 规则如下：

1. 如果 tool args 显式指定 provider，直接使用该 provider。
2. 否则如果设置中显式选了非 `auto` provider，使用该 provider。
3. 否则按顺序探测：
   - `tavily`
   - `brave`
   - `duckduckgo`

探测逻辑：

1. `tavily`：`settings.web.search.providers.tavilyApiKey` 非空
2. `brave`：`settings.web.search.providers.braveApiKey` 非空
3. `duckduckgo`：永远可用

### 8.3 运行流程

`runWebSearch(args, runtime)` 的顺序建议：

1. 参数标准化
2. provider 选择
3. query candidate 生成
4. 调用 provider
5. provider 原始结果做 domain filter
6. 走现有 ranking 增强逻辑
7. 组装 Aura 对外结果

### 8.4 保留现有 ranking

当前 [bridge/webTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs:201) 开始的 ranking / source-quality / novelty 逻辑是有价值的，不建议删掉。

建议迁移到：

1. `bridge/web/search/ranking.mjs`

这样 provider 只负责“找结果”，排序仍由 Aura runtime 统一完成。

### 8.5 Tavily provider

建议实现为主 provider。

输入：

1. `query`
2. `max_results`
3. `search_depth`
4. `include_answer`
5. `include_raw_content`

运行策略：

1. 默认 `include_answer = true`
2. 默认 `include_raw_content = false`
3. 结果里的 `content` 如果存在，保留到 `results[].content`
4. 顶层 `answer` 可选透出

对 Aura 结果的映射：

1. `title -> title`
2. `url -> url`
3. `content 或 snippet -> snippet`
4. `content -> content`
5. `published_date -> publishedAt`

### 8.6 Brave provider

作为第二优先级 provider。

运行策略：

1. 读取 `braveApiKey`
2. 尽量把 freshness / locale 转成 Brave 支持的参数
3. 不支持的筛选项统一在 runtime 层兜底

### 8.7 DuckDuckGo provider

保留为最后 fallback。

要求：

1. provider id 改成统一的 `duckduckgo`
2. 只保留一个 DDG 实现文件
3. 显式检测 challenge 页面
4. 返回失败时，错误摘要要明确是 “bot challenge / empty results / provider unavailable”

---

## 9. Fetch runtime 设计

### 9.1 目标

`web_fetch` 这次不是 provider 的重点，但结构必须同步改好，避免下一次还要再拆。

### 9.2 fetch provider 合同

```ts
export type WebFetchProvider = {
  id: 'http-readability'
  label: string
  fetch: (
    args: {
      url: string
      mode: 'article' | 'markdown' | 'summary' | 'metadata'
      maxChars: number
    },
    runtime: WebRuntimeContext,
  ) => Promise<NormalizedFetchDocument>
}
```

### 9.3 http-readability provider

把现在 `runWebFetch` 里的 HTTP 请求和抽取逻辑拆成：

1. provider 负责拿到页面响应
2. extraction 层负责从 HTML 提取正文
3. runtime 负责组装 `sourceAssessment / riskFlags / evidenceBlocks`

### 9.4 extraction 策略

顺序建议：

1. `@mozilla/readability + linkedom`
2. basic HTML cleanup fallback
3. 对强交互页面报结构化错误

### 9.5 推荐默认参数

参考 open-claw 设计，调整默认值为：

1. `DEFAULT_FETCH_MAX_CHARS = 20_000`
2. `maxResponseBytes = 750_000`
3. `maxRedirects = 3`

---

## 10. 网络与安全层设计

### 10.1 guarded fetch

新增：

1. `bridge/web/net/guardedFetch.mjs`

第一版需要覆盖：

1. 仅允许 `http:` / `https:`
2. 拒绝明显的本地地址：
   - `localhost`
   - `127.0.0.1`
   - `0.0.0.0`
   - `::1`
3. 限制 redirect 次数
4. 限制最大响应字节数
5. 设置统一 UA / Accept / Accept-Encoding
6. 统一 timeout / abort 处理

说明：

1. 这次不强制一步到位做 open-claw 那种完整 DNS pinning
2. 但基础 guard 必须有，否则 Tavily / Brave / DDG / fetch 共用时仍然脆弱

### 10.2 外部内容包装

新增：

1. `bridge/web/security/externalContent.mjs`

这里不建议直接把 open-claw 的包装文本原样展示给用户，而建议分两层：

1. tool 内部内容包装：给模型看
2. UI 展示内容净化：给卡片看

否则现有 `WebSearchEventCard` / `WebFetchEventCard` 会显示很重的安全包裹文本。

建议策略：

1. 内部字段保留 `rawContentWrapped`
2. UI 使用 `displayContent`
3. 如果暂时不做双字段，至少要在 UI 渲染层 strip wrapper markers

---

## 11. 输出兼容策略

### 11.1 `web_search`

建议保留现有顶层结构：

```ts
type AuraWebSearchResult = {
  query: string
  originalQuery?: string
  providerQuery?: string
  domains: string[]
  provider: string
  attemptedProviders?: Array<...>
  answer?: string
  tookMs: number
  total: number
  results: Array<{
    rank: number
    title: string
    url: string
    snippet: string
    site?: string
    publishedAt?: string
    content?: string
    domainCategory?: string
    sourceQualityScore?: number
    noveltyScore?: number
    freshnessScore?: number
    rankScore?: number
    rankingSignals?: string[]
  }>
}
```

兼容原则：

1. `results` 必须始终是数组
2. `provider` 必须明确
3. `content` 是新增可选字段，不破坏旧 UI

### 11.2 `web_fetch`

尽量保持当前结构不动，只换内部实现。

---

## 12. 对 route-first 的联动改造

### 12.1 prompt 调整

当前 [bridge/agentPrompting.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agentPrompting.mjs:182) 的研究 loop 默认是：

1. 一次 broad search
2. 再 `web_fetch`
3. 再回答

接入 Tavily 后需要更新成：

1. 先 `web_search`
2. 如果结果已有高质量 `snippet/content/answer`，可直接回答或只补 1 次 `web_fetch`
3. 只有信息不足时再做更多 fetch

### 12.2 预算调整

当前 [bridge/agentRouting.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agentRouting.mjs:406) 的 `web-lookup` search budget 是 3。

建议调整为：

1. 普通研究：`web-lookup = 5`
2. deep research：`web-lookup = 8`

因为 provider fallback 和 query retry 已经转移到 runtime 内部，但 agent 侧仍需要更宽松的证据预算。

---

## 13. 文件改动清单

### 13.1 必改文件

1. [src/types.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/types.ts:532)
2. [src/lib/storage.ts](/Users/fanhuaze/Documents/YunWork/desk-agent/src/lib/storage.ts:127)
3. [src/SettingsWindowApp.tsx](/Users/fanhuaze/Documents/YunWork/desk-agent/src/SettingsWindowApp.tsx:442)
4. [bridge/agent.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agent.mjs:833)
5. [bridge/tools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/tools.mjs:845)
6. [bridge/webTools.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs:1)
7. [bridge/agentPrompting.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agentPrompting.mjs:182)
8. [bridge/agentRouting.mjs](/Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agentRouting.mjs:406)

### 13.2 新增文件

1. `bridge/web/index.mjs`
2. `bridge/web/shared/errors.mjs`
3. `bridge/web/shared/text.mjs`
4. `bridge/web/shared/cache.mjs`
5. `bridge/web/net/guardedFetch.mjs`
6. `bridge/web/security/externalContent.mjs`
7. `bridge/web/search/providerTypes.mjs`
8. `bridge/web/search/providerRegistry.mjs`
9. `bridge/web/search/query.mjs`
10. `bridge/web/search/ranking.mjs`
11. `bridge/web/search/runtime.mjs`
12. `bridge/web/search/providers/tavily.mjs`
13. `bridge/web/search/providers/brave.mjs`
14. `bridge/web/search/providers/duckduckgo.mjs`
15. `bridge/web/fetch/providerTypes.mjs`
16. `bridge/web/fetch/providerRegistry.mjs`
17. `bridge/web/fetch/runtime.mjs`
18. `bridge/web/fetch/extraction/readability.mjs`
19. `bridge/web/fetch/extraction/basicHtml.mjs`
20. `bridge/web/fetch/providers/httpReadability.mjs`

---

## 14. 分阶段实施方案

### Phase 1：设置与骨架

目标：

1. 新增 `settings.web`
2. 新增设置页 UI
3. 建立 `bridge/web/` 目录和 provider contract

验收标准：

1. 设置能保存 Tavily / Brave key
2. 运行时能读到 `settings.web`
3. 原有 `web_search` / `web_fetch` 仍可工作

### Phase 2：Search runtime 落地

目标：

1. 把搜索逻辑从 `bridge/webTools.mjs` 拆到 `bridge/web/search/*`
2. 删除 Google / Bing / Baidu provider
3. 接入 Tavily / Brave / DuckDuckGo

验收标准：

1. `provider=auto` 时按预期顺序选择 provider
2. 指定 `provider=tavily|brave|duckduckgo` 可单独工作
3. UI 卡片仍正常显示

### Phase 3：Fetch runtime 落地

目标：

1. 把 fetch 逻辑拆到 `bridge/web/fetch/*`
2. 接入 Readability
3. 接入 guarded fetch

验收标准：

1. `web_fetch` 抽取质量优于当前版本
2. `maxCharsCap` 和 `maxResponseBytes` 生效
3. 明显浏览器页面仍返回结构化错误

### Phase 4：Prompt / budget / evidence 收口

目标：

1. 调整 route-first prompt
2. 调整 search budget
3. 校正有 `content` 的 search result 在回答链路中的使用方式

验收标准：

1. 最新信息类任务默认走 `web_search`
2. 有高质量 search content 时，模型不必机械追加 `web_fetch`
3. route-first 的决策表现更符合真实 provider 能力

---

## 15. 建议删除的旧实现

这次重构完成后，建议直接删掉：

1. `buildGoogleUrl`
2. `buildBingUrl`
3. `buildBaiduUrl`
4. `parseGoogleResults`
5. `parseBingResults`
6. `parseBaiduResults`
7. 与三者相关的 provider 字符串和 prompt 描述

保留：

1. query normalize
2. result ranking
3. source assessment
4. evidence blocks

---

## 16. 验证清单

开发完成后至少验证这些场景：

1. 只配置 Tavily key，`auto` 走 Tavily。
2. 只配置 Brave key，`auto` 走 Brave。
3. 两个 key 都没配，`auto` 走 DuckDuckGo。
4. 显式指定 `provider=duckduckgo` 时，不因已有 Tavily/Brave key 而切换。
5. `domains` 过滤在 Tavily / Brave / DuckDuckGo 下都能正常生效。
6. `web_fetch` 对普通文章页面能抽出正文。
7. `web_fetch` 对登录/风控页面能返回结构化错误。
8. 设置页保存后，下一轮 agent 运行立即能读取最新配置。

---

## 17. 最终建议

如果只看 ROI，这次最值得一次做对的点只有三个：

1. 独立 `settings.web`
2. runtime / provider / infra 分层
3. 搜索 provider 只保留 `tavily` / `brave` / `duckduckgo`

只要这三点做对，后面不管接 Firecrawl、Jina 还是更多 provider，都不会再回到现在这种“每加一个 provider 就继续堆 if/else”的状态。
