# 项目内长期记忆与 Memory Agent 设计

本文记录 Aura 项目内长期记忆的第一版设计。目标是简单、直接、可落地，不做复杂记忆系统。

## 1. 目标

项目记忆只服务当前项目，帮助 Agent 在后续任务中更快理解：

- 项目结构和关键模块
- 已解决过的难题和处理经验
- 用户在当前项目里的偏好
- 常见故障、坑点和排查方法
- 重要技术决策

它不是完整聊天记录，也不是所有文件索引。它应该是一组短而准的总结文件。

## 2. 记忆文件

建议放在项目目录下：

```text
.aura/memory/
  project.md
  decisions.md
  troubleshooting.md
  preferences.md
  sessions/
    2026-06-04-memory-agent.md
```

记忆目录默认写入项目 `.gitignore`：

```text
.aura/memory/
```

第一版记忆是本机私有数据，不应该提交到项目仓库，也不作为团队共享上下文。

各文件职责：

- `project.md`：项目整体摘要，包括技术栈、目录结构、核心运行方式。
- `decisions.md`：重要设计决策，记录为什么这么做。
- `troubleshooting.md`：踩坑、错误、修复方式、验证命令。
- `preferences.md`：用户偏好，比如文档风格、实现偏好、不要做的事。
- `sessions/`：阶段性任务总结，只存有价值的任务复盘，不直接当作常规上下文拼接。

写入语言跟随 Aura 当前语言设置。例如当前运行语言是简体中文，记忆文件内容也应写成简体中文。

## 3. 什么时候更新记忆

不需要每轮都更新。第一版只在两个场景更新：

- 用户明确要求当前任务就是更新、保存、删除或整理项目记忆。
- 当前会话没有继续任务，持续空闲达到设置页配置的阈值后，静默做一次增量总结。

不再把“普通任务完成”直接作为更新触发。复杂 bug、架构问题、环境问题、偏好表达、排查经验等内容，只有在显式记忆任务或空闲总结时被提取。

空闲阈值是全局设置项，默认开启长期记忆，默认阈值可在设置页调整。

简单策略：

```text
任务结束
  -> 原始数据写入 DB
  -> project_memory_sources 标记对应 message/version/tool/task_result 为 pending
  -> 重置当前项目 idle timer
  -> 如果 idle timer 到达阈值且用户没有继续任务
  -> 创建 project_memory_jobs
  -> organizer 从 DB 读取 pending/stale/deleted sources
  -> 更新对应 markdown 文件
  -> source 标记 consolidated 或 skipped
```

显式更新记忆时，不等待 idle timer，立即走同一套受限写入路径，并在工具调用内等到写入完成后再返回。

## 3.1 数据来源

不使用 `work_memory` 作为项目长期记忆来源。

项目记忆整理只依赖已有 DB 原始数据和一张轻量状态表：

```text
project_memory_sources
  id
  workspace_root
  session_id
  source_type        message | message_version | tool_event | task_result
  source_id
  source_version
  source_updated_at
  memory_status      pending | extracted | consolidated | stale | deleted | skipped
  extracted_at
  consolidated_at
  last_error

project_memory_jobs
  id
  workspace_root
  status             pending | running | done | failed
  reason             idle | manual | retry
  input_watermark
  output_watermark
  started_at
  finished_at
```

真实内容仍然从已有表读取：

- `messages`
- `message_versions`
- `message_event_details`
- `agent_runs`

`project_memory_sources` 只记录“哪些原始数据需要整理、是否已整理”，不复制大段内容。

消息重答、工具事件更新、任务结果更新时，对应 source 回到 `pending`。消息或版本删除时，对应 source 变成 `deleted`，organizer 下次会把它当作修正信号处理。

## 4. 更新什么

下次有新任务、新数据或过几天继续工作时，只更新变化部分。

示例：

- 新增架构决策：追加到 `decisions.md`
- 新增踩坑经验：追加到 `troubleshooting.md`
- 用户表达偏好：更新 `preferences.md`
- 项目结构变化：更新 `project.md`
- 一次复杂任务完成：新增一份 `sessions/YYYY-MM-DD-xxx.md`

不要把普通对话、临时想法、无结论分析都写进去。

## 5. 每次提问拼接什么

每次用户提问时，不应该把全部记忆都塞进提示词。

默认拼接：

- 不默认拼接全部长期记忆。
- 主 agent 自行判断是否需要项目记忆。
- 如果需要，调用 `spawn_memory_agent` 静默派发异步记忆查询子 agent。

