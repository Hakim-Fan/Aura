---
name: Aura Browser Operator
description: 在网页搜索、页面读取、无头浏览器交互、截图验证、登录阻塞和接管场景中，优先使用 Aura 的 browser_* 工具，并用 snapshot-first、action-then-verify 的方式完成任务。
allowed-tools:
  - browser_open
  - browser_search
  - browser_get_page
  - browser_snapshot
  - browser_run_javascript
  - browser_screenshot
  - browser_click
  - browser_type
  - browser_wait_for
  - browser_inspect_element
  - browser_list_sessions
  - browser_set_active_session
  - browser_close_session
  - browser_storage_list
  - browser_storage_get
  - browser_storage_set
  - browser_storage_clear
  - browser_storage_export_state
  - browser_storage_import_state
  - browser_console_get
  - browser_network_get
  - browser_trace_start
  - browser_trace_stop
  - browser_video_start
  - browser_video_stop
  - browser_takeover_visible
  - browser_resume_after_takeover
  - chrome_open_url
  - chrome_get_active_tab
  - chrome_run_javascript
---

# Aura Browser Operator

当任务涉及网页浏览、页面交互、页面验证、截图取证或需要继续使用 Aura 浏览器运行时时：

- 默认优先使用 `browser_*` 工具，不要把 shell、`npx` 或外部 CLI 当成主路径。
- 只有用户明确要求操作系统 Chrome，或 Aura 浏览器运行时不可用且允许降级时，才考虑 `chrome_*`。
- 先观察、再操作、再验证：推荐闭环是 `browser_open` / `browser_search` -> `browser_snapshot` 或 `browser_get_page(format=snapshot)` -> `browser_click(ref=...)` / `browser_type(ref=...)` -> `browser_wait_for` -> 再次 `browser_get_page`、`browser_inspect_element` 或 `browser_screenshot`。
- 在页面状态还不清楚时，不要凭猜测连续点击多个 selector。先重新读取页面内容，必要时用 `browser_run_javascript` 提取更具体的 DOM 线索。
- 如果 snapshot 里已经有稳定 `ref`，优先用 `ref` 而不是继续猜 CSS selector。
- 每次关键操作后都要验证页面是否真的推进了：URL、标题、正文、目标文案、截图或脚本返回值至少要有一个能证明动作生效。
- 如果只是为了确认页面状态，优先用 `browser_get_page`；如果需要给用户看可见结果，补 `browser_screenshot`。
- `browser_run_javascript` 只做针对性探查：读取特定元素文本、属性、URL、页面状态或少量结构化结果；不要一次返回大块无边界 HTML。
- 当前运行时已经支持 `browser_list_sessions` / `browser_set_active_session` / `browser_close_session`；需要并行网页流程、切换登录态或保留上下文时，优先显式管理 session，而不是把所有操作都塞进一个隐式当前页。
- 需要解释失败原因时，优先补 `browser_console_get`、`browser_network_get`、`browser_storage_list` 或 `browser_storage_get`，让结论建立在可复查证据上；需要进一步取证时再显式开启 `browser_trace_start` / `browser_video_start`，结束后记得 `browser_trace_stop` / `browser_video_stop` 落盘。
- 需要复用登录态或恢复会话时，优先使用 `browser_storage_export_state` / `browser_storage_import_state`，针对局部修复再用 `browser_storage_set` / `browser_storage_clear`。
- 遇到登录、2FA、验证码、权限确认、人机校验或明显需要人工继续的流程时，直接说明阻塞原因，并切到 `browser_takeover_visible`，不要假装已经自动完成。
- 用户接管结束后，用 `browser_resume_after_takeover` 回到默认模式，并重新读取页面确认会话和状态已经延续。
- 如果连续两次操作都没有带来新状态，不要继续机械重试；先收束当前证据，说明卡点，再决定是否换路径或请求用户参与。
- 对“已经完成”“已经提交”“已经登录成功”这类结论保持克制，没有验证证据时只能描述“已尝试了什么”和“当前看到什么”。
