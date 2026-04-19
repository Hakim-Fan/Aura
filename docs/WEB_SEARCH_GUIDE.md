# OpenClaw 网络信息获取技术全景文档

本文档详细介绍了 OpenClaw 项目如何通过插件化架构实现高效、安全且灵活的网络搜索 (`web-search`) 与网页内容获取 (`web-fetch`)。

---

## 1. 核心架构：三层解耦模型

OpenClaw 的设计哲学是将“意图触发”与“具体实现”完全分离。其获取网络信息的流程分为以下三层：

### A. 调度层 (Orchestration Layer)
**核心文件**：`src/web-search/runtime.ts`, `src/web-fetch/runtime.ts`
*   **功能**：作为系统的“大脑”。当 LLM 决定需要搜索或抓取网页时，调度层负责从插件池中挑选最合适的供应商。
*   **策略**：支持 **自动探测（Auto-Detect）**。例如，如果环境变量中有 `TAVILY_API_KEY`，系统优先选 Tavily；如果没有，则自动降级到 DuckDuckGo。

### B. 插件层 (Extensions/Provider Layer)
**核心目录**：`extensions/`
*   **功能**：具体的“执行手”。每个插件对接一个具体的外部服务。
*   **典型实现**：
    *   **DuckDuckGo** (`extensions/duckduckgo`)：无需 API，通过解析 HTML 无脚本页面获取信息。
    *   **Firecrawl** (`extensions/firecrawl`)：专业的爬虫服务，负责将复杂的动态网页处理成干净的 Markdown。
    *   **Brave/Tavily/Exa**：通过官方 API 获取高度结构化的搜索数据。

### C. 基础设施层 (Infrastructure & Security Layer)
**核心文件**：`src/infra/net/fetch-guard.ts`, `src/security/external-content.ts`
*   **功能**：提供底层的网络支持和安全屏障。
*   **网络卫士 (Fetch Guard)**：防止 SSRF（服务端请求伪造）攻击，并自动处理系统配置的 HTTP 代理。
*   **安全包装**：将抓取到的内容用特殊的安全标签包裹，防止网页中的恶意文本误导 AI。

---

## 2. 网页搜索 (`web-search`) 深度解析

### 2.1 搜索流程
1.  **触发**：LLM 调用名为 `web_search` 的工具。
2.  **路由**：`resolveWebSearchProviderId` 根据配置选择插件。
3.  **执行**：
    *   如果是 **DuckDuckGo**：
        1. 请求 `https://html.duckduckgo.com/html?q=XXX`。
        2. 使用正则（Regex）提取标题、链接和摘要。
        3. 检查是否触发了人机验证（Bot Challenge）。
    *   如果是 **API 供应商**：发送带有认证 Token 的 POST 请求。
4.  **缓存**：结果会被序列化并存储在 `SEARCH_CACHE` (Map) 中，默认缓存 60 分钟以节省流量并加速响应。

### 2.2 搜索工具特征
| 供应商 | 优势 | 局限 |
| :--- | :--- | :--- |
| **DuckDuckGo** | 完全免费，无需 API Key | 易触发机器人拦截，解析相对脆弱 |
| **Brave Search** | 速度快，有专业的 Web API | 免费额度有限 |
| **Tavily** | 为 AI 优化，自带内容提取 | 依赖第三方服务状态 |

---

## 3. 网页获取 (`web-fetch`) 深度解析

### 3.1 获取流程
1.  **触发**：LLM 调用 `web_fetch` 工具并传入 `url`。
2.  **供应商匹配**：通常由 `firecrawl` 负责，也可以由本地 `browser` 扩展执行。
3.  **内容提取**：
    *   **Markdown 模式**：通过 Firecrawl 将 HTML 转换为 Markdown（去除导航栏、底部信息、广告）。
    *   **Text 模式**：仅提取纯文本。
4.  **字符限制**：通过 `maxChars` 参数进行截断，防止内容过载导致 LLM 记忆溢出。

---

## 4. 安全与性能保障

### 4.1 SSRF 与代理保护
所有网络请求均通过 `fetchWithSsrFGuard` 执行：
*   **禁止私有网络**：默认禁止访问 `127.0.0.1` 或 `192.168.*`，防止 AI 被诱导攻击公司内网。
*   **代理转发**：自动识别系统环境变量中的 `HTTP_PROXY`，确保在受限网络环境下依然能稳定工作。

### 4.2 外部内容包装 (Security Wrapping)
为了防止 **提示词注入（Prompt Injection）**，获取到的网页内容会通过 `wrapWebContent` 函数处理：
```text
<external_content source="web_search" provider="duckduckgo">
... 网页真实内容 ...
</external_content>

---

# OpenClaw 深度解析：如何绕过拦截获取 DuckDuckGo 搜索信息

如果你直接请求 `duckduckgo.com`，你 99% 的概率会失败，因为现代 DDG 页面是高度依赖 JavaScript 的单页应用（SPA），且带有极强的机器人指纹检测。

OpenClaw 成功的关键点如下：

---

### 1. 核心秘诀：使用“无脚本”终端 (Non-JS Endpoint)
**代码参照**：`extensions/duckduckgo/src/ddg-client.ts` 中的 `DDG_HTML_ENDPOINT`。

*   **错误地址**：`https://duckduckgo.com` (需要运行 JS 才能看到结果)
*   **正确地址**：`https://html.duckduckgo.com/html`
*   **原理**：这是 DDG 为古老浏览器或低网速环境保留的“纯 HTML”版本。它不包含任何混淆逻辑，搜索结果直接就在 HTTP 返回的初始 HTML 源码中。

### 2. 伪装头信息 (Header Spoofing)
DDG 会检查 `User-Agent`。如果你的 UA 包含 `node-fetch`, `python-requests` 或为空，会被秒封。
OpenClaw 强制使用了一个真实的**桌面级浏览器指纹**：
```typescript
{
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
}
