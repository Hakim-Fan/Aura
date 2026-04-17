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

### 2.3 暴露粒度过粗：命中一个弱信号就暴露整组工具
在 `bridge/capabilitySelector.mjs` 的 `selectTurnCapabilities` 中，工具是按“组”暴露的，而不是按“单个工具”暴露的。

- **逻辑**：只要某个工具组 `score > 0`，就会把这一组里的全部工具加入本轮上下文。
- **后果**：浏览器组一旦被命中，不只是 `browser_search`，而是 `browser_open`、`browser_click`、`browser_type`、`browser_takeover_visible` 等整套能力都会被同时暴露给模型。
- **缺陷**：当前没有阈值、没有 Top-K、没有“先轻后重”的二次筛选，也没有把“搜索网页”和“操作网页”拆成两个不同等级的能力。

### 2.4 心理暗示：System Prompt 的强烈诱导
在 `bridge/agent.mjs` 的 `buildSystemPrompt` 中，Agent 被灌输了以下思维准则：

- **反抽象建议**：`"Prefer concrete changes and verification steps over abstract advice."`（比起抽象建议，更倾向于具体的改动和验证步骤）。
- **工具优先权**：`"Prefer browser_* tools for normal web tasks."`。
- **信任门槛**：`"Do not say that something is done... unless tool output gives direct evidence."`（除非工具输出了直接证据，否则不要说事儿做完了）。
- **更隐蔽的问题**：这些浏览器相关指令是按 `settings.browser.enabled` 写入 Prompt 的，而不是按“本轮是否真的挂载了 browser_* 工具”写入。这会造成 Prompt 层面持续暗示模型优先想到浏览器，即使本轮真正相关的只是本地 shell / 文件 / Git。

### 2.5 意图维度缺失：没有区分“给建议”还是“替我执行”
在 `bridge/agent.mjs` 中，`taskNeedsExecution` 使用的是一套较宽的关键词启发式：

- **逻辑**：只要命中 `fix`, `update`, `edit`, `run`, `修复`, `修改`, `运行` 等词，就更容易被视为“需要执行”的任务。
- **问题**：这套判断只对少数问句模式做了豁免，比如 `what is`, `why`, `请问`, `我想知道`。但像“帮我看看这个 Git 报错怎么修复”“先分析下原因”这类真实用户表达，往往既包含“修复”词，又本质上更接近“诊断/建议”。
- **后果**：任务会过早进入“必须有工具证据”的轨道，导致原本可以直接回答的问题被误判为必须先执行。

### 2.6 缺少前置直答阶段：所有任务都直接进入工具增强回路
在 `bridge/providers.mjs` 中，模型是带着当前选中的 `tools` 直接进入主循环的，且 OpenAI 兼容接口使用的是 `tool_choice: 'auto'`。

- **逻辑**：系统没有一个显式的“先尝试无工具回答，再决定是否开工具”的前置阶段。
- **后果**：一旦工具被挂载，模型从第一轮开始就处于“可以也应该调用工具”的环境中。
- **连锁反应**：这会放大前面几个问题的影响。也就是说，真正的问题不是某一条 Prompt 或某一个关键词，而是“任务进入模型前就没有被分流”。

### 2.7 根因总结：不是单点 Bug，而是三层叠加
综合代码路径，当前行为更像是以下三层共同作用的结果：

1. **路由层**：弱启发式把太多任务判进了研究 / 执行 / 浏览器相关路径。
2. **暴露层**：一旦命中就整组挂载工具，而且缺少轻重分层。
3. **生成层**：Prompt 和证据策略继续强化“先用工具再回答”的倾向。

因此，原问题分析的方向是正确的，但如果只盯着 `enforceEvidencePolicy`，会低估上游“工具暴露”和“意图分流缺失”这两个更根本的原因。

## 3. 典型案例链路还原
1. **用户输入**：“我 Git 提交报错了，帮忙修复下”。
2. **执行意图判定**：`taskNeedsExecution` 因“修复”等词把任务偏向“需要执行”的方向。
3. **能力选择器**：检测到 `修复/git/fix` 关键词 -> 判定为 `isEditingTask` 和 `isGitTask`。如果用户表达里还带有“查一下”“文档”“最新方案”等字样，则进一步触发 `isResearchTask`。
4. **工具分发**：如果 Research 信号被触发，`browser_*` 整组工具会被暴露；即便未触发，Prompt 里仍可能存在浏览器优先的长期暗示。
5. **模型思维**：
   - “我其实可以先解释报错原因和常见修复路径，但是系统告诉我‘不要给抽象建议’。”
   - “系统还说‘没用工具不要说大话’。”
   - “如果我已经看到了 `browser_search` / `browser_open` 这类工具，先调一下最稳妥。”
6. **最终表现**：Agent 很容易开启浏览器去搜索一个它本可以先直接给出初步答案的 Git 错误。

## 4. 改进建议
1. **引入“知识回答”快速通道**：在 `enforceEvidencePolicy` 中增加逻辑，如果意图属于知识咨询类，即便不调用工具也允许回答。
2. **优化信号权重**：降低 `isResearchTask` 对重型工具（浏览器）的初始加分，增加本地工具（文件读写/Git 插件）的优先级。
3. **调整 Prompt 语气**：将 `Prefer tools` 改为 `Check internal knowledge first; use tools only if internal knowledge is insufficient`（先检查内建知识；如果不足再用工具）。
4. **增加“建议 / 诊断 / 执行”三分法**：不要只判断“是不是编辑任务”，而要先判断用户是在要方案、要原因，还是要落地执行。
5. **把工具暴露改成分层而不是按组全开**：至少拆成 `无工具`、`本地只读`、`本地可写`、`网页研究`、`浏览器交互` 五级。
6. **让 Prompt 与真实工具挂载保持一致**：只有本轮真的挂载了 `browser_*`，才在 Prompt 中告诉模型可以优先使用浏览器。
7. **为浏览器能力增加预算与停止条件**：例如每轮最多一次 `browser_search`，如果已经得到可执行答案或已命中 workspace/Git 线索，就不再继续外部搜索。
