# Aura v2.2.0 更新说明

本次更新重点落在项目内长期记忆：新增项目记忆检索与整理 Agent，改造记忆整理的数据来源和任务状态，并把项目级记忆开关移动到会话顶部状态栏。

## 项目长期记忆

- 新增项目内长期记忆目录：`.aura/memory/`，包含 `project.md`、`decisions.md`、`troubleshooting.md`、`preferences.md` 和 `sessions/`。
- 记忆目录默认写入 `.gitignore`，只保存在本机当前项目中，不作为团队文件提交。
- 支持模型在需要时静默调用 `spawn_memory_agent` 检索项目记忆，结果会在后续模型调用前按需注入。
- 支持用户明确要求时调用 `update_project_memory` 整理项目记忆，并将整理结果增量追加到本地记忆文件。

## Memory Agent

- 将两个记忆子 Agent 重新命名，降低混淆：
  - `project_memory_retriever`：任务中查询项目记忆。
  - `project_memory_organizer`：整理和写入项目长期记忆。
- 记忆检索采用异步 mailbox 机制，主 Agent 发起查询后继续执行，结果完成后再注入后续模型调用。
- 显式更新项目记忆时，`update_project_memory` 会等待 organizer 完成写入后再返回，避免任务结束导致后台整理被中断。
- 限制记忆子 Agent 的工具暴露，避免记忆任务递归派发或执行无关工具。

## 记忆数据源与任务状态

- 新增 `project_memory_sources`，用于记录哪些原始数据需要整理，以及当前整理状态。
- 新增 `project_memory_jobs`，用于记录每次记忆整理任务的开始、结束、原因和水位。
- 记忆整理不再依赖临时内存中的整段会话数据，也不再使用 `work_memory` 作为长期记忆来源。
- organizer 会从 DB 中读取 `messages`、`message_versions`、`message_event_details`、`agent_runs` 等真实数据源，再生成增量记忆草稿。
- 消息重答、工具事件更新、任务结果更新后，对应 source 会重新进入待整理状态。
- 删除或过期的数据会以 `deleted` / `stale` 状态进入整理流程，方便后续写入修正信息。

## 会话顶部记忆状态栏

- 将项目级记忆开关从全局设置页移动到会话顶部状态栏。
- 顶部状态栏新增 `开启记忆` / `关闭记忆` 状态按钮。
- 点击状态按钮可查看：
  - 当前项目记忆路径。
  - 最新整理时间。
  - 最近整理任务状态。
  - 待整理 source 数量。
  - 当前项目记忆开关。
- 支持从弹框直接打开 `.aura/memory/` 目录。
- 全局设置页保留长期记忆总开关、空闲阈值和记忆模型；单个项目开关改由会话上下文管理。

## 稳定性修复

- 修复后台 organizer 在 bridge 进程退出后被中断，导致记忆文件只有空壳、DB job 一直停留在 `running` 的问题。
- 修复 session `workspace_root` 与实际工作区路径不一致时，消息 source 无法同步到项目记忆整理流程的问题。
- 查询项目记忆状态时，会自动将超时的旧 `running` job 标记为 `failed`，避免状态栏长期显示整理中。
- 对项目记忆文件写入增加串行队列，避免多个整理任务并发写入时互相覆盖。
- idle 更新判断会读取记忆 metadata，避免短时间内重复触发整理。
