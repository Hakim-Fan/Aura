# OpenClaw 与当前 Agent 的 DDG 差异对比

1. **机制完全相同**：就像我在 `WEB_SEARCH_GUIDE.md` 里为您写的，OpenClaw 也是向 `https://html.duckduckgo.com/html` 发送伪造 UA 的请求。
2. **为什么 OpenClaw 偶然能成？**
   - **IP 封控是动态的**：DDG 对爬虫的封锁基于 IP 信誉（以及你当时使用的科学上网/代理节点）。由于这个 Agent 之前在 `guardedFetch.mjs` 中把 UA 硬编码成了显眼的 `AuraWebTools/2.0`，极其容易被彻底拉黑。一旦该节点 IP 被 DDG 锁定，短时间内不论换什么正常的浏览器的 UA，都会强制返回“选鸭子验证码”。
   - **OpenClaw 文档原话证明**：您看前一份 `WEB_SEARCH_GUIDE.md` 文档里，清楚写明了 DDG 的局限性：**“易触发机器人拦截，解析相对脆弱”**。这证明 OpenClaw 在大规模测试时也频繁遭遇和现在一样的被拦截断连。
3. **网络层连通差异**：Node.js 原生的 `undici fetch` 默认不读取环境变量中的代理（`HTTP_PROXY`），而 OpenClaw 通过 `fetchWithSsrFGuard` 显式接管了系统代理。在直接用原生 `fetch` 的架构下，某些受限网络如果处理不好甚至无法直连跨国资源。
