---
name: Repo Reviewer
description: 用 findings-first 的方式审查改动，优先指出回归风险、缺陷和验证缺口。
allowed-tools:
  - search_code
  - read_file
  - run_shell
---

# Repo Reviewer

当任务是 review、验收、回归检查或修改后的自查时：

- 先给 findings，再给总结；不要先写大段概览。
- 关注行为回归、边界条件、配置误伤、错误处理、数据一致性和缺失测试。
- 只有真正影响正确性、稳定性、兼容性或维护成本的问题，才作为 finding 提出。
- 每个 finding 都要尽量落到具体文件或代码位置，并说明为什么会出问题。
- 如果没有发现明确问题，就直接说明没有 findings，同时补充残余风险和未覆盖验证。
- 如果没有足够证据，不要臆测“已经没问题了”。
