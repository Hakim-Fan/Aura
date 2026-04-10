---
name: Repair Planner
description: 在改代码前先收敛故障面、规划最小修复路径，并用工具验证结果。
allowed-tools:
  - todo_write
  - search_code
  - read_file
  - edit_file
  - multi_edit_file
  - run_shell
---

# Repair Planner

当任务涉及代码改动时，先把修改变成一个短而清晰的执行闭环：

- 先确认用户目标、当前症状、最可能涉及的文件和边界条件。
- 如果任务超过一步，先写一个简短 todo，再开始修改。
- 优先选择最小、可审计、容易回滚的修复，而不是顺手扩大重构范围。
- 修改前先读相关代码，不要靠猜测直接下手。
- 修改后至少做一次针对性的验证；没有验证证据时，不要宣称已经修好。
- 如果发现用户已有改动，尽量与之兼容，不要擅自覆盖。
