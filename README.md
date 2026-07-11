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
