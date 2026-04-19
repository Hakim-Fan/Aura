---
name: Web Research
description: 在研究、最新信息、新闻、文档、行情、公司动态和事实核查任务中，优先使用 web_search / web_fetch，而不是直接打开浏览器页面。
allowed-tools:
  - web_research
  - web_search
  - web_fetch
  - browser_search
  - browser_open
  - browser_get_page
  - browser_snapshot
---

# Web Research

当任务是“查资料、找来源、看新闻、读官方文档、核对最新动态、整理公司利好利空、查询股票或行业信息”时：

- 优先考虑 `web_research`，特别是当你希望一次调用就拿到候选来源、正文证据和引用编号时。
- 先用 `web_search` 找候选来源，不要一上来就用浏览器工具。
- 如果需要偏向某些站点，优先使用 `web_search.domains` 传 `reddit.com`、`news.ycombinator.com` 这类域名。`site:`、引号短语、`intitle:` 这类搜索语法可以兼容，但不如结构化字段稳定、可迁移。
- 从搜索结果里挑最相关、最可信的 1 到 3 个链接，再用 `web_fetch` 读取正文、摘要或元信息。
- `web_search` 负责“发现来源”；`web_fetch` 负责“读取网页内容”；`web_research` 负责“把发现 + 读取 + 初步证据整理打包成一步”。
- `web_search` 默认会自动尝试多个无 key 搜索 provider；如果一个 provider 没结果，不代表整个方向没结果。
- 如果一次搜索已经拿到足够候选来源，优先转去 `web_fetch` 或直接总结，不要默认把搜索预算用完。
- 如果连续两次搜索都没有结果，说明当前方向增益很低，应该换思路或诚实说明“没有找到足够公开信息”，而不是继续机械改写 query。
- 如果只是需要最新信息、公开网页正文或文档内容，默认停留在 `web_*` 路径。
- 只有出现以下情况才切到 `browser_*`：用户明确要求用浏览器、设置里允许 Web Research 最终浏览器兜底、页面需要登录、验证码、人机校验、必须点击/滚动/交互后才能看到内容。
- `web_fetch` 返回页面需要浏览器时，再切 `browser_open` 或其他 `browser_*`，不要提前拉起浏览器。
- 如果 `web_research` 明确返回 `browserFallbackSuggested`，再决定是否升级到 `browser_search` 或 `browser_open`。
- 输出结论时优先综合多条来源，不要只复述某一个搜索摘要。
- 对“今天 / 最新 / 最近 / 当前”这类时间词，按运行时当前日期理解，不要凭模型记忆猜。
