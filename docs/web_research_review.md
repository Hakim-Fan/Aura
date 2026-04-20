Web Research 能力代码审查与优化方案
1️⃣ 总体评价
维度 当前实现 是否达标 备注
架构层次 web_search → web_fetch → web_research ✅ 职责划分清晰，符合设计文档的“原子化调研”思路
并发抓取 Promise.all 并发抓取 top‑N 结果 ✅ 能在 1‑2 s 内返回多个页面的摘要
内容容量控制 3200 字符（standard）/ 5200 字符（deep） ✅ 防止上下文膨胀
多提供商降级 Tavily → Brave → DuckDuckGo ✅ 失效时自动降级
证据抽取 关键词评分 → evidenceScore ✅ 已实现四类证据（quantitative、attributed、forward‑looking、descriptive）
缓存 纯内存 Map ⚠️ 重启即丢失，缺乏热点预取
动态页面处理 简单 looksLikeBrowserOnlyPage 检测 ⚠️ 对 SPA/SSR 支持不足
搜索排序 固定权重（quality 42% / coverage 28% / novelty 20% / freshness 10%） ⚠️ 时效性权重过低，缺少意图感知
跨源验证 仅有 detectDirectionalConflict（未在 web_research 中使用） ⚠️ 缺少实际的冲突标记与佐证度量
结论：整体框架合理，但在 搜索排序、内容提取、证据质量、缓存、动态页面 四大关键点与主流商业项目（Perplexity、You.com、Google）仍有显著差距。

2️⃣ 关键问题与优化建议
2.1 搜索排序算法

问题

时效性仅 10% 权重，导致“最新新闻 / 股价”类查询结果陈旧。
权重固定，未根据查询意图动态调节。
建议

js

// bridge/web/search/runtime.mjs
function getDynamicWeights(query) {
const freshQuery = /最新|今天|当前|news|latest|current/i.test(query);
return freshQuery
? { quality: 0.30, coverage: 0.20, novelty: 0.15, freshness: 0.35 }
: { quality: 0.42, coverage: 0.28, novelty: 0.20, freshness: 0.10 };
}
通过正则快速检测时效性意图，并动态生成权重。后期可接入 LTR（Learning‑to‑Rank）模型进一步提升。

2.2 内容提取（Fetch）

问题

仅使用 @mozilla/readability + 基础 HTML fallback，无法渲染 SPA、React/Vue 等动态页面。
looksLikeBrowserOnlyPage 检测不够细致，漏判大量 JS‑dependent 页面。
建议

新增动态页面检测（在 web_fetch/runtime.mjs）
js

function detectJsDependent(html) {
const hasSkeleton = /class=["']._\b(skeleton|loading|spinner)\b._["']/i.test(html);
const hasSSRFlag = /**NEXT_DATA**|**NUXT**|window\.**INITIAL**/i.test(html);
return hasSkeleton || hasSSRFlag;
}
引入云端渲染 fallback（如 Jina AI Reader，详见第 3 节）。
2.3 证据抽取与跨源验证

问题

证据评分仅靠关键词打分，缺少语义理解。
没有实际使用 detectDirectionalConflict，缺少冲突/佐证提示。
建议

在 web_research 结果中加入 Cross‑Source Insights，结构示例：
json

{
"crossSourceInsights": {
"hasConflict": true,
"conflictDetails": [
{
"claim": "Company X revenue grew 20% YoY",
"sources": ["sourceA", "sourceB"],
"conflictType": "quantitative",
"notes": "sourceA 报 19.8%，sourceB 报 21.2%"
}
],
"corroborationScore": 0.78
}
}
若有冲突，返回 evidenceLevel: "conflict"；若多源一致，返回 evidenceLevel: "strong"。
2.4 Provider 集成 – Jina AI Reader（新增）

2.4.1 可行性
Jina AI Reader (https://r.jina.ai/URL) 提供 云端渲染 + markdown 输出，对 SPA、PDF、图片都有原生支持。
适合作为 web_fetch 的 fallback provider，填补本地 Readability 的盲区。
2.4.2 集成位置
新增文件：bridge/web/fetch/providers/jina.mjs
调用顺序（在 runWebFetch 中）：
readability → basicHtml → JinaReader (fallback)
2.4.3 核心实现（示例）
js

// bridge/web/fetch/providers/jina.mjs
import { guardedFetch, readResponseText } from '../../net/guardedFetch.mjs';
import { createStructuredError } from '../../runtimeErrors.mjs';

export function createJinaFetchProvider() {
return {
id: 'jina-reader',
name: 'Jina AI Reader',
type: 'cloud-fetch',
async fetch(url, { timeoutMs = 8000 } = {}) {
const encoded = encodeURIComponent(url);
const fetchUrl = `https://r.jina.ai/${encoded}`;
const resp = await guardedFetch(fetchUrl, { timeoutMs });

      if (!resp.ok) {
        throw createStructuredError('JINA_FETCH_FAILED', {
          status: resp.status,
          statusText: resp.statusText,
          url,
        });
      }

      const markdown = await readResponseText(resp);
      // 将 Markdown 转为纯文本（用于后续切片/评分）
      const plain = markdown.replace(/[\r\n]+/g, ' ').trim();
      return { markdown, plain };
    },

    // 当本地解析失败或检测到 JS‑dependent 时使用
    shouldUse({ html, signals }) {
      return signals.readabilityFailed || signals.jsDependent;
    },

};
}
2.4.4 注册
在 bridge/web/fetch/runtime.mjs 中：

js

import { createJinaFetchProvider } from './providers/jina.mjs';
const FETCH_PROVIDERS = [
createReadabilityProvider(),
createBasicHtmlProvider(),
createJinaFetchProvider(), // ← 新增
];
2.4.5 错误处理 & 限流
对 JINA_FETCH_FAILED 统一包装为 WebFetchError，保持与其他 provider 错误一致。
在 runWebFetch 中加入 最小间隔 1.5 s（防止短时间请求被封），示例：
js

let lastJinaCall = 0;
async function rateLimitedJina(url) {
const now = Date.now();
const wait = Math.max(0, 1500 - (now - lastJinaCall));
if (wait) await new Promise(r => setTimeout(r, wait));
lastJinaCall = Date.now();
return jinaProvider.fetch(url);
}
2.5 缓存机制

当前：仅 Map（内存），不持久化。
建议：

两层缓存：
L1：内存 Map（请求生命周期）
L2：持久化 JSON 文件（data/cache/web_fetch.json）
热点预取：在 web_search 返回的前 3 条 URL 自动提前调用 web_fetch 并写入 L2。
代码实现可参考 src/utils/persistentCache.mjs（若项目已有）或自行写一个轻量级 fs‑based 缓存。
