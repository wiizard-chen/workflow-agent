---
name: bd-plan
description: 把一个想法或需求变成 beads epic + PRD 的 PLAN 阶段技能。用于讨论需求、生成 PRD、/wf prd 之前的需求收敛。方法是与用户讨论(一次一个问题、给推荐答案),先把需求收敛成 beads 父 epic,再让 glm-5.2 把讨论结果固化成 prd.md。触发词:讨论需求、写 PRD、PLAN 阶段、/wf prd、需求分析、prd、plan、需求收敛。
---

# bd-plan · 需求 → beads epic + PRD

把一个想法或需求,在 beads 里落成一个**父 epic**,并把讨论结果固化成 `prd.md`。这是 pi-workflow 流水线的第一段(PLAN 模式)。

> **角色定位**:这个 skill 主要给**主 session omp** 用(PLAN 模式对代码只读)。omp dev subagent 在执行阶段不调用它——dev 只做单个 task,不参与需求讨论。

## 何时使用

- 用户提出一个新需求,要进入 pi-workflow 流水线。
- `/wf new <需求>` 之后、`/wf prd` 之前的讨论阶段。
- 需要把散乱的讨论收敛成结构化 PRD。

## 工作流程

### 1. 建父 epic(需求落 beads)

讨论开始前,先把需求落成 beads 父 epic——这是整个需求的容器,后续所有 task/bug 都挂在它下面:

```bash
bd create "<需求名>" --type=epic --description="<一两句话说明这个需求要解决什么>" --json
```

记下返回的 epic id(形如 `workflow-agent-xxx`),后续 `/wf prd`、`/execute` 都要引用它。

### 2. 仓库简报(首次自动,跨需求复用)

第一次接触一个目标 repo 时,`/wf prd` 会自动先跑一次只读探查,产出 `.workflow/_repo-brief.md`(仓库级,跨需求复用)。

- 已存在则跳过;手动刷新:`/wf analyze --refresh`。
- 这份简报会自动前置拼进 prd/split/review 的 prompt,**不要手动编辑**它。

### 3. 讨论需求(收敛不确定性)

用 **plan-interrogation** skill 的方法逐条走查设计树:一次只问一个问题、给出推荐答案、能 grep/read 查证的先自己查。讨论模型是 `deepseek-pro`(强推理)。

讨论要覆盖:
- **问题陈述**:用户面临的什么问题,从用户视角。
- **范围边界**:做什么、不做什么(明确排除项)。
- **验收标准**:怎样算完成(可验证的条件)。
- **技术约束**:必须遵守的架构/依赖/性能约束。

### 4. 生成 PRD

讨论收敛后,调 `/wf prd`——它会用 **glm-5.2** 把讨论结果固化成 `.workflow/<reqId>/prd.md`。PRD 落盘,不是留在对话里。

审阅 `prd.md`:
- 满意 → `/execute` 进入执行模式(经理接管)。
- 不满意 → 继续讨论后再 `/wf prd`(覆盖重生成)。

## PRD 模板(参考)

一份合格的 prd.md 至少包含:

```markdown
# <需求标题>

## 问题陈述
<用户视角的问题>

## 方案
<用户视角的解决方案>

## 用户故事
1. 作为 <角色>,我想要 <功能>,以便 <价值>
2. ...

## 验收标准
- [ ] <可验证的条件 1>
- [ ] <可验证的条件 2>

## 范围外(明确排除)
- <不做的事项>

## 技术约束
- <必须遵守的约束>
```

## 重要约束

- **PLAN 模式对代码只读**:扩展会拦截对 `.workflow/` 以外文件的 write/edit。讨论时可以读代码,但不要改代码。
- **PRD 是文档,不是 bd issue**:PRD 落到 `.workflow/<reqId>/prd.md`;beads 里只放 epic(需求容器)和后续的 task/bug。不要把整份 PRD 塞进 bd issue 的 description。
- **需求讨论用 deepseek-pro,PRD 写作用 glm-5.2**:模型分工在 `workflow.config.json` 的 `roles.discuss` / `roles.prd` 配置,不要混用。
- **不要跳过讨论直接写 PRD**:PRD 的价值来自讨论收敛的不确定性,不是模板填空。

## omp subagent 执行层注意

> 此 skill 主要给主 session omp 用,omp dev subagent 通常不直接调用。但如果 dev subagent 在执行 task 时需要回查需求背景,以下是 beads 操作的真实接口(已在 `extensions/bd.ts` 验证,与官方文档有差异):

- **`--dolt-auto-commit on` 必需**:bd 默认 off 时 Dolt 写只在内存 working set,跨进程/worktree 看不到。本项目的 `defaultBdExec` 已默认带这个 flag,手动调 bd 时也要带。
- **`-C <repo>` 全局 flag**:任意 cwd 操作目标 repo(类似 git -C),不用 cd。
- **`--json` 程序化解析**:需要结构化数据时加 `--json`;注意 bd 可能在 JSON 前输出 warning 行(如 "beads.role not configured"),解析时要剥离前导非 JSON 行。
- **原子认领用 `bd update <id> --claim`**(不是文档说的 `pin`,`pin` 命令在 1.1.0 不存在)。
- **分配用 `bd assign <id> <name>`**(单数命令)。
- **备注用 `bd comment <id> "text"`**(单数,不是 `comment add`)。
- **禁用 `bd edit`**(开交互编辑器,headless 下会卡死)、**禁用 `bd doctor --fix`**(会误删合法 parent-child 依赖)。
- **`bd ready` 包含 parent epic**:调度时必须按 `issue_type === "task"` 过滤,否则会把 epic 当任务执行。
- **依赖阻塞只有 `--type blocks`**:`bd dep add <dependent> <dependency> --type blocks` 才进 ready 队列的 blocker 统计;parent-child / related / discovered-from 都不阻塞。
