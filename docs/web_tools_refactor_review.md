# Web Tools 重构 Review 报告

基于重构设计文档 `web_tools_refactor_detailed_design.md` 和 OpenClaw 分析文档 `WEB_SEARCH_GUIDE.md`，对当前重构后的代码进行了逐文件交叉审查。

---

## 1. 整体评价

重构做得很扎实，核心架构目标基本全部达成：

| 设计目标 | 状态 | 备注 |
|---------|------|------|
| runtime / provider / infra 分层 | ✅ 完成 | `bridge/web/` 目录结构清晰 |
| 删除 Google/Bing/Baidu HTML 爬虫 | ✅ 完成 | 新 runtime 不再引用 |
| Tavily / Brave / DDG 三个 provider | ✅ 完成 | 各自独立文件 |
| auto 探测顺序正确 | ✅ 完成 | tavily → brave → duckduckgo |
| 搜索缓存 | ✅ 完成 | SHA1 key + TTL |
| guardedFetch + SSRF 防护 | ✅ 完成 | 私有 IP / 协议 / redirect 限制 |
| Readability 内容提取 | ✅ 完成 | `@mozilla/readability` + `linkedom` |
| 设置类型 + 默认值 + normalize | ✅ 完成 | types.ts + storage.ts |
| 设置页 UI | ✅ 完成 | Web Research section |
| 搜索预算调整 | ✅ 完成 | 3→5 (普通), 8 (deep) |
| Prompt 优化 | ✅ 完成 | 调整了研究 loop 指导 |
| Ranking 逻辑保留 | ✅ 完成 | 迁移到 search/runtime.mjs |

---

## 2. 需要修复的问题

### P0：阻塞性问题（会导致功能异常）

#### 2.1 `settings` 没有注入到 tool runtime

**文件**：`bridge/tools.mjs` L1605-L1618

```javascript
// 当前 invokeTool 构造的 runtime：
tool.run(args, {
  signal: abortController?.signal,
  throwIfAborted() { ... },
  onUpdate(nextOutput) { ... },
  // ❌ 没有 settings 字段
})
```

但 `web/search/runtime.mjs` L362 期望：

```javascript
const settings = runtime.settings || {}
```

**结果**：`runtime.settings` 永远是 `undefined`，所有对 `settings.web.search.*` 的读取全部走 fallback 默认值。

**影响**：
1. Tavily/Brave API Key **永远读不到**，即使用户在设置页配置了
2. `provider` 选择永远得到 `duckduckgo`（因为 `isConfigured` 判断 `settings?.web?.search?.providers?.tavilyApiKey` 拿不到值）
3. `timeoutSeconds`, `cacheTtlMinutes`, `maxResults`, `maxCharsCap` 等用户自定义配置全部失效

**你在 `webTools.mjs` L1672 做了补偿**：

```javascript
return runStructuredWebSearch(args, {
  ...runtime,
  settings: runtime.settings || context.settings || {},
})
```

但问题是 `runtime` 里本身就没有 `settings`（因为 `invokeTool` 没注入），所以走到 `context.settings`。这里的 `context.settings` 是在 `agent.mjs` L837 注入的：

```javascript
const context = {
  cwd: settings.cwd,
  appControl: hooks.appControl,
  todoState: runtime.todoState || { items: [] },
  settings,  // ← 这个 settings 是 agent 顶层的 settings
}
```

这条链路 **恰好能工作**——但仅仅因为 `createWebTools(context)` 闭包捕获了 `context`。

**风险**：如果 `context.settings` 是 agent 启动时的 snapshot，而用户在 agent 运行过程中修改了 API Key，不会生效。这是一个微小但存在的 timing 问题。

**建议**：在 `invokeTool` 中把 `hooks.settings` 注入到 runtime：

```javascript
tool.run(args, {
  signal: abortController?.signal,
  settings: hooks.settings,          // ← 新增
  throwIfAborted() { ... },
  onUpdate(nextOutput) { ... },
})
```

#### 2.2 `guardedFetch` 手动 redirect 但没自动解压 gzip

**文件**：`bridge/web/net/guardedFetch.mjs` L67-L77

```javascript
const response = await fetch(currentUrl, {
  ...init,
  signal: linked.signal,
  redirect: 'manual',       // ← 手动处理
  headers: {
    'accept-encoding': 'gzip, deflate, br',  // ← 声明了接受压缩
    ...(init.headers || {}),
  },
})
```

你声明了 `accept-encoding: gzip`，但 `redirect: 'manual'` 意味着你手动跟踪 redirect。问题是：

- Node.js 原生 `fetch`（undici）在 `redirect: 'manual'` 时，**某些版本不会自动解压** gzip，可能只有 `redirect: 'follow'` 时才自动解压。
- `readResponseText()` 直接用 `response.arrayBuffer()` + `TextDecoder`，如果响应是 gzip 压缩的，会拿到乱码。

**建议**：

方案 A（简单）：在 `readResponseText` 中加 gzip 解压：

