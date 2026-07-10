# 执行层/编排层选型结论与后续方案

记录于 2026-07-10。这份文档汇总了围绕"要不要摆脱 reasonix / pi 是否够可靠 / 该不该换 omp 或 opencode"的完整讨论结论，附证据来源，供换环境后继续处理。

## 核心结论：三个诉求两两冲突，没有"一个完整 agent 满足所有"

你反复追问的方向，最终归结为三个诉求：

1. **结构化人工审阅流程**（讨论→PRD→你审阅→拆子任务→执行→review）
2. **DeepSeek 字节级前缀缓存优化**（你自己长期实测 reasonix ≈99.8%，opencode ≈95%）
3. **一个工具、不用自己拼**

**1 和 2 之间存在真实的工程矛盾**：想要通用的人工审阅流程，工具就必须面向多 provider 通用场景；想要 DeepSeek 字节级缓存优化，system prompt 必须逐字节稳定，任何为通用性做的妥协（date 字段、cwd 字段、40+ provider 兼容层）都会打破前缀。查过的每一个通用 agent（opencode、omp、Claude Code）都选择了通用性，代价是放弃字节级缓存优化；reasonix 选择了缓存优化，代价是不做通用人工审阅流程（它自己的 issue #1167 承认了这个缺口）。

**没有第四个选项**。现实只有三条路：
- **分工**（现在的架构：pi/omp 管人工环节，reasonix 管执行）——唯一同时拿到两边好处的路径
- **只要通用**——放弃字节级缓存，接受 90%出头命中率
- **只要缓存**——放弃人工审阅流程，接受 reasonix 自主执行（自己批准自己的计划，不暂停等你看）

## 逐项实测/查证证据

### reasonix 的 planner/subagent 机制不能替代 pi 的编排职责

真实调用 `reasonix run`（v1.17.6-rc.1，启用 `planner_model = "deepseek-pro"`），要求"先给计划、不要直接写代码"：
- 输出第一行是"计划已获批准，现在开始执行"——**自己批准自己的计划，不暂停等审阅**
- 全程 16 步一口气写完代码+测试+装依赖，**从未产出独立可读的 PRD/计划文档**
- `metrics.json` 无任何 planner 分项字段，`reasonix run --help` 无显式触发 planner 的参数——`planner_model` 在 headless 调用下大概率未被真正触发
- 缓存表现依然优秀（90.8%命中，¥0.042）——这个结论不变，reasonix 的执行层缓存能力没问题
- reasonix 自己的 issue #1167 明确写着"讨论→规划→执行→验证→交付"这套结构化生命周期是社区已提出、官方尚未解决的需求

结论：reasonix 是闭合的单一职责执行循环（SPEC.md 设计原则第6条"Evolve, don't over-engineer"），插件系统（`internal/plugin` MCP client）只能扩展"工具"层，不能扩展"agent 行为模式"层。SPEC.md §9 Roadmap 明确写着"plugins that provide *providers*, not just tools"是"deferred deliberately — no consumer / no foundation yet"。**这不是能力不足，是架构边界，查完源码后确认过。**

### pi 本身不是玩具，我们自己写的 workflow.ts 才是

pi 的扩展系统上已经长出多个严肃项目：
- `can1357/oh-my-pi`（omp）：16.9k star，511 release，258贡献者，~55k行Rust核心
- `scaryrawr/pi-mcp`：我们真实装过验证过的 MCP 桥接扩展
- `Jaraxxxx/pi-usage-dashboard`：我们真实装过、TUI截屏验证过的成本仪表盘
- `mcowger/pi-better-messages-cache`：真实存在的缓存优化扩展（Anthropic兼容模型专用）

这些用的是和我们 `workflow.ts` 完全相同的扩展 API（`registerTool`、`registerCommand`、`before_provider_request`、`setActiveTools`）。**别人能在 pi 上做出可靠东西，说明差距在工程投入，不在宿主本身**——具体差在：测试覆盖真实故障路径（不止测理想输入）、默认值安全（我们的 verifyCommand 默认空这个反例）、错误路径响亮失败（不像我们的 extractJson/aggregateMetrics 静默猜测）、并发防护（我们的单例状态没有）、真实用户反馈量级（omp 511个release vs 我们几次冒烟测试）。

详见 `KNOWN_ISSUES.md`——那份清单才是真正该修的东西，不是"换宿主"能绕开的。

### omp vs opencode：都不解决 DeepSeek 缓存，能力广度上 omp 更强

