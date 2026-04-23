# Retrieval Providers

This directory documents the internal backends used by the local retrieval runtime.

Current principles:

- `web_search`, `web_fetch`, and `web_research` stay stable as the model-facing tool names.
- Backend selection is runtime-owned. Models should not have to reason about provider wiring.
- Retrieval failures stay inside the retrieval lane. They do not automatically escalate into the system browser.
- Browser interaction remains a separate capability for explicit login, clicking, form submission, CAPTCHA, or other manual flows.

Current backend families:

- Search providers such as Tavily, Brave, and DuckDuckGo.
- Direct HTTP readability extraction.
- Lightpanda-backed page reading when available.
- Jina Reader fallback when configured and useful.

Expected future work:

- Add richer per-provider health metrics beyond the current session-level cooldown memory.
- Add provider-specific debug traces for evidence inspection.
- Add richer caching and ranking telemetry for `tool_search` and retrieval operations.
