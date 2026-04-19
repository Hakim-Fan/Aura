# DuckDuckGo 搜索失败原因剖析

我们在最新测试中发现，DuckDuckGo 对所有非浏览器环境的请求（无论是 `/html/` 还是 `/lite/` 端点）启用了**强制的图像验证码拦截（Bot Challenge）**。

返回的 HTML 源码片段如下：
```html
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
<div class="anomaly-modal__instructions">Select all squares containing a duck:</div>
```

这就是为什么代码没报错，但大模型却总是说“找不到结果”：它抓取到的根本不是搜索结果，而是这个选鸭子的验证码页面。

## 连锁反应与真正问题

更要命的是由我们在 Review 报告中提到的 **P0 级 Bug** 引起的连锁反应：
因为 `invokeTool` 没有正确把 `settings` 注入到 `runtime` 里面，导致 Agent 即使在 UI 里配置了 Tavily 或者 Brave，底层工具层在运行时依然**读不到 API Key**。

读取不到 API Key，系统就会认为专业搜索 API 未配置，从而**强制 fallback 回 DuckDuckGo**，接着撞上验证码拦截，导致搜索功能在宏观表现上“完全不可用”。