```javascript
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib'

export async function readResponseText(response, maxBytes = 750_000) {
  const buffer = await response.arrayBuffer()
  const encoding = (response.headers.get('content-encoding') || '').toLowerCase()
  let decoded = Buffer.from(buffer)
  if (encoding === 'gzip') decoded = gunzipSync(decoded)
  else if (encoding === 'br') decoded = brotliDecompressSync(decoded)
  else if (encoding === 'deflate') decoded = inflateSync(decoded)
  // ... 后续 TextDecoder 逻辑
}
```

方案 B（更好）：用 `response.text()` 代替手动 `arrayBuffer()` + `TextDecoder`，因为 Node.js 的 `undici` 已经在 `response.text()` 中处理了解压。需要验证你的 Node.js 版本。

#### 2.3 `fetchText` 没用 `readResponseText`

**文件**：`bridge/web/net/guardedFetch.mjs` L118-L124

```javascript
export async function fetchText(url, init = {}, options = {}) {
  const response = await guardedFetch(url, init, options)
  return {
    response,
    text: await response.text(),  // ← 直接用 response.text()
  }
}
```

而 `readResponseText`（L126-L146）做了字节限制和 charset 处理。但 `fetchText` 完全没用它。

DDG provider 用的是 `fetchText`，所以 DDG 的搜索请求**没有字节限制和 charset 保护**。

**建议**：统一让 `fetchText` 也走 `readResponseText`（或至少加 maxBytes 支持）。

---

### P1：重要但不阻塞的问题

#### 2.4 `webTools.mjs` 仍保留 1720 行旧代码

旧文件里的 `runWebSearch`、`runWebFetch`、`parseDuckDuckGoResults`、`parseGoogleResults`、`parseBingResults`、`parseBaiduResults` 等函数**全都还在**，只是不被 `createWebTools` 调用了（通过 `runStructuredWebSearch` 代替）。

但这些死代码存在误导性：

1. 有人可能误以为 Google/Bing/Baidu 还可用
2. 增加维护心智负担
3. 文件体积 52KB，影响 bridge 加载

**建议**：这次重构完成并稳定后，把旧实现全部删除，`webTools.mjs` 只保留 `createWebTools` 的 facade 壳（约 120 行）。

#### 2.5 `web_fetch` runtime 的 redirect 参数冲突

**文件**：`bridge/web/fetch/runtime.mjs` L459-L470

```javascript
const response = await guardedFetch(
  normalizedUrl,
  {
    method: 'GET',
    redirect: 'follow',       // ← fetch runtime 让它 follow
  },
  {
    maxRedirects: fetchSettings.maxRedirects,  // ← guardedFetch 也有 redirect 控制
  },
)
```

但 `guardedFetch` 内部强制把 `redirect` 改成 `manual` 并手动处理 redirect。所以 `init.redirect = 'follow'` 会被 `guardedFetch` 覆盖——这虽然不会报错，但语义矛盾，可能让后续维护者困惑。

**建议**：在 `fetchRuntime` 中不再传 `redirect: 'follow'`，让 `guardedFetch` 完全接管。

#### 2.6 DDG provider 的 `fetchText` 没有 maxRedirects

**文件**：`bridge/web/search/providers/duckduckgo.mjs` L148-L160

```javascript
const { response, text } = await fetchText(
  buildDuckDuckGoUrl(args),
  { method: 'GET', ... },
  {
    signal: runtime.signal,
    timeoutMs: args.timeoutMs,
    // ❌ 没有 maxRedirects
  },
)
```

`guardedFetch` 中 `maxRedirects` 默认是 `0`（`Math.max(0, Number(options.maxRedirects) || 0)`），这意味着 DDG 和搜索引擎爬虫**不跟重定向**。

问题：DDG `/html/` 有时会做一次 302 重定向（加 cookie / locale 参数）。如果不允许 redirect，会直接返回 302 response。

**建议**：DDG provider 加 `maxRedirects: 3`。

#### 2.7 Tavily 的 `include_answer` 和 `include_raw_content` 参数值类型

**文件**：`bridge/web/search/providers/tavily.mjs` L32-L33

```javascript
include_answer: 'basic',           // ← Tavily API 是 boolean 或 string?
include_raw_content: 'text',       // ← 同上
```

需要确认 Tavily API 最新文档。如果它期望 boolean，传 string 可能被忽略或报错。旧版 Tavily 是 boolean (`true/false`)，新版可能扩展为 string。

**建议**：确认 Tavily API v2 的参数规范，必要时用 `true` 替代。

#### 2.8 Brave provider 没有 answer 字段

**文件**：`bridge/web/search/providers/brave.mjs`

Brave Search API 不返回 `answer` 字段。但设计文档和 prompt 里提到了 "answer fields"。这不是 bug，但意味着 Brave 模式下 LLM 拿不到直接答案摘要，仍然需要 `web_fetch`。

