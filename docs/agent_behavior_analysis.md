# Agent 工具调用行为深度分析报告

## 1. 现象描述
用户反馈 Agent 在处理任何问题（即使是通用的 Git 报错）时，都会优先尝试调用外部工具（如无头浏览器），而非直接利用 LLM 的内建知识进行回答。

## 2. 核心死循环逻辑分析
经过代码审计，我们发现系统中存在一套“逻辑闭环”，强制 Agent 走向了工具依赖。

### 2.1 物理约束：强制证据政策 (Evidence Policy)
在 `bridge/agent.mjs` 中定义的 `enforceEvidencePolicy` 函数是“元凶”之一。

- **逻辑**：如果系统判断当前任务是“操作型”任务（由关键词 `fix`, `repair`, `修复` 等触发），但 Agent 在回答时没有调用任何工具 (`toolEvents.length === 0`)，且回答中包含“已完成”、“修复了”等词汇，系统会**强制拦截** Agent 的原始回答。
- **后果**：Agent 的内容会被替换为：“我还没有执行任何工具，所以现在不能确认……我需要先运行相应工具”。这迫使 Agent 在下一次生成时必须寻找工具来“交差”。

### 2.2 信号误判：过于敏感的特征提取
在 `bridge/capabilitySelector.mjs` 中，任务类型的判定逻辑过于简单。

- **逻辑**：`isResearchTask` 被定义为包含 `docs`, `documentation`, `查询`, `查一下`, `资料`, `文档` 等关键词。
- **现象**：当用户问“Git 报错如何修复”时，问题天然包含了“修复（isEditingTask）”和可能的“查一下文档（isResearchTask）”意念。
- **权重失衡**：一旦命中 `isResearchTask`，无头浏览器工具组 (`advanced:browser-runtime`) 会获得 **+8** 的额外加分，使其在工具列表中脱颖而出。

### 2.3 心理暗示：System Prompt 的强烈诱导
在 `bridge/agent.mjs` 的 `buildSystemPrompt` 中，Agent 被灌输了以下思维准则：

- **反抽象建议**：`"Prefer concrete changes and verification steps over abstract advice."`（比起抽象建议，更倾向于具体的改动和验证步奏）。
- **工具优先权**：`"Prefer browser_* tools for normal web tasks."`。
- **信任门槛**：`"Do not say that something is done... unless tool output gives direct evidence."`（除非工具输出了直接证据，否则不要说事儿做完了）。

## 3. 典型案例链路还原
1. **用户输入**：“我 Git 提交报错了，帮忙修复下”。
2. **能力选择器**：检测到 `修复/git/fix` 关键词 -> 判定为 `isEditingTask` 和 `isGitTask`。
3. **工具分发**：给予模型 `browser_*`（因 Research 权重高）和 `git-helper`（如果有）。
4. **模型思维**：
   - “我想直接告诉他用 `git push --force`，但是系统告诉我‘不要给抽象建议’。”
   - “系统还说‘没用工具不要说大话’。”
   - “正好我手头有一个 `browser_google_search` 工具，我得用一下它来证明我‘努力过了’。”
5. **最终表现**：Agent 开启浏览器去搜索那个它早就知道答案的 Git 错误。

## 4. 改进建议
1. **引入“知识回答”快速通道**：在 `enforceEvidencePolicy` 中增加逻辑，如果意图属于知识咨询类，即便不调用工具也允许回答。
2. **优化信号权重**：降低 `isResearchTask` 对重型工具（浏览器）的初始加分，增加本地工具（文件读写/Git 插件）的优先级。
3. **调整 Prompt 语气**：将 `Prefer tools` 改为 `Check internal knowledge first; use tools only if internal knowledge is insufficient`（先检查内建知识；如果不足再用工具）。
