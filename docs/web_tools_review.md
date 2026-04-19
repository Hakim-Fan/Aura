# Web 工具链深度 Review：为什么搜索能力这么差

> **结论**：当前 web_search / web_fetch 的核心问题不是代码写得不好，而是**技术路线选错了**——用 HTML 爬虫模拟搜索引擎在 2026 年几乎不可能稳定工作。

---

## 1. 实测验证

我对你代码里 4 个搜索 provider 和 fetch 逻辑做了实际网络请求测试，结果如下：

| Provider | 请求结果 | 能否解析出搜索结果 |
|----------|---------|------------------|
| `google-html` | **HTTP 302 重定向** → consent 页面，0 个搜索结果 | ❌ 完全失效 |
| `duckduckgo-html` | **HTTP 202** → challenge/anomaly 验证页，`result__a` 计数 = 0 | ❌ 完全失效 |
| `bing-html` | HTTP 200，68KB HTML，但 `b_algo` 类名可能已变 | ⚠️ 部分可用但不稳定 |
| `baidu-html` | 未测试，但百度对爬虫管控更严 | ⚠️ 大概率不稳定 |

**DDG 返回的实际内容**（关键证据）：

```html
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&cc=sre&st=...">
```

这是一个 **JavaScript challenge 页面**，不包含任何搜索结果。你的正则表达式去匹配 `result__a`、`result__snippet`，匹配数为 0。

**Google 返回的实际内容**：HTTP 302 重定向到 consent 页面，`class="g"` 匹配数为 0。

### Fetch 测试

| 目标站点 | 结果 |
|---------|------|
| Yahoo Finance | HTTP 200，380KB，**但返回 gzip 压缩数据**，代码没有 `Accept-Encoding` 也没做解压 → 拿到乱码 |
| Reuters | **HTTP 401** → 直接拒绝 |
| SPA 类站点 | HTML 中 `<article>` `<main>` 标签计数 = 0，因为内容靠 JS 渲染 |

---

## 2. 七个根因逐一分析

### 根因 1：搜索引擎 HTML 抓取方案在 2026 年几乎全部失效