**建议**：在 `agentPrompting` 中对不带 answer 的搜索结果做引导差异化（"if answer is present, it can be used directly"）。

---

### P2：改进建议

#### 2.9 缓存无 size 上限

**文件**：`bridge/web/shared/cache.mjs`

`SEARCH_CACHE` 是一个普通 `Map`，没有最大条目限制。长时间运行下会无限增长。

**建议**：加一个 LRU 淘汰，或每次写入前检查 size 超过阈值（如 200 条）时清理最旧的。

#### 2.10 search runtime 和 fetch runtime 重复了大量工具函数

`collapseWhitespace`、`unique`、`normalizeDomain`、`extractHostname`、`tokenizeSearchTerms`、`classifySearchResultDomain` 等函数在两个 runtime 中各实现了一份。

**建议**：把这些公共函数移到 `bridge/web/shared/text.mjs`（设计文档中已规划了这个文件但没有创建）。

#### 2.11 `looksLikeBrowserOnlyPage` 误判风险

**文件**：`bridge/web/fetch/extraction/basicHtml.mjs` L167-L191

`sign in` 和 `log in` 作为 signal 太宽泛。很多正常文章页面的侧边栏会包含 "Sign in" 字样，不代表页面需要登录才能看。

**建议**：结合信号密度判断（比如同时出现 `sign in` + `<input type="password">`）才触发，单独出现 `sign in` 只加一个弱信号而不直接判定。

#### 2.12 Readability 提取后走 `extractBasicHtmlContent` 冗余

**文件**：`bridge/web/fetch/extraction/readability.mjs` L36

```javascript
const markdown = extractBasicHtmlContent(article.content)
```

Readability 的 `article.content` 已经是清洗过的 HTML，再过一遍 `htmlToMarkdownish` 会丢失一些结构信息（比如表格和列表层级）。

**建议**：用 `turndown` 库做 HTML → Markdown 转换，或直接用 Readability 的 `textContent` 配合轻量格式化。

---

## 3. 未完成项（对照设计文档 checklist）

| 设计文档章节 | 状态 | 说明 |
|------------|------|------|
| §10.2 外部内容安全包装 `externalContent.mjs` | ❌ 未实现 | 文件不存在，web 内容未做 prompt injection 防护 |
| §5 `shared/text.mjs` 和 `shared/errors.mjs` | ❌ 未创建 | 导致工具函数重复 |
| §5 `search/query.mjs` | ❌ 未创建 | query normalize 逻辑内联在 search runtime 中 |
| §5 `search/ranking.mjs` | ❌ 未创建 | ranking 逻辑内联在 search runtime 中 |
| §5 `fetch/providerRegistry.mjs` / `providerTypes.mjs` | ❌ 未创建 | fetch 只有一个 provider，暂可接受 |

这些属于文件粒度偏好问题，当前内联在 runtime 中也能工作，但如果后续要加 Firecrawl / Jina 等 provider，建议拆出来。

---

## 4. 测试建议

按设计文档 §16 的验证清单，建议手动验证：

```text
[ ] 1. 只配置 Tavily key → auto 走 Tavily，搜索返回 answer + content
[ ] 2. 只配置 Brave key → auto 走 Brave，搜索返回结构化结果
[ ] 3. 两个 key 都没配 → auto 走 DuckDuckGo
[ ] 4. 显式指定 provider=duckduckgo 时不受 key 影响
[ ] 5. 搜索缓存命中验证（同一 query 第二次应该秒返）
[ ] 6. web_fetch 对 Markdown/文章页面提取质量
[ ] 7. web_fetch 对 Yahoo Finance 等 SPA 页面的降级行为
[ ] 8. 设置页保存 API Key 后立刻生效
[ ] 9. DDG bot-challenge 检测是否工作（故意触发）
```

---

## 5. 修复优先级汇总

| 优先级 | 问题 | 修复建议 |
|-------|------|---------|
| **P0** | settings 没注入到 tool runtime | `invokeTool` 中加 `settings: hooks.settings` |
| **P0** | gzip 响应未解压 | `readResponseText` 加 zlib 解压 |
| **P0** | `fetchText` 没走 `readResponseText` | 统一走 `readResponseText` 或加字节保护 |
| **P1** | DDG 没有 maxRedirects | 加 `maxRedirects: 3` |
| **P1** | `webTools.mjs` 旧代码 1700 行未清理 | 删除死代码 |
| **P1** | redirect 参数语义冲突 | fetch runtime 去掉 `redirect: 'follow'` |
| **P1** | Tavily 参数值类型确认 | 对照 API 文档校验 |
| **P2** | 缓存无 size 上限 | 加 LRU 淘汰 |
| **P2** | 工具函数重复 | 提取到 `shared/text.mjs` |
| **P2** | `looksLikeBrowserOnlyPage` 误判 | 加信号密度判断 |
| **P2** | Readability + basicHtml 冗余链路 | 用 turndown 或直接用 textContent |
| **P2** | 安全包装未实现 | 创建 `externalContent.mjs` |