按需拼接：

- 当前问题像设计/架构问题时，摘取 `decisions.md` 相关片段。
- 当前问题像报错/排查问题时，摘取 `troubleshooting.md` 相关片段。
- 当前问题明显延续旧任务时，摘取对应 `sessions/` 片段。

最终提示词可以类似：

```text
<project_memory>
项目摘要：
...

用户偏好：
...

相关历史决策：
...

相关排查经验：
...
</project_memory>

<current_user_request>
用户本轮问题
</current_user_request>
```

## 6. Memory Agent 执行模式

记忆检索适合采用 Codex 式后台异步模式。

流程：

```text
用户提问
  -> 主 agent 开始执行任务
  -> 主 agent 判断可能需要项目记忆
  -> 派发 memory agent
  -> spawn_memory_agent 立即返回 memory_task_id
  -> 主 agent 继续处理当前任务
  -> project_memory_retriever 后台检索和总结相关记忆
  -> 完成后写入 mailbox / pending_context
  -> 主 agent 下一次模型调用前合并记忆结果
```

重点：

- `spawn_memory_agent` 不应该阻塞主 agent。
- memory agent 查完后不直接插入正在生成的 token 流。
- 记忆结果进入 mailbox，等 provider 工具调用后的下一次 LLM request 或外层 agent 下一次 pass 统一拼接。
- 如果当前任务没有再次调用模型，结果留到下一轮用户请求时使用。
- `spawn_memory_agent` 是模型可见但用户静默的内部工具；普通执行时间线不展示，只保留 runtime log 和数据记录。
- 子 agent 内不再暴露 memory agent，避免递归派发。

记忆整理采用 Claude 式后台异步模式：

- 用户明确要求更新/保存/记住/忘记项目记忆时，主 agent 调用 `update_project_memory`，并等待本次整理写入完成。
- `update_project_memory` 不直接整理和写入完整记忆，而是创建 `project_memory_jobs`，再运行 `project_memory_organizer`。
- 空闲阈值触发时，同样只触发 job，不携带整段会话临时内存。
- `project_memory_organizer` 读取 DB 中 `pending/stale/deleted` sources 的真实内容，生成增量草稿。
- `project_memory_organizer` 生成结构化增量草稿，宿主进程再按固定文件结构受控追加到 `.aura/memory/**`。
- `project_memory_organizer` 完成后本次整理即结束；失败只记录日志，不打断前台任务。

Memory agent 权限需要按 Claude 自动记忆的方式收紧：

- 第一版 `project_memory_retriever` / `project_memory_organizer` 不暴露普通工具，由宿主进程提供受控的 `.aura/memory/**` 快照和当前会话摘要。
- 写入由宿主进程执行，只允许写入 `.aura/memory/**` 和必要的 `.gitignore` 记忆忽略规则。
- 禁止普通 shell 写入、安装、网络、MCP、插件工具、浏览器、电脑控制和再次派发子 agent。
- 写入必须尊重用户手工编辑，采用增量合并，不整文件覆盖。
- 后台失败只记录日志，不打断前台任务。

模型设置：

- 长期记忆默认使用当前会话/当前项目模型。
- 设置页支持为长期记忆单独指定一个全局模型，不需要每个项目重复设置。
- 如果独立模型不可用，回退到当前会话模型；如果模型调用失败，后台更新静默失败并记录日志。

项目开关：

- 长期记忆功能默认开启。
- 设置页提供全局开关。
- 每个项目可以单独关闭，关闭后该项目不检索、不更新 `.aura/memory/`。

## 7. 如何避免重复派发

需要运行时做去重，不只依赖模型自觉。

建议维护一个 memory retrieval registry：

```text
key = project_id + turn_id + normalized_user_request

value:
  status: pending | done
  memory_task_id
  result
  injected: true | false
```

规则：

- 如果同一个 key 已经 `pending`，不要再次派发 memory agent。
- 如果已经 `done` 且 `injected = false`，下次模型调用前拼接结果，并标记 `injected = true`。
- 如果已经 `done` 且 `injected = true`，不要重复拼接。
- 如果用户开启新任务，可以生成新的 key。

## 8. 第一版边界

第一版先不做：

- 全局跨项目记忆
- 向量数据库
- 全量聊天记录检索
- 自动学习所有用户行为
- 多层复杂记忆权限
- 测试/调试专用的手动记忆工具按钮

先把项目内 markdown 记忆、异步 memory agent、mailbox 合并、去重注入跑通。