**代码位置**：[webTools.mjs L936-L1201](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs#L936-L1201)

你的 `searchWithProvider()` 对 4 个搜索引擎都走 HTTP GET 抓取 HTML → 正则解析的路线：

```
fetch("https://html.duckduckgo.com/html/?q=...")  → parseDuckDuckGoResults()
fetch("https://www.google.com/search?q=...")       → parseGoogleResults()
fetch("https://www.bing.com/search?q=...")          → parseBingResults()
fetch("https://www.baidu.com/s?wd=...")             → parseBaiduResults()
```

**致命问题**：

- **DDG** 早在 2024 年就对 `/html/` endpoint 加了 anomaly detection，非浏览器请求返回 challenge 页
- **Google** 对程序化请求返回 302 → consent 页，或 429 rate limit
- **Bing** 相对宽松但 CSS class 经常变，`b_algo` 随时可能被改
- **百度** 对爬虫返回简化版页面或直接拦截

**这就是为什么你"展示了一堆搜索但拿不到信息"的根本原因**——搜索引擎根本没返回搜索结果。

### 根因 2：正则解析 CSS 类名是脆弱方案

**代码位置**：[parseDuckDuckGoResults L961-L990](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs#L961-L990)、[parseGoogleResults L1074-L1112](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs#L1074-L1112)

```javascript
// DDG 依赖：result__a, result__snippet, result__url
const anchorPattern = /class="[^"]*result__a[^"]*"/

// Google 依赖：g, MjjYud, VwiC3b, s3v9rd, yXK7lf, aCOpRe, MUxGbd
const blockPattern = /class="[^"]*(?:g|MjjYud)[^"]*"/
```

这些 CSS 类名是搜索引擎内部命名，**没有任何稳定性保证**。Google 的 CSS 类每隔几周就会变。即使搜索引擎没有拦截你的请求，解析结果也是时好时坏。

### 根因 3：fetch 不处理 Content-Encoding

**代码位置**：[fetchText L905-L934](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs#L905-L934)

```javascript
const response = await fetch(url, {
  ...init,
  headers: {
    'user-agent': USER_AGENT,
    accept: 'text/html,...',
    // ❌ 没有 accept-encoding
    // ❌ 没有处理 gzip/br 解压
  },
})
const text = await response.text()  // 如果响应是 gzip，这里拿到乱码
```

测试证明 Yahoo Finance 返回 gzip 压缩数据。Node.js 的 `fetch` 默认**不自动解压**（除非全局启用了 `decompress` 选项 或使用 `undici` 的全局设置）。你可能拿到 380KB 的乱码二进制数据。

### 根因 4：`DEFAULT_FETCH_MAX_CHARS = 4000` 太低

**代码位置**：[webTools.mjs L8](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs#L8)

```javascript
const DEFAULT_FETCH_MAX_CHARS = 4_000
```

4000 字符大约是**一页 A4 纸的文本量**。对于现代网页，正文提取后 4K 字符可能只覆盖前 2-3 段。很多关键信息（财务数据表格、详细分析、新闻正文后半部分）根本读不到。

**对比**：主流 agent 的 fetch 限制通常在 **20K-50K** 字符。

### 根因 5：HTML → Markdown 提取对 SPA/动态页面无效

**代码位置**：[pickHtmlContentCandidate L793-L819](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs#L793-L819)、[htmlToMarkdownish L822-L839](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/webTools.mjs#L822-L839)

```javascript
// 靠正则匹配 <article>, <main>, <section>, <div class="content">
const patterns = [
  /<article\b[^>]*>([\s\S]*?)<\/article>/giu,
  /<main\b[^>]*>([\s\S]*?)<\/main>/giu,
  // ...
]
```

现代网站（Yahoo Finance、东方财富、雪球等）几乎都是 **React/Vue SPA**，页面 HTML 里的 `<main>` 和 `<article>` 标签为空或不存在，真正的内容靠 JavaScript 渲染。纯 HTTP fetch + 正则提取对这些站点完全无效。

同时 `htmlToMarkdownish()` 也是纯正则：把 `<h1>` 替换为 `# `，把 `<li>` 替换为 `- ` ——这在复杂 HTML 中产生大量噪音。

### 根因 6：搜索预算太紧 + Prompt 过度抑制搜索

**代码位置**：[SEARCH_BUDGET_BY_TIER L406-L412](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agentRouting.mjs#L406-L412)、[agentPrompting L182-L217](file:///Users/fanhuaze/Documents/YunWork/desk-agent/bridge/agentPrompting.mjs#L182-L217)

```javascript
// 标准模式只有 3 次搜索机会
'web-lookup': 3,
```

Prompt 中还有大量"不要浪费搜索"的抑制指令：

```
'Do not burn searches on minor query rewrites.'
'After two discovery searches without switching to reading, stop and move to web_fetch or a bounded answer.'
```

这意味着 LLM 即使知道搜索结果不好，也被 prompt 限制不敢多搜几次。但在搜索引擎都返回空结果的前提下，这些限制反而让 agent 更快放弃。

### 根因 7：与主流 Agent 的根本架构差异

**主流 Agent 的做法**：

| Agent 产品 | 搜索方式 | 内容获取 |
|-----------|---------|---------|
| ChatGPT | **Bing Search API**（官方付费接口，返回结构化 JSON） | 自研 browsing 引擎 |
| Claude | **专用 search tool**（内部 API） | 服务端 headless browser |
| Cursor / Windsurf | **Tavily API** 或 **Serper API**（搜索 + 内容一站式返回） | 搜索结果自带 snippet |
| Perplexity | **自建搜索引擎** | 自建爬虫 + LLM 摘要 |

**核心区别**：它们都用的是**搜索 API**，不是爬 HTML。

搜索 API 返回的是**结构化 JSON**：

```json
{
  "results": [
    {
      "title": "Tesla Q1 2026 Earnings...",
      "url": "https://...",
      "content": "Tesla reported revenue of $25.2 billion...(完整摘要 500-2000 字)"
    }
  ]
}
```

注意：很多搜索 API（如 Tavily）**直接在搜索结果中返回页面正文摘要**，根本不需要第二步的 `web_fetch`。这就是为什么其他 agent "1-2 轮内就有足够数据"且"没有分两步"的原因。

---

## 3. 推荐搜索 API 对比

| API | 价格 | 特点 | 推荐度 |
|-----|------|------|--------|
| **Tavily** | 免费 1000 次/月，付费 $0.01/次 | 搜索 + 内容提取一体化，返回 content 字段包含页面正文 | ⭐⭐⭐⭐⭐ |
| **Serper** | 免费 2500 次/月，付费 $0.001/次 | Google Search API 封装，返回丰富 snippet | ⭐⭐⭐⭐ |
| **Bing Search API** | 免费 1000 次/月 | 微软官方，结果质量好 | ⭐⭐⭐⭐ |
| **SearXNG** | 免费自部署 | 开源元搜索引擎，聚合多源 | ⭐⭐⭐ |
| **Google Custom Search** | 免费 100 次/天 | Google 官方，限额低 | ⭐⭐⭐ |

**最推荐 Tavily**：因为它一次调用就返回搜索结果 + 页面正文摘要，你可以**直接干掉 `web_fetch` 这个工具**，用一个 `web_search` 就搞定。

---

## 4. 修复优先级

### P0：立刻能修的（不改架构）

1. **`fetchText` 加 gzip 解压支持**
   ```javascript
   headers: {
     'accept-encoding': 'gzip, deflate, br',
     // ...
   }
   // 或使用 undici 的 decompress: true
   ```

2. **`DEFAULT_FETCH_MAX_CHARS` 从 4000 提到 16000**
   ```javascript
   const DEFAULT_FETCH_MAX_CHARS = 16_000
   ```

3. **搜索预算从 3 提到 5**，Prompt 中减少"不要搜索"的抑制语

### P1：短期改造（1-2 天）

4. **接入 Tavily 或 Serper API 作为首选搜索 provider**
   - 新增 `tavily-api` provider
   - 返回结构化 JSON + content 正文
   - 保留 HTML 爬虫作 fallback
   - 在设置页增加 `searchApiKey` 配置项

5. **当 Tavily 返回 content 时，省略 `web_fetch` 步骤**
   - 搜索结果自带正文时，LLM 直接用，不再第二步 fetch
   - 只有当正文不够时才调 `web_fetch`

### P2：中期优化（3-5 天）

6. **用 `@mozilla/readability` 替换自研的 HTML 提取**
   - `npm install @mozilla/readability jsdom`
   - 提取质量远超正则方案

7. **针对 SPA 页面的降级**
   - 检测到 JS 渲染页面时，自动降级到 `browser_*` 工具读取
   - 或使用 Jina Reader API（`https://r.jina.ai/URL`）做内容提取

---

## 5. 快速修复示例：接入 Tavily

```javascript
// 新增 searchWithTavily provider
async function searchWithTavily(args, runtime = {}) {
  const apiKey = runtime.settings?.searchApiKey || process.env.TAVILY_API_KEY
  if (!apiKey) throw new Error('Tavily API key not configured')

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: args.query,
      max_results: args.limit || 5,
      include_answer: true,       // 直接返回 AI 摘要
      include_raw_content: false,
      search_depth: 'basic',      // 'basic' 够用，'advanced' 更慢但更全
    }),
    signal: AbortSignal.timeout(10000),
  })

  const data = await response.json()

  return {
    provider: 'tavily-api',
    answer: data.answer,  // Tavily 直接给的 AI 摘要
    rawResults: (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || '',  // Tavily 的 content 就是提取后的页面正文
      site: extractHostname(r.url || ''),
      score: r.score || 0,
    })),
  }
}
```

接入后的效果：

- 搜索 "特斯拉最新财报" → Tavily 直接返回 5 条结果，每条带 200-2000 字的页面正文
- LLM 拿到这些 content 就足够回答了，**不需要再调 web_fetch**
- 总共只需要 **1 轮工具调用**，而不是现在的 2-3 轮

---

## 6. 总结：你与主流 Agent 的差距在哪

```
你当前的流程（最少 2 轮，经常失败）：
  LLM → web_search(DDG HTML 爬虫) → 返回空结果 ❌
      → web_search(Google HTML 爬虫) → 返回 consent 页 ❌
      → web_search(Bing HTML 爬虫) → 可能返回几条 ⚠️
      → web_fetch(某个 URL) → gzip 乱码 / SPA 空内容 ❌
      → web_fetch(另一个 URL) → 被 401 拒绝 ❌
      → 放弃，回答"没找到"

主流 Agent 的流程（1 轮搞定）：
  LLM → search_api(Tavily/Serper) → 返回 5 条结构化结果 + 页面正文 ✅
      → 直接基于正文回答
```

**一句话概括**：不是你的代码写得差，而是在 2026 年想靠 HTTP 爬虫去抓搜索引擎 HTML 页面，这条路本身就走不通。搜索引擎全面反爬之后，必须走正规 API。
