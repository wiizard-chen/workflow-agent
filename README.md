# pi-workflow

一个 [pi coding-agent](https://pi.dev) 扩展,把"需求 → PRD → 拆 task → 分配 dev → 测试"做成 **idle / plan / build 三模式**流水线。plan 模式(只读)你和 pi 讨论需求;build 模式下**主 session 自己就是技术经理**(不再 spawn 独立经理进程)——它把 PRD 拆成 task、用 [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) 的 `subagent` 工具分配给 **pi dev subagent**(定义在 `.pi/agents/dev.md`,在专属 worktree 里跑)、最后让 glm-5.2 测试,失败自动建 bd bug。idle 模式 pi 退回成普通编码 agent(完整工具集)。

> 历史注记:本项目早期基于 omp(opencode fork)构建,后随上游迁移到 pi(`@earendil-works/pi-coding-agent`)。文档里如出现 omp 字样均指这段历史。

## 架构(v4:主 session 即经理)

```
plan 模式(你和主 pi 讨论,只读):
  /wf new <需求>   → bd init + bd create epic,进入 plan 模式
  讨论              → deepseek-pro
  /wf prd           → glm-5.2 生成 prd.md

build 模式(/execute):
  主 session 本身就是经理(无独立进程,manager-prompt.md 注入主 session 的 system prompt):
    1. 读 prd.md
    2. split_prd_to_tasks  → bd create tasks + dep add(拆分原则:尽量独立)
    3. bd_task(claim) → subagent({agent:"dev",...}) → subagent({agent:"reviewer",...})
       pi-subagents 的 subagent 工具每次 spawn 一个 fresh dev subagent(定义在 .pi/agents/dev.md,
       在专属 worktree 里跑);独立 task 并行调 subagent(传 worktree:true 隔离改动),
       dev 内部闭环验证(write→verify→fix 直到通过),
       把结构化结果写进一个 output JSON 文件,经理读这个文件决定 close/reopen
    4. run_test → glm-5.2 测试产出,blocker 创建为 bd bug
    5. bug 再走 claim→subagent(dev)→subagent(reviewer) 循环修复 → 重测,直到无 bug
  /wf done → 回到 idle 模式(保留 wf 上下文)
```

**核心设计**:调度是经理 LLM 的判断(不是代码循环);每个 dev 是一个 pi-subagents subagent,持有固定 worktree。跨 task 的上下文不靠 session 续跑(原 reasonix 的 `--continue` 机制早在上一轮迁移就已移除),而是靠:(a) `cache.ts` 把 system-prompt 里的 date 冻结成常量,让 DeepSeek 服务端前缀缓存跨 task 保持热度;(b) bd comments 显式携带跨 task 状态。独立 task 并行调 `subagent`(可传 `worktree: true` 隔离改动),取代旧的"依赖链给同一 dev 走 --continue"路由。

## 模型分工

| 阶段 | 执行方 | 模型 |
|---|---|---|
| 讨论需求 | 主 pi | deepseek-pro (`deepseek-v4-pro`) |
| 写 PRD | 主 pi | glm-5.2 |
| 技术经理(拆 task/分配/测试) | **主 session(build 模式)** | deepseek-pro |
| 实现每个 task | **pi dev subagent**(由 `subagent` 工具 spawn) | deepseek-flash |
| 测试产出 | 主 session 调 glm-5.2 | glm-5.2 |

build 模式时 manager-prompt.md 注入主 session 的 system prompt,主 session 据此使用 `split_prd_to_tasks` / `bd_task` / `run_test` + pi-subagents 的 `subagent` 工具。provider 由扩展注册(用 `$DEEPSEEK_API_KEY`、`$GLM5_2_API_KEY`)。

## 前置

- `pi`(v0.81+,`@earendil-works/pi-coding-agent`)、`pi-subagents` 插件(`pi install npm:pi-subagents`,来自 [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents),提供 `subagent` 工具)、`bd`/`beads`(v1.1.0+)、`git` 已安装。(dev/reviewer 执行层由 pi-subagents 的 subagent 承担,无需额外二进制。)
  ```bash
  brew install beads          # 安装 bd v1.1.0
  ```
- 环境变量 `DEEPSEEK_API_KEY`、`GLM5_2_API_KEY` 已在 shell(如 zshrc)配好。
- 目标项目是一个 **git 仓库**。

## 一键安装(推荐)

不想手动一个个装?克隆仓库后跑一行,装齐 pi + pi-subagents + beads、配好 API key、装好 skill:

```bash
git clone https://github.com/wiizard-chen/workflow-agent.git
cd workflow-agent
bash scripts/setup.sh
```

`setup.sh` 会:**幂等地**(已装的跳过,可反复跑):

1. 装 `pi`(npm 全局,`@earendil-works/pi-coding-agent`)、`pi-subagents`(`pi install npm:pi-subagents`)、`beads`(brew)
2. 交互式提示输入 `DEEPSEEK_API_KEY` / `GLM5_2_API_KEY`,写入 `~/.zshrc`(已在 zshrc 的跳过;输入不回显)
3. 把本项目的 skill 装到全局 pi skill 根
4. 把 `wfpi` 命令写进 `~/.zshrc`(任意目录一键启动 pi + workflow 扩展,见下文「从本地源码加载」)

```bash
bash scripts/setup.sh --check        # 只检查现状,不改任何东西
bash scripts/setup.sh --no-tools     # 跳过工具安装,只配 key + skill
bash scripts/setup.sh --no-keys      # 跳过 key 配置
bash scripts/setup.sh --no-skills    # 跳过 skill 安装
```

> key 获取:DEEPSEEK_API_KEY ← https://platform.deepseek.com/;GLM5_2_API_KEY ← https://open.bigmodel.cn/(智谱 GLM)。写完 key 新开终端才生效。

## 安装

仓库已是标准 pi package(公开仓库,匿名 HTTPS 即可安装,无需 SSH key):

```bash
# 全局安装(推荐):任何目录进 pi 都自动带上 /wf、/plan、/execute
pi install git:github.com/wiizard-chen/workflow-agent --approve
```

升级到最新版:`pi update --extension git:github.com/wiizard-chen/workflow-agent`。

### 从本地源码加载(开发/调试用)

任意目录一键启动 pi + workflow 扩展(workflow.ts + cache.ts + pi-subagents),用 `wfpi` 包装脚本:

```bash
wfpi                          # 交互式启动(在当前目录)
wfpi --print "回复 OK"        # 非交互
wfpi --model "deepseek/..."   # 指定 model
WF_AGENT_HOME=/path wfpi      # 自定义 workflow-agent 路径
```

`wfpi` 由 `scripts/setup.sh` 自动写入 `~/.zshrc`(见「一键安装」)。不想跑 setup.sh 也可以直接 `source scripts/wfpi.aliases` 或手动 `pi -e ./extensions/workflow.ts -e ./extensions/cache.ts`。

## 用法

三个模式(idle / plan / build),核心切换点是 build 与 plan 之间:

1. `/wf new <需求名> [目标repo路径]` — 新建需求:`bd init`(若未初始化)+ `bd create` 父 epic,进入 **plan 模式**(对代码只读)。省略路径则用当前目录。
2. 自由对话讨论需求。
3. `/wf prd` — 生成 `prd.md`(glm-5.2,基于讨论;缺仓库简报会先自动分析)。
4. 审阅 `.workflow/<reqId>/prd.md`。不满意继续讨论后再 `/wf prd`。
5. `/execute` — 进入 **build 模式**:**主 session 自己就是经理**(无独立进程)。`/execute` 通过 `sendUserMessage` 把 manager-prompt.md 注入主 session,主 session 读 PRD → 拆 task 进 bd → `subagent(dev)` / `subagent(reviewer)` → 测试。失败自动建 bd bug,主 session 继续分配修复,直到全过。整个过程用户可直接观察并插话。
6. `/wf done` — 结束 build,回到 **idle 模式**(保留 wf 上下文)。`/wf idle` 可随时切到通用编码模式(完整工具集)。
7. `/wf status` 查看 bd 子任务状态 + 本需求 token/cache 用量;需修订 `/plan` 回到讨论。

**先看计划再动手**:`/execute --dry-run` 只让经理拆 task + 汇报计划(拆分结果会真的建成 bd task 方便审阅依赖图),**不派 dev、不改代码**。确认无误后再跑 `/execute` 正式执行。

**跑歪了回滚**:`/wf abort` 把目标 repo `git reset --hard` 回 `/execute` 时记录的 baseline,并把 epic 下的 task 全部 reopen。执行前会列出将丢弃的 commit / 改动统计 / 未提交改动并要求确认,`.workflow/` 工件会先提交一次保留作审计记录。**不可逆,谨慎使用。**

辅助命令:`/wf analyze [--refresh]`、`/wf verify <cmd>`(设置验证命令,如 `npm test`)、`/plan`、`/wf idle`(切到通用编码模式)、`/wf abort`(回滚)。

## 经理 prompt(可编辑)

build 模式的经理行为由 `.pi/manager-prompt.md` 定义。注意它**不是 agent 定义**(manager 不再是独立 subagent,就是主 session 自己),而是一段在 `/execute` 时通过 `sendUserMessage` 注入主 session 的 prompt。你可以直接编辑这个文件调整经理的拆分/分配/测试策略,**不用改代码**。扩展注入时会附带运行上下文(reqId/repo/epicId/prd 路径)。

## 仓库简报(`/wf analyze`)

第一次接触一个目标 repo 时,`/wf prd` 会自动先跑一次 `deepseek-pro` 的**只读**探查,产出 `.workflow/_repo-brief.md`(仓库级,跨需求复用)。简报自动前置拼进 prd/split/review 的 prompt。

- 手动触发:`/wf analyze`(已存在则跳过)
- 强制刷新:`/wf analyze --refresh`

## 内置 skill:计划追问法

仓库自带 `plan-interrogation` skill,扩展加载时自动挂上。方法论:在 PRD 阶段逐条走查设计树、一次只问一个问题并给出推荐答案、能查代码就先查不发问。

## beads skill 四件套 + 全局安装

仓库还在 `skills/` 下提供四个针对流水线的 beads skill(主 session 与 dev subagent 通用):

| skill | 用途 | 主要使用者 |
|---|---|---|
| `bd-plan` | 需求 → beads epic + PRD | 主 session pi(plan 模式) |
| `bd-split` | PRD → task + 依赖(经理拆分) | 主 session(build 模式) |
| `bd-work` | 认领/实现/关闭单个 task | pi dev subagent(高频) |
| `bd-handoff` | 跨 session 交接(进度写 bd 不写本地) | 经理 + dev |

`pi install` 装的是**扩展**(`/wf`、`/execute` 等命令),skill 默认只在项目目录内可用。要让 **pi 在任何目录**(含 dev subagent)都加载这些 skill,装到全局 skill 根。

**用 npm script(推荐):**

```bash
npm run skills:install              # 默认:symlink 装到 ~/.omp/agent/skills/
npm run skills:uninstall            # 卸载(只删本项目装的,绝不碰别人的)
npm run skills:list                 # 只看状态,不改动

# 透传额外参数用 --:
npm run skills:install -- --copy    # 复制安装(默认 symlink)
npm run skills:install -- --dry-run # 演练,打印不执行
```

**或直接跑脚本:**

```bash
node scripts/install-skills.mjs             # 安装(默认 symlink)
node scripts/install-skills.mjs --copy      # 复制安装
node scripts/install-skills.mjs --list      # 查看状态
node scripts/uninstall-skills.mjs           # 卸载(独立脚本)
```

安装和卸载共享同一份所有权清单(skills-lib.mjs),保证装/卸完全对称。symlink 模式下,改了仓库里的 skill 全局立刻生效,不用重装——适合开发自己的包。脚本只处理本项目拥有的 6 个 skill(`bd-*` 四件套 + `plan-interrogation` + `beads`),对目录里其他 skill 只读保护。

## dev 池与并行执行(`maxParallel`)

`workflow.config.json` 的 `execute.maxParallel` 是**经理一次并行派 dev 的建议上限**(代码内置默认 3;仓库自带的配置文件设成了 20)。扩展会把这个数字注入 manager prompt 的运行上下文,经理据此决定一次 `subagent({tasks:[...]})` 里同时派几个 dev。每个 dev 是一次 pi-subagents subagent spawn:

- 独立的 task 并行调 `subagent`(传 `worktree: true` 让每个并行子任务在独立 git worktree 里跑,commit 不交错),取代旧的"依赖链给同一 dev 走 `--continue`"路由。
- 跨 task 上下文不再靠 session 续跑,而是靠:(a) `cache.ts` 冻结 system-prompt 的 date 让 DeepSeek 前缀缓存跨 task 保持热度;(b) bd comments 显式携带跨 task 状态。
- dev 在自己的 subagent 内部做闭环验证(write → verify → fix 直到通过),把结构化结果写进 output JSON 文件,经理读这个文件决定下一步。
- 经理(主 session)是驻留 LLM,默认做 stage 级委派(dynamic granularity),异常时细粒度介入。

**缓存安全性已实测验证**(详见 `DECISION_LOG.md`):worktree 路径不破坏 DeepSeek 前缀缓存。

## 验证门(P0 安全)

`/execute`(build 模式)默认**严格验证**:如果没有设置验证命令(`/wf verify <cmd>` 或配置 `build.verifyCommand`),每个子任务会因验证门为空而失败。这避免了 pi dev subagent 自主写入无任何校验直接 commit 的安全风险(dev 内部已做闭环 verify→fix,P0 门控兜底)。首次 build 会在无验证命令时弹出确认,允许你显式接受"无验证"或先去设置。

## 产物布局(在目标 repo 内)

```
<repo>/.workflow/
├── _repo-brief.md           # 仓库级简报(/wf analyze,跨需求复用)
└── <reqId>/
    ├── state.json              # 流水线状态(reqId/epicId/mode/baseline/subtaskIds)
    ├── prd.md                  # PRD(glm-5.2)
    ├── subtasks/
    │   ├── NN-*.md             # 子任务规格(deepseek-pro);bd issue notes 指向这里
    │   └── bug-*.md            # /wf bug 生成的 bug 规格
    ├── results/
    │   ├── <taskId>.json        # 每个 dev subagent 的结构化结果(verifyPassed/commitSha/…)
    │   ├── <taskId>.review.json # 每个 reviewer subagent 的判定(verdict/issues/…)
    │   ├── cumulative.diff      # 全量累积改动(run_test 写,供整体 review)
    │   └── summary.json         # token / cache 命中 / cost 汇总(按模型分组,每轮实时落盘)
    └── review.md               # 整体 review(glm-5.2,建议性)

<repo>/.beads/                 # bd 数据(bd init 创建)
├── config.yaml                # bd 配置(进 git)
├── metadata.json              # 后端元数据(进 git)
└── embeddeddolt/              # Dolt 数据库(被 .beads/.gitignore 忽略,不进 git)
```

子任务 DAG(依赖、状态、归属)存在 bd 里,是权威;`.workflow/` 只放文本产物。代码改动走 git,每子任务一个 code commit,`.workflow/` 工件最后单独一个 commit。

`results/summary.json` 由 `message_end` hook 实时累计(按 `provider/model` 分组的 turns / input / output / cacheRead / cacheWrite / cost + 整体 cache 命中率),每轮写一次,所以即使跑崩了也留得下数据。`/wf status` 会顺带显示这份汇总的单行摘要。

## PLAN 阶段联网(Playwright MCP + pi-web-access)

PLAN 阶段的联网需求分两类,各用不同工具,职责不重叠:

- **前端调试(真实浏览器)**:用 [`scaryrawr/pi-mcp`](https://github.com/scaryrawr/pi-mcp) 桥接标准 MCP server,已接好 [`microsoft/playwright-mcp`](https://github.com/microsoft/playwright-mcp)(`.mcp.json`)。跑起来的是真实浏览器实例,适合截图、DOM 交互、点击测试这类必须有活浏览器上下文的调试场景。首次使用:`pi install git:github.com/scaryrawr/pi-mcp -l`。
- **查资料(搜索/抓取内容)**:用 [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access)(`pi install npm:pi-web-access`)。提供 `web_search`/`fetch_content`/`source_check` 等工具,零配置(Exa MCP 兜底),用于搜索、抓取网页/GitHub 仓库/文档内容——不需要真实浏览器,PLAN 阶段查资料时更轻量。

PLAN 模式的只读工具锁(`lockReadonly`)会自动放行所有 `playwright_*` 工具(按 MCP server 名前缀检测),以及 `pi-web-access` 注册的工具(`web_search`/`fetch_content`/`get_search_content`/`source_check`,按工具名显式检测,未安装时是无害的 no-op)。两者可以同时装,分别覆盖"调试网页"和"查资料"两种场景。

## 配置

`workflow.config.json` 可调:

| 字段 | 作用 |
|---|---|
| `providers.*` | provider endpoint / apiKey 环境变量名 / api 格式 |
| `roles.{discuss,prd,split,review}` | 各阶段用哪个 provider + 模型 id |
| `build.verifyCommand` | 默认验证命令(`/wf verify <cmd>` 可按需求覆盖) |
| `build.commitPrefix` | 子任务 commit 消息前缀 |
| `execute.maxParallel` | 经理一次并行派 dev 的建议上限(注入 manager prompt;代码内置默认 3) |

**dev / reviewer 的模型不在这里配**——它们是 pi-subagents 的 subagent,模型写在 `.pi/agents/dev.md` / `.pi/agents/reviewer.md` 的 frontmatter(`model:` 字段)里。(历史字段 `reasonix: {bin, model, maxSteps, timeoutMs}` 和后来的 `dev: {model, timeoutMs}` 都已移除,不再读取。)

`execute.driver` 只实现了 `"bd"`;`execute.pollIntervalMs` 是死字段(当前实现不轮询),保留仅为兼容旧配置。

改完 `/reload` 或重启 pi。

## 缓存说明

- 每个子任务由一个独立的 pi dev subagent run 承担(`subagent({agent:"dev"})`),命中 DeepSeek **服务端前缀热缓存**(成本大头)。
- **worktree 并行不击穿缓存**(实测):worktree 的 cwd 差异不注入 pi system prompt,前缀缓存跨 worktree 共享。详见 `DECISION_LOG.md`。
- pi 侧多模型切换(pro/glm)天然会各走各的缓存桶,属于预期,量小无碍。

### pi 侧缓存优化(`extensions/cache.ts`)

pi 的 system prompt 里有动态 date 字段(`Today is YYYY-MM-DD,`),每天午夜变一次,击穿 DeepSeek 前缀缓存。本扩展用 `before_agent_start` hook,**只对 DeepSeek 模型**把 date 冻结成固定常量,让讨论/拆分/PRD/review 阶段的前缀字节稳定:

- **dev subagent 执行层**:cache.ts 同样覆盖——每次 `subagent({agent:"dev"})` spawn 的 pi dev subagent 启动时 system-prompt 的 date 被冻结成同一常量,前缀缓存跨 task / 跨 dev 保持热度(取代了原 reasonix 执行层自带的字节级缓存优化,~99.8% 命中率被保留)。
- **pi 讨论层**:`cache.ts` 冻结 date → 前缀跨 turn/midnight 稳定 → 缓存命中。
- **telemetry**:`message_end` hook 累计 DeepSeek 的 `prompt_cache_hit_tokens`,每 5 turn 通知一次命中率。
- 只对 DeepSeek 生效(glm/zai 不用前缀缓存,冻结无益)。

> 为什么自写不用 `@rohaquinlop/pi-deepseek-cache`:该插件 import `@earendil-works/pi-coding-agent` 的 `serializeConversation`,但 omp 16.4.6 的 shim 没导出它(fork 重构进了 `snapcompact` 命名空间),`pi plugin install` 验证失败。本扩展用 pi 原生 hook,零第三方依赖。(注:omp 是 pi 的前身,这段历史记录保留以解释为何自写缓存 hook。)详见 `DECISION_LOG.md`。

## 安全 / 边界

- pi dev subagent autonomous(不卡审批)但仍遵守 pi 的 `deny`(默认已拦 `git push`、`rm -rf`),sandbox 限写在目标 repo 内。
- plan 模式下扩展会拦截 pi 对 `.workflow/` 以外文件的 `write`/`edit`(对真实代码只读)。
- **验证门默认严格**:无验证命令 = 失败,而非静默通过(修了 KNOWN_ISSUES P0 #1)。
- BUILD 中拒绝 `/wf new`(单例锁,修了 KNOWN_ISSUES P1 #2)。
- 子任务拆分的 JSON 解析严格校验,失败响亮报错(修了 KNOWN_ISSUES P1 #3)。
- review 为建议性,不自动改代码、不自动回环。

## 测试

```bash
node --experimental-strip-types test/build.test.ts
```

用 in-memory fake bd + 真实临时 git repo 端到端验证 build 流水线(串行 fail-fast、并行 fan-in、无改动、断点续跑、worktree 清理、merge),无需 API、无需真实 bd。

## 已验证(真实冒烟)

详见 `DECISION_LOG.md`:worktree 缓存安全性实测、bd 1.1.0 真实接口验证。

## 备注

- 每个 pi dev subagent 是独立的一次 `subagent({agent:"dev"})` run;若网络受限访问 z.ai,给 pi 配好代理可减少 `Connection error` 重试。
- glm-5.2 endpoint / 模型 id 默认 `https://api.z.ai/api/coding/paas/v4` + `glm-5.2`;版本不同在 `workflow.config.json` 调整。
- bd 1.1.0 真实命令与官方文档有差异(用 `assign`/`comment`/`config.yaml`,无 `pin`/`hook`);以 `extensions/bd.ts` 封装为准。
