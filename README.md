# pi-workflow

一个 [pi coding-agent](https://pi.dev) 扩展,把“需求讨论 → GLM PRD → Beads task → dev/reviewer → 确定性验证 → GLM 最终审查”做成 **plan / build 两模式**流水线。没有 active epic 时就是普通 Pi；`/wf resume` 从全部 Beads epic 中选择或重建上下文。build 模式的主 session 是**对代码只读的经理**,所有代码写入只由串行 dev subagent 完成。

> 历史注记:本项目早期基于 omp(opencode fork)构建,后随上游迁移到 pi(`@earendil-works/pi-coding-agent`)。文档里如出现 omp 字样均指这段历史。

## 架构（主 session 是只读经理）

```text
普通 Pi（无 active epic）
  /wf new 或 /wf resume → plan

plan（代码只读）:
  需求讨论                    → deepseek-pro
  /wf prd                     → fork 的 prd-writer(GLM-5.2)生成并回显 prd.md
  /execute                    → 要求 verifyCommand 非空,进入 build

build（manager 对代码只读）:
  split_prd_to_tasks          → 受控写规格 + Beads task
  bd_task(claim)
  subagent(pi-workflow.dev)               → 串行实现/验证/commit
  subagent(pi-workflow.reviewer)          → GLM task review
  bd_task(close/reopen)       → commit-range + verify 硬门
  run_verify                  → extension 只运行预配置命令,写 verify.json/diff
  subagent(pi-workflow.final-reviewer)    → GLM 对 PRD/verify/diff 做最终验收
  finalize_test               → 结构化 pass 或受控创建 Beads bug
  /wf done                    → 清除 active epic,恢复普通 Pi
```

manager 没有 `bash`/`write`/`edit`;只开放只读工具、`subagent` 和窄化的 workflow tools。当前 writer 上限固定为 1,禁止 `worktree:true` 并行 writer。`tool_call` hook 进一步强制 namespaced agent、精确 cwd/output/context、单 writer lease，并在每次调用前拒绝 target/user agent shadow 或 settings override。

## 模型分工

| 阶段 | 执行方 | 模型 |
|---|---|---|
| 讨论需求 | 主 pi | deepseek-pro (`deepseek-v4-pro`) |
| 写 PRD | `pi-workflow.prd-writer` subagent | GLM-5.2 |
| 技术经理 | 主 session（代码只读） | deepseek-pro |
| 实现每个 task | `pi-workflow.dev` subagent（串行 writer） | deepseek-flash |
| task 审查 | `pi-workflow.reviewer` subagent | GLM-5.2 |
| 运行验证命令 | extension `run_verify` | 确定性代码 |
| 最终验收 | `pi-workflow.final-reviewer` subagent | GLM-5.2 |

build 模式时 manager-prompt.md 注入主 session。manager 使用 `split_prd_to_tasks` / `bd_query` / `bd_task` / `run_verify` / `finalize_test` 和 `subagent`,没有通用 shell 权限。四个 agent 使用 `pi-workflow.*` 命名空间，package 通过 `pi.subagents.agents` 暴露；`wfpi` 本地源码模式通过 `PI_SUBAGENT_EXTRA_AGENT_DIRS` 暴露，避免任意目标仓库中找不到 agent 或误解析同名 user agent。provider 使用 `$DEEPSEEK_API_KEY`、`$GLM5_2_API_KEY`（扩展会为 child bridge 到 `ZAI_API_KEY`）。

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

两种 workflow 状态是 plan / build；没有 active epic 时是普通 Pi：

1. `/wf new <需求名> [目标repo路径]` — 创建 Beads epic 并进入 plan。
2. 自由讨论需求。
3. `/wf prd` — fork 当前讨论,由 `pi-workflow.prd-writer`（GLM-5.2）生成 `prd.md`,主 session 展示正文。
4. `/wf verify <cmd>` — 设置不可为空的验证命令。
5. `/execute` — 主 session 作为代码只读经理,串行委派 dev/reviewer。
6. 全部 task closed 后执行 `run_verify → final-reviewer → finalize_test`。
7. `/wf done` — 清除 active epic,恢复普通 Pi。
8. `/wf resume` — UI 展示全部 Beads epic；缺 state 的 epic 可确认重建。

**先看计划再动手**:`/execute --dry-run` 只让经理拆 task + 汇报计划(拆分结果会真的建成 bd task 方便审阅依赖图),**不派 dev、不改代码**。确认后再跑 `/execute`；split 工具会检测当前 epic 已有 task 并复用，避免 dry-run→execute 或 resume 时重复创建任务图。

**跑歪了回滚**:`/wf abort` 把目标 repo `git reset --hard` 回 `/execute` 时记录的 baseline,并把 epic 下的 task 全部 reopen。执行前会列出将丢弃的 commit / 改动统计 / 未提交改动并要求确认,`.workflow/` 工件会先提交一次保留作审计记录。**不可逆,谨慎使用。**

辅助命令:`/wf analyze [--refresh]`、`/wf status`、`/plan`、`/wf abort`。`/wf verify` 的命令不能为空；没有验证命令时 `/execute` 直接报错。

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

## dev writer 与安全串行(`maxParallel`)

`workflow.config.json` 的 `execute.maxParallel` 当前固定为 **1**。每个 dev 是一次 fresh pi-subagents subagent spawn,直接在目标仓库串行实现、验证并 commit:

- 当前禁止 `subagent({tasks:[...], worktree:true})` 并行 writer。pi-subagents 的 worktree 模式只生成 patch/handoff manifest,不会自动把 child commit 合并回目标仓库。
- `bd_task(claim)` 会保存 `<taskId>.claim.json` baseline;`bd_task(close)` 校验 dev 的 `commitSha` 必须形成 claim 后的非空 commit range,且已进入目标仓库 HEAD。未集成或复用旧 commit 都会自动 reopen,避免“task 已关闭但代码没落地”。
- 跨 task 上下文靠:(a) `cache.ts` 冻结 system-prompt date 保持 DeepSeek 前缀缓存;(b) bd comments 显式携带状态。
- dev 在 subagent 内部闭环验证(write → verify → fix),再 commit 并返回结构化结果;经理随后 reviewer + close/reopen。
- 后续只有在实现确定性的 handoff patch 集成工具后,才应重新开放并行 writer。

**缓存安全性已实测验证**(详见 `DECISION_LOG.md`):worktree 路径不破坏 DeepSeek 前缀缓存。

## 验证门(P0 安全)

`/execute` 在进入 build 前强制要求非空验证命令。`bd_task(claim)`、`bd_task(close)` 和最终 `run_verify` 会重复检查；不存在“显式接受无验证”或静默跳过路径。dev 自己先跑同一命令，extension 再做确定性复验。

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
    │   ├── split.json            # PRD hash + creating/complete/failed split manifest
    │   ├── prd-generation.json   # prd-writer 调用审计(model/usage/result path)
    │   ├── <taskId>.claim.json   # claim 时的 baseline
    │   ├── <taskId>.json         # dev 结构化结果
    │   ├── <taskId>.review.json  # reviewer 结构化判定
    │   ├── cumulative.diff       # baseline..HEAD 全量改动(run_verify 写)
    │   ├── verify.json           # 确定性验证命令/code/output
    │   ├── final-review.json     # final-reviewer 的严格 JSON verdict
    │   ├── final-review.audit.json # extension 记录实际 child model/usage
    │   └── summary.json          # token/cache/cost 汇总

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
| `execute.maxParallel` | 当前安全上限固定为 1;确定性 worktree handoff 集成完成前禁止并行 writer |

**dev / reviewer / prd-writer / final-reviewer 的模型不在这里配**——它们是 pi-subagents agent,模型写在 `.pi/agents/*.md` 的 frontmatter(`model:` 字段)里。

`execute.driver` 只实现了 `"bd"`;`execute.pollIntervalMs` 是死字段(当前实现不轮询),保留仅为兼容旧配置。

改完 `/reload` 或重启 pi。

## 缓存说明

- 每个子任务由一个独立的 pi dev subagent run 承担(`subagent({agent:"pi-workflow.dev"})`),命中 DeepSeek **服务端前缀热缓存**(成本大头)。
- **worktree 并行不击穿缓存**(实测):worktree 的 cwd 差异不注入 pi system prompt,前缀缓存跨 worktree 共享。详见 `DECISION_LOG.md`。
- pi 侧多模型切换(pro/glm)天然会各走各的缓存桶,属于预期,量小无碍。

### pi 侧缓存优化(`extensions/cache.ts`)

pi 的 system prompt 里有动态 date 字段(`Today is YYYY-MM-DD,`),每天午夜变一次,击穿 DeepSeek 前缀缓存。本扩展用 `before_agent_start` hook,**只对 DeepSeek 模型**把 date 冻结成固定常量,让讨论/拆分/PRD/review 阶段的前缀字节稳定:

- **dev subagent 执行层**:cache.ts 同样覆盖——每次 `subagent({agent:"pi-workflow.dev"})` spawn 的 pi dev subagent 启动时 system-prompt 的 date 被冻结成同一常量,前缀缓存跨 task / 跨 dev 保持热度(取代了原 reasonix 执行层自带的字节级缓存优化,~99.8% 命中率被保留)。
- **pi 讨论层**:`cache.ts` 冻结 date → 前缀跨 turn/midnight 稳定 → 缓存命中。
- **telemetry**:`message_end` hook 累计 DeepSeek 的 `prompt_cache_hit_tokens`,每 5 turn 通知一次命中率。
- 只对 DeepSeek 生效(glm/zai 不用前缀缓存,冻结无益)。

> 为什么自写不用 `@rohaquinlop/pi-deepseek-cache`:该插件 import `@earendil-works/pi-coding-agent` 的 `serializeConversation`,但 omp 16.4.6 的 shim 没导出它(fork 重构进了 `snapcompact` 命名空间),`pi plugin install` 验证失败。本扩展用 pi 原生 hook,零第三方依赖。(注:omp 是 pi 的前身,这段历史记录保留以解释为何自写缓存 hook。)详见 `DECISION_LOG.md`。

## 安全 / 边界

- pi dev subagent autonomous(不卡审批)但仍遵守 pi 的 `deny`(默认已拦 `git push`、`rm -rf`),sandbox 限写在目标 repo 内。
- plan 模式只开放只读工具和 `subagent`(用于 PRD writer);build manager 也没有 `bash`/`write`/`edit`,代码写入只能委派给单个 dev writer。
- **验证门无绕过**:无验证命令时 `/execute` 直接失败；task close 和 final verify 会重跑预配置命令。
- final-reviewer 没有 shell,只读 PRD、diff 和 verify evidence；`finalize_test` 只接受绑定当前 command/HEAD/PRD hash/diff hash/runId/实际 GLM audit 的结构化 JSON,失败时确定性创建 blocker/major bug。
- BUILD 中拒绝 `/wf new`；`/wf done` 清除 active epic 并恢复普通 Pi。
- 子任务拆分的 JSON 解析严格校验,失败响亮报错。

## 测试

```bash
npm test
npx tsc --noEmit
```

回归测试覆盖 Beads argv、空验证硬门、commit range 集成、manager 工具白名单（无 bash）、GLM agent 配置、PRD/final review wiring、resume 重建与 telemetry。

## 已验证(真实冒烟)

详见 `DECISION_LOG.md`:worktree 缓存安全性实测、bd 1.1.0 真实接口验证。

## 备注

- 每个 pi dev subagent 是独立的一次 `subagent({agent:"pi-workflow.dev"})` run;若网络受限访问 z.ai,给 pi 配好代理可减少 `Connection error` 重试。
- glm-5.2 endpoint / 模型 id 默认 `https://api.z.ai/api/coding/paas/v4` + `glm-5.2`;版本不同在 `workflow.config.json` 调整。
- bd 1.1.0 真实命令与官方文档有差异(用 `assign`/`comment`/`config.yaml`,无 `pin`/`hook`);以 `extensions/bd.ts` 封装为准。
