# pi-workflow

一个 [pi coding-agent](https://pi.dev) 扩展,把"需求 → PRD → 拆子任务 → 实现 → review"做成 **Plan / Build 双模式**流水线,并把最烧钱的实现阶段下沉给 [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 跑,吃满 DeepSeek 前缀缓存。

## 模型分工

| 阶段 | 执行方 | 模型 |
|---|---|---|
| 讨论需求 | pi | deepseek-pro (`deepseek-v4-pro`) |
| 写 PRD | pi | glm-5.2 |
| 拆子任务 | pi | deepseek-pro |
| 实现每个子任务 | **reasonix** | deepseek-flash |
| 整体 review | pi | glm-5.2 |

pi 侧的 deepseek / zai(GLM Coding Plan)provider 由扩展启动时用 `$DEEPSEEK_API_KEY`、`$GLM_API_KEY` 注册;reasonix 侧用它自己的 `~/.reasonix/config.toml`(默认 `deepseek-flash`)。

## 前置

- `pi`(v0.80+)、`reasonix`(v1.11+)、`git` 已安装。
- 环境变量 `DEEPSEEK_API_KEY`、`GLM_API_KEY` 已在 shell(如 zshrc)配好。
- 目标项目是一个 **git 仓库**。

## 加载

```bash
pi -e /Users/macadmin/Documents/workflow/extensions/workflow.ts
```
或作为 pi package 安装(`pi install -l git:...` / 本地路径)。

## 在新机器上复用

```bash
# 1. 前置:装 pi / reasonix / git,并在 shell 配好 DEEPSEEK_API_KEY、GLM_API_KEY
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
#   reasonix 按其官方方式安装,并 reasonix setup 配好 deepseek-flash

# 2. 克隆本仓库
git clone <your-repo-url> ~/pi-workflow

# 3. 直接加载扩展(-e 指向克隆目录里的扩展文件)
pi -e ~/pi-workflow/extensions/workflow.ts
```
需要的话把上一行做成 shell 别名,或用 `pi install -l git:<your-repo-url>` 作为 pi package 安装。
`workflow.config.json` 跟着仓库走,换机器无需重配(密钥仍从环境变量读)。想用浏览器 MCP 的话额外跑一次 `pi install git:github.com/scaryrawr/pi-mcp -l`(见下文"浏览器访问"一节)。

## 用法

两个模式,切换点就是你对"计划"的批准:

1. `/wf new <需求名> [目标repo路径]` — 新建需求,进入 **PLAN**(对代码只读),默认与 deepseek-pro 讨论。省略路径则用当前目录。
2. 自由对话讨论需求。
3. `/wf draft` — 生成/刷新**完整计划**:若目标 repo 尚无仓库简报会先自动分析一次(见下),再由 glm-5.2 写 `prd.md` → deepseek-pro 拆 `subtasks/*.md` + `subtasks/index.json`(带 `depends_on`/顺序)。可反复 `/wf draft` 迭代。
4. 审阅 `.workflow/<reqId>/prd.md` 与 `subtasks/`。
5. `/build` — 进入 **BUILD**:按 index 顺序**串行**,每个子任务 `reasonix run` 实现 → 验证命令 → **只提交代码改动**(每子任务一 commit)。失败即停,下游依赖 skip。全部通过后 glm-5.2 产出 `review.md`,并把 `.workflow/<reqId>/` 工件单独提交一次。
6. 读 `review.md` 决定后续;需修订 `/plan` 回到讨论。

辅助命令:`/wf status`、`/wf analyze [--refresh]`(见下)、`/wf verify <cmd>`(设置本需求的验证命令,如 `go build ./...`、`npm test`、`pytest -q`;留空则只看 reasonix 退出码)、`/plan`。

## 仓库简报(`/wf analyze`)

第一次接触一个目标 repo 时,`/wf draft` 会自动先跑一次 `deepseek-pro` 的**只读**探查,产出 `.workflow/_repo-brief.md`(注意:不挂在某个 `reqId` 下,是**仓库级**产物,同一个 repo 的所有需求共享复用)。内容包含:

- 技术栈(语言/框架/主要依赖)
- 目录结构与关键模块职责
- 代码约定(命名风格、测试框架、格式化/lint)
- 相关已有模块(避免子任务重复造轮子)
- 建议验证命令(从 `package.json scripts` / `Makefile` / CI 配置里找到的构建/测试命令;检测到会提示你 `/wf verify` 采用)

简报生成后自动前置拼进 `prd`/`split`/`review` 三个阶段的 prompt,模型不用每次都重新探查仓库。

- 手动触发:`/wf analyze`(简报已存在则提示跳过,不重复分析)
- 强制刷新:`/wf analyze --refresh`(仓库结构有大改动时用)
- `/wf draft` 检测到没有简报会自动跑一次,无需你记得手动调用

## 内置 skill:计划追问法

仓库自带一个 skill `plan-interrogation`(`skills/plan-interrogation/SKILL.md`),扩展加载时会通过 `resources_discover` 自动挂上(`pi -e .../workflow.ts` 即生效,无需额外 `--skill`)。

它的方法论:在 PLAN 阶段逐条走查设计树、一次只问一个问题并给出推荐答案、达成共识后再继续,能查代码就先查不发问。讨论需求/评审计划时 pi 会按描述自动匹配加载;也可 `/skill:plan-interrogation` 强制载入。

## 产物布局(在目标 repo 内)

```
<repo>/.workflow/
├── _repo-brief.md           # 仓库级简报(/wf analyze,跨需求复用,不属于任何 reqId)
└── <reqId>/
    ├── state.json              # 流水线状态(可断点续看)
    ├── prd.md                  # PRD(glm-5.2)
    ├── subtasks/
    │   ├── 01-*.md ...         # 子任务规格(deepseek-pro)
    │   └── index.json          # 顺序 + depends_on
    ├── results/
    │   ├── NN.metrics.json     # 每个 reasonix run 的 token/cache/cost
    │   ├── cumulative.diff     # 全量累积改动(供 review)
    │   └── summary.json        # 成本 + 平均 cache 命中汇总
    └── review.md               # 整体 review(glm-5.2,建议性)
```

代码改动走 git,**每子任务一个 code commit**(`subtask NN: 标题`),`.workflow/` 工件最后单独一个 commit。

## 浏览器访问(Playwright MCP)

PLAN 阶段(讨论需求 / `/wf analyze`)有时需要读网页(查文档、API 参考)。这层挂在 **pi 编排层**,通过第三方扩展 [`scaryrawr/pi-mcp`](https://github.com/scaryrawr/pi-mcp) 桥接标准 MCP server——**注意 pi 核心本身不内置 MCP**("It intentionally does not include built-in MCP",官方设计原则),必须靠扩展接入。reasonix(执行层)已有自己等价的浏览器/MCP 能力,这里不重复配置,只服务 pi 侧的讨论/分析阶段。

已接好 [`microsoft/playwright-mcp`](https://github.com/microsoft/playwright-mcp)(`.mcp.json`,项目级),PLAN 模式的只读工具锁(`lockReadonly`)会自动放行所有 `playwright_*` 工具,同时仍然拦截本地文件写入。

首次使用需要:
```bash
pi install git:github.com/scaryrawr/pi-mcp -l   # 项目本地安装 MCP 桥接扩展
```
`.mcp.json` 已跟随仓库提交,换机器 clone 后装好 `pi-mcp` 即可用,无需重配。第一次调用 `npx @playwright/mcp@latest` 会有一次性下载(约 15-20 秒)。

## 配置

`workflow.config.json`(在扩展上级目录)可调:provider endpoint / 模型 id、各阶段角色、reasonix 二进制名 / 模型 / 超时、默认验证命令、commit 前缀。改完 `/reload` 或重启 pi。

## 缓存说明

- 每个子任务是独立的 `reasonix run`(独立 session),命中 DeepSeek **服务端前缀热缓存**(成本大头)。
- 跨需求换 session,前缀缓存仍复用。串行执行内每个 run 的 append-only log 也会自行热身。
- pi 侧多模型切换(pro/glm)天然会各走各的缓存桶,属于预期,量小无碍。

## 安全 / 边界

- `reasonix run` autonomous(不卡审批)但仍遵守其 `deny`(默认已拦 `git push`、`rm -rf`),sandbox 限写在目标 repo 内。
- PLAN 模式下扩展会拦截 pi 对 `.workflow/` 以外文件的 `write`/`edit`(对真实代码只读)。
- review 为建议性,不自动改代码、不自动回环。

## 测试

```bash
node --experimental-strip-types test/build.test.ts
```
用假 reasonix + 临时 git repo 端到端验证 build 流水线(依赖门控、失败即停、下游 skip、no-change、每子任务 commit、指标汇总),无需 API。

## 已验证(真实冒烟)

在一个临时 git repo 上跑通过完整 `plan → build` 真实链路(deepseek-pro 讨论 → glm-5.2 写 PRD → deepseek-pro 拆 2 个带依赖的子任务 → reasonix/deepseek-flash 逐个实现并各自 commit → glm-5.2 产出 review.md → 工件单独提交)。要点:

- reasonix `-metrics` 真实字段为 `prompt_tokens / completion_tokens / cache_hit_tokens / cache_miss_tokens / cost(¥) / steps …`,**没有现成的命中率字段**;`summary.json` 由 `cache_hit_tokens / (hit+miss)` 计算命中率(实测子任务命中约 93.6%),成本直接累加 `cost`。
- glm(z.ai)偶发 `Connection error.`,各 LLM 阶段带**最多 3 次重试**,瞬时错误可自动恢复。
- PLAN 模式下扩展把 pi 工具限制为只读(`read/grep/find/ls`),讨论/计划阶段无法改动真实代码;PRD/拆分/review 由模型**返回文本、扩展落盘**,不依赖模型的 write 工具。

## 备注

- reasonix `run` 每个子任务是独立 session;若网络受限访问 z.ai,给 pi 配好代理可减少 `Connection error` 重试。
- glm-5.2 endpoint / 模型 id 默认 `https://api.z.ai/api/coding/paas/v4` + `glm-5.2`;版本不同在 `workflow.config.json` 调整。
