# pi-workflow

一个 [pi/omp coding-agent](https://pi.dev) 扩展,把"需求 → PRD → 拆 task → 分配 dev → 测试"做成 **PRD / 执行 双模式**流水线。PRD 模式你和 omp 讨论需求;执行模式 omp 启动一个**技术经理**(独立 session),它把 PRD 拆成 task、分配给 **reasonix dev**(持久 session,复用上下文)、最后让 glm-5.2 测试,失败自动建 bd bug。

## 架构(v3:经理驱动)

```
PRD 模式(你和主 omp 讨论):
  /wf new <需求>   → bd init + bd create epic,进入 PRD 模式(只读)
  讨论              → deepseek-pro
  /wf prd           → glm-5.2 生成 prd.md

执行模式(/execute):
  主 omp spawn 一个经理 omp 进程(独立 session,加载 .omp/agents/manager.md):
    1. 读 prd.md
    2. split_prd_to_tasks  → bd create tasks + dep add(拆分原则:尽量独立)
    3. assign_dev(taskId, devId) → 同步:claim + worktree + reasonix run
       独立 task 散给不同 dev;依赖链的一串给同一个 dev(复用 session)
       同一 dev 的后续 task 自动 --continue(上下文复用:不用重新读项目)
    4. run_test → glm-5.2 测试产出,blocker 创建为 bd bug
    5. bug 再分配 assign_dev 修复 → 重测,直到无 bug
  经理进程退出 → 主 session 汇报
```

**核心设计**:调度是经理 LLM 的判断(不是代码循环);每个 dev 持有固定 worktree,reasonix `-dir` 不变 → session 路径稳定 → `--continue` 跨 task 复用上下文(DeepSeek 智能需要上下文激活)。

## 模型分工

| 阶段 | 执行方 | 模型 |
|---|---|---|
| 讨论需求 | 主 omp | deepseek-pro (`deepseek-v4-pro`) |
| 写 PRD | 主 omp | glm-5.2 |
| 技术经理(拆 task/分配/测试) | **经理 omp 进程** | deepseek-pro |
| 实现每个 task | **reasonix dev**(持久 session) | deepseek-flash |
| 测试产出 | 经理调 glm-5.2 | glm-5.2 |

经理进程加载同一个 workflow.ts 扩展,通过 `WF_ROLE=manager` 激活 `split_prd_to_tasks`/`assign_dev`/`run_test` 三个工具。provider 由扩展注册(用 `$DEEPSEEK_API_KEY`、`$GLM5_2_API_KEY`)。

## 前置

- `pi`(v0.80+)、`reasonix`(v1.11+)、`bd`/`beads`(v1.1.0+)、`git` 已安装。
  ```bash
  brew install beads          # 安装 bd v1.1.0
  ```
- 环境变量 `DEEPSEEK_API_KEY`、`GLM5_2_API_KEY` 已在 shell(如 zshrc)配好。
- 目标项目是一个 **git 仓库**。

## 一键安装(推荐)

不想手动一个个装?克隆仓库后跑一行,装齐 omp + reasonix + beads、配好 API key、装好 skill:

```bash
git clone https://github.com/wiizard-chen/workflow-agent.git
cd workflow-agent
bash scripts/setup.sh
```

`setup.sh` 会:**幂等地**(已装的跳过,可反复跑):

1. 装 `omp`(bun 优先,没 bun 回退 npm)、`reasonix`(npm)、`beads`(brew)
2. 交互式提示输入 `DEEPSEEK_API_KEY` / `GLM5_2_API_KEY`,写入 `~/.zshrc`(已在 zshrc 的跳过;输入不回显)
3. 把本项目的 skill 装到全局 omp/reasonix skill 根

```bash
bash scripts/setup.sh --check        # 只检查现状,不改任何东西
bash scripts/setup.sh --no-tools     # 跳过工具安装,只配 key + skill
bash scripts/setup.sh --no-keys      # 跳过 key 配置
bash scripts/setup.sh --no-skills    # 跳过 skill 安装
```

> key 获取:DEEPSEEK_API_KEY ← https://platform.deepseek.com/;GLM5_2_API_KEY ← https://open.bigmodel.cn/(智谱 GLM)。写完 key 新开终端才生效。

## 安装

仓库已是标准 pi/omp package(公开仓库,匿名 HTTPS 即可安装,无需 SSH key):

```bash
# 全局安装(推荐):任何目录进 omp/pi 都自动带上 /wf、/plan、/execute
pi install git:github.com/wiizard-chen/workflow-agent --approve
```

升级到最新版:`pi update --extension git:github.com/wiizard-chen/workflow-agent`。

### 从本地源码加载(开发/调试用)

```bash
omp -e /path/to/workflow/extensions/workflow.ts   # 或 pi -e
```

## 用法

两个模式,切换点是你对 PRD 的批准:

1. `/wf new <需求名> [目标repo路径]` — 新建需求:`bd init`(若未初始化)+ `bd create` 父 epic,进入 **PRD 模式**(对代码只读)。省略路径则用当前目录。
2. 自由对话讨论需求。
3. `/wf prd` — 生成 `prd.md`(glm-5.2,基于讨论;缺仓库简报会先自动分析)。
4. 审阅 `.workflow/<reqId>/prd.md`。不满意继续讨论后再 `/wf prd`。
5. `/execute` — 进入**执行模式**:主 omp 启动经理进程,它读 PRD → 拆 task 进 bd → 分配 dev(reasonix)→ 测试。失败自动建 bd bug,经理继续分配修复,直到全过。经理进程退出后回到主 session。
6. `/wf status` 查看 bd 子任务状态;需修订 `/plan` 回到讨论。

辅助命令:`/wf analyze [--refresh]`、`/wf verify <cmd>`(设置验证命令,如 `npm test`)、`/plan`。

## 经理 system prompt(可编辑)

执行模式的经理行为由 `.omp/agents/manager.md` 定义。你可以直接编辑这个文件调整经理的拆分/分配/测试策略,**不用改代码**。扩展启动经理进程时读取它并注入运行上下文(reqId/repo/epicId/prd 路径)。

## 仓库简报(`/wf analyze`)

第一次接触一个目标 repo 时,`/wf prd` 会自动先跑一次 `deepseek-pro` 的**只读**探查,产出 `.workflow/_repo-brief.md`(仓库级,跨需求复用)。简报自动前置拼进 prd/split/review 的 prompt。

- 手动触发:`/wf analyze`(已存在则跳过)
- 强制刷新:`/wf analyze --refresh`

## 内置 skill:计划追问法

仓库自带 `plan-interrogation` skill,扩展加载时自动挂上。方法论:在 PRD 阶段逐条走查设计树、一次只问一个问题并给出推荐答案、能查代码就先查不发问。

## beads skill 四件套 + 全局安装

仓库还在 `skills/` 下提供四个针对流水线的 beads skill(omp 和 reasonix 通用):

| skill | 用途 | 主要使用者 |
|---|---|---|
| `bd-plan` | 需求 → beads epic + PRD | 主 session omp |
| `bd-split` | PRD → task + 依赖(经理拆分) | 经理 omp 进程 |
| `bd-work` | 认领/实现/关闭单个 task | reasonix dev(高频) |
| `bd-handoff` | 跨 session 交接(进度写 bd 不写本地) | 经理 + dev |

`pi install` 装的是**扩展**(`/wf`、`/execute` 等命令),skill 默认只在项目目录内可用。要让 **omp/reasonix 在任何目录**都加载这些 skill,装到全局 skill 根。

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

## dev 池与 session 复用(`maxParallel`)

`workflow.config.json` 的 `execute.maxParallel` 是**经理可用的 dev 池大小**(默认 3)。每个 dev 是一个持久 reasonix session,持有固定 worktree:

- 同一 dev 的连续 task 自动 `--continue`(reasonix 续跑 session)——**上下文复用**:dev 不用重新读项目,DeepSeek 的项目理解在前一个 task 已建立。
- 经理把**有依赖链的一串 task 给同一个 dev**,最大化复用;独立的 task 散给不同 dev。
- **注意(同步模型)**:`assign_dev` 同步等 reasonix 跑完,一次跑一个 dev。maxParallel 是池大小(经理轮流用),不是并发数。真并行(多 dev 同时跑)是后续升级路径。

**缓存安全性已实测验证**(详见 `DECISION_LOG.md`):worktree 路径不破坏 reasonix 的 DeepSeek 前缀缓存。

## 验证门(P0 安全)

`/build` 默认**严格验证**:如果没有设置验证命令(`/wf verify <cmd>` 或配置 `build.verifyCommand`),每个子任务会因验证门为空而失败。这避免了 reasonix 自主写入无任何校验直接 commit 的安全风险。首次 `/build` 会在无验证命令时弹出确认,允许你显式接受"无验证"或先去设置。

## 产物布局(在目标 repo 内)

```
<repo>/.workflow/
├── _repo-brief.md           # 仓库级简报(/wf analyze,跨需求复用)
└── <reqId>/
    ├── state.json              # 流水线状态(reqId/epicId/mode/baseline)
    ├── prd.md                  # PRD(glm-5.2)
    ├── subtasks/
    │   └── NN-*.md             # 子任务规格(deepseek-pro);bd issue notes 指向这里
    ├── results/
    │   ├── NN.metrics.json     # 每个 reasonix run 的 token/cache/cost
    │   ├── cumulative.diff     # 全量累积改动(供 review)
    │   └── summary.json        # 成本 + 平均 cache 命中汇总
    └── review.md               # 整体 review(glm-5.2,建议性)

<repo>/.beads/                 # bd 数据(bd init 创建)
├── config.yaml                # bd 配置(进 git)
├── metadata.json              # 后端元数据(进 git)
└── embeddeddolt/              # Dolt 数据库(被 .beads/.gitignore 忽略,不进 git)
```

子任务 DAG(依赖、状态、归属)存在 bd 里,是权威;`.workflow/` 只放文本产物。代码改动走 git,每子任务一个 code commit,`.workflow/` 工件最后单独一个 commit。

## 浏览器访问(Playwright MCP)

PLAN 阶段有时需要读网页。这层挂在 pi 编排层,通过第三方扩展 [`scaryrawr/pi-mcp`](https://github.com/scaryrawr/pi-mcp) 桥接标准 MCP server。已接好 [`microsoft/playwright-mcp`](https://github.com/microsoft/playwright-mcp)(`.mcp.json`),PLAN 模式的只读工具锁(`lockReadonly`)会自动放行所有 `playwright_*` 工具。

首次使用:`pi install git:github.com/scaryrawr/pi-mcp -l`。

## 配置

`workflow.config.json` 可调:provider endpoint / 模型 id、各阶段角色、reasonix 二进制名 / 模型 / 超时、默认验证命令、commit 前缀、**并行上限**(`execute.maxParallel`)。改完 `/reload` 或重启 pi。

## 缓存说明

- 每个子任务是独立的 `reasonix run`(独立 session),命中 DeepSeek **服务端前缀热缓存**(成本大头)。
- **worktree 并行不击穿缓存**(实测):worktree 的 cwd 差异不注入 reasonix system prompt,前缀缓存跨 worktree 共享。详见 `DECISION_LOG.md`。
- pi 侧多模型切换(pro/glm)天然会各走各的缓存桶,属于预期,量小无碍。

### omp 侧缓存优化(`extensions/cache.ts`)

omp 的 system prompt 里有动态 date 字段(`Today is YYYY-MM-DD,`),每天午夜变一次,击穿 DeepSeek 前缀缓存。本扩展用 `before_agent_start` hook,**只对 DeepSeek 模型**把 date 冻结成固定常量,让讨论/拆分/PRD/review 阶段的前缀字节稳定:

- **reasonix 执行层**:自带字节级缓存优化(~99.8%),不动。
- **omp 讨论层**:`cache.ts` 冻结 date → 前缀跨 turn/midnight 稳定 → 缓存命中。
- **telemetry**:`message_end` hook 累计 DeepSeek 的 `prompt_cache_hit_tokens`,每 5 turn 通知一次命中率。
- 只对 DeepSeek 生效(glm/zai 不用前缀缓存,冻结无益)。

> 为什么自写不用 `@rohaquinlop/pi-deepseek-cache`:该插件 import `@earendil-works/pi-coding-agent` 的 `serializeConversation`,但 omp 16.4.6 的 shim 没导出它(fork 重构进了 `snapcompact` 命名空间),`omp plugin install` 验证失败。本扩展用 omp 原生 hook,零第三方依赖。详见 `DECISION_LOG.md`。

## 安全 / 边界

- `reasonix run` autonomous(不卡审批)但仍遵守其 `deny`(默认已拦 `git push`、`rm -rf`),sandbox 限写在目标 repo 内。
- PLAN 模式下扩展会拦截 pi 对 `.workflow/` 以外文件的 `write`/`edit`(对真实代码只读)。
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

- reasonix `run` 每个子任务是独立 session;若网络受限访问 z.ai,给 pi 配好代理可减少 `Connection error` 重试。
- glm-5.2 endpoint / 模型 id 默认 `https://api.z.ai/api/coding/paas/v4` + `glm-5.2`;版本不同在 `workflow.config.json` 调整。
- bd 1.1.0 真实命令与官方文档有差异(用 `assign`/`comment`/`config.yaml`,无 `pin`/`hook`);以 `extensions/bd.ts` 封装为准。
