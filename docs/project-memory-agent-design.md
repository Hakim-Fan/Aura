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

各文件职责：

- `project.md`：项目整体摘要，包括技术栈、目录结构、核心运行方式。
- `decisions.md`：重要设计决策，记录为什么这么做。
- `troubleshooting.md`：踩坑、错误、修复方式、验证命令。
- `preferences.md`：用户偏好，比如文档风格、实现偏好、不要做的事。
- `sessions/`：阶段性任务总结，只存有价值的任务复盘，不直接当作常规上下文拼接。

## 3. 什么时候更新记忆

不需要每轮都更新。第一版只在一段时间没有更新时做总结。

建议触发条件：

- 当前任务完成后，距离上次记忆更新超过一定时间。
- 当前任务解决了复杂 bug、架构问题、环境问题。
- 用户明确表达了项目偏好或工作方式。
- 出现了可复用的排查经验。

简单策略：

```text
任务结束
  -> 检查 .aura/memory/metadata.json
  -> 如果 last_updated 距今超过阈值
  -> 启动 memory summary
  -> 更新对应 markdown 文件
```

阈值可以先设半天不活跃并且有新增内容的时候更新。

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

- `project.md` 的简短摘要
- `preferences.md` 的相关偏好

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
  -> memory agent 立即返回 memory_task_id
  -> 主 agent 继续处理当前任务
  -> memory agent 后台检索和总结相关记忆
  -> 完成后写入 mailbox / pending_context
  -> 主 agent 下一次模型调用前合并记忆结果
```

重点：

- `spawn_memory_agent` 不应该阻塞主 agent。
- memory agent 查完后不直接插入正在生成的 token 流。
- 记忆结果进入 mailbox，等下一次 LLM request 统一拼接。
- 如果当前任务已经结束，结果留到下一轮用户请求时使用。

## 7. 如何避免重复派发

需要运行时做去重，不只依赖模型自觉。

建议维护一个 memory lookup registry：

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

先把项目内 markdown 记忆、异步 memory agent、mailbox 合并、去重注入跑通。