**omp 没有做 DeepSeek 前缀缓存优化**，三层证据：
1. 源码级：`packages/coding-agent/src/session/agent-session.ts` 的 `#computeAppliedToolSignature` 函数注释明确写着，system prompt 里的 `Today is '{{date}}'` **被有意设计为随当前日期变化**（"Without this, a session spanning midnight... would keep yesterday's date indefinitely"）——主动选择不冻结，不是疏忽。
2. 文档级：DeepSeek 官方"Using DeepSeek with Oh My Pi"页面（`api-docs.deepseek.com` 和 `deepseek-ai/awesome-deepseek-agent` 两处独立确认内容一致）通篇只谈"三个关键 compat 字段防止 400 报错"，**全篇不提缓存命中率**。
3. 生态级：搜不到任何 omp 用户报告的真实 DeepSeek 缓存命中率数字（reasonix 能搜到"507K hit + 29K miss"这类真实用户数据，omp 一个都没有）。

**opencode 同理**（issue #29672 直指 system prompt 里的动态 date/git flag 字段），是同一类设计选择的另一个体现。

**两者的真实差异是工具能力广度，不是缓存表现**：

| 维度 | omp | opencode |
|---|---|---|
| 原生工具 | LSP(14ops)+调试器(DAP)+Puppeteer浏览器(能控制Slack等Electron应用)+Python/JS双内核+hashline编辑 | 标准工具集，无原生调试器 |
| subagent | `task`工具，同进程worktree隔离，schema校验返回值 | `agent`配置，markdown/JSON定义 |
| 协作 | `/collab`中继链接+QR码远程加入 | 无 |
| 扩展系统血统 | pi的TypeScript扩展系统（`registerTool`/`before_provider_request`），扩展点在请求生命周期层 | 独立plugin hook体系，扩展点在业务事件层（`tool.execute.before`等） |
| 架构延续性 | 我们现有`workflow.ts`理论上不用大改就能跑 | 完全不同体系，现有代码作废需重写 |

### Claude Code 的 subagent 同理，只是更精致

`docs.claude.com/en/docs/claude-code/sub-agents` 官方文档确认：subagent 的 `model` 字段只接受 Anthropic 自己的 model alias/ID，不能塞外部命令；"Prompt cache"一节明确提到只有 fork（继承父会话）才复用父会话缓存，named subagent 会导致缓存分裂——这是 Anthropic 自家 prompt cache 机制，和 DeepSeek 字节级前缀缓存不是一回事，不能类比。Claude Code 在"通用性 vs 缓存"这道题上和 omp/opencode 是同一个阵营，只是编排能力（`permissionMode: plan`、hooks、nested subagent）比 opencode 更精致。**它是"只要通用"这条路里更强的选项，不是第四条路。**

## 后续方案（按你确认过的方向）

如果决定"抛开 reasonix，做一个好的 pi agent"：

1. **底座换成 omp，不是原版 pi，也不是 opencode。**
   理由：omp 是 pi 的兼容 fork，工具能力（LSP/调试器/浏览器）远超原版 pi 和 opencode；我们现有的 `extensions/workflow.ts`/`lib.ts` 用的是 pi 的扩展 API，理论上迁到 omp 上代码不用大改。opencode 是完全不同的 plugin 体系，选它意味着现有工作作废重写。

2. **通用能力层用 omp 现成的，不要自己拼。**
   LSP、调试器、浏览器自动化、40+provider兼容——这些是几年、上百贡献者、几百次真实bug修复换来的成熟度，自建等于重新踩omp已经踩过的所有坑。

3. **业务工作流层（plan/build双模式、PRD生成、子任务拆分、review）继续自己拼，但站在omp的扩展系统上拼**，同时把 `KNOWN_ISSUES.md` 那份清单里的问题一起修掉，不要重复"跑通就算完事"的路子。

4. **不要去找第三方拼好的workflow编排扩展来装**（`rpiv-workflow`、`pi-reasonix`等）——查过的候选质量或适配度都不够，不如自己写这层薄的、完全掌控的逻辑。

## 待办（回家后按此顺序处理）

1. 装 omp（`bun install -g @oh-my-pi/pi-coding-agent` 或对应平台安装方式），验证基础功能。
2. 把 `extensions/workflow.ts`/`lib.ts` 迁到 omp 上，跑一次真实冒烟测试确认扩展API兼容（`registerProvider`/`before_agent_start`/`setActiveTools`/`pi.exec`等接口是否原样可用）。
3. 兼容性确认后，回头处理 `KNOWN_ISSUES.md` 清单，按其中"建议优先级"顺序修：
   - P0 #1 验证门默认拒绝
   - P1 #2 单例状态竞态防护
   - P1 #3/#4 解析容错改成显式失败
   - P1 #5 review严重程度提示
4. 如果不再依赖reasonix，`workflow.config.json`里的`reasonix`执行层配置和`buildReasonixArgs`/`runBuildPipeline`里`execReasonix`那部分需要重新设计成"omp原生subagent(`task`工具)执行子任务"，而不是`pi.exec`调外部二进制——这是一次实质性的架构改动，不是小修补，需要重新走一遍我们之前"计划追问法"的设计确认流程。
