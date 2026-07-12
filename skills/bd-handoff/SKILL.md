---
name: bd-handoff
description: 跨 agent session 交接工作状态,把进度、决策、待办固化进 beads 而非本地文件。用于经理↔dev 交接、reasonix session --continue 复用、经理退出前汇报、多 session 恢复上下文。核心是 beads 是跨 session 权威状态层,交接信息写进 bd comment/issue,不写本地 handoff markdown。触发词:交接、handoff、session 复用、--continue、经理退出、恢复上下文、多 session、进度同步、跨 session。
---

# bd-handoff · 跨 session 交接

在 pi-workflow 的经理驱动架构里,有多个 agent session 并存(经理进程 + N 个 dev session)。这个 skill 规范化它们之间如何交接工作状态。

**核心原则:beads 是跨 session 的权威状态层。** 交接信息写进 bd 的 comment/issue/依赖,而不是本地 markdown handoff 文件——因为本地文件别的 session 看不到,而 bd 跨 worktree/进程共享。

## 何时使用

- **经理 → dev**:经理把 task 分配给 dev 时,通过 bd issue 的 notes/规格文件传递上下文。
- **dev → 经理**:dev 完成/失败后,通过 bd issue 的状态 + comment 回报。
- **经理退出前**:经理进程结束前,把整体进度汇总写进 epic 的 comment。
- **dev session 复用**:同一 dev 的连续 task 通过 `--continue` 复用 session,交接是隐式的(session 记得前一个 task)。

## session 模型(理解交接的前提)

pi-workflow 有这些 session:

| session | 宿主 | 生命周期 | 跨调用复用 |
|---|---|---|---|
| 主 omp session | omp | 整个交互(PLAN + 启动执行) | 天然复用(就是当前对话) |
| 经理 omp 进程 | omp `--print` | 一次 `/execute` 到经理退出 | **不复用**(每次 /execute 新进程) |
| dev reasonix session | reasonix | dev 池存活期间 | **`--continue` 复用**(同一 dev 的连续 task) |

**关键**:
- 经理进程每次 `/execute` 都是全新的——它的上下文来自 PRD + bd 状态 + manager.md,**不依赖上一次 /execute 的内存**。所以经理要做的事必须落 bd,不能留在自己 session 里。
- dev session 通过固定 worktree 路径定位:`~/.reasonix/projects/<escaped-worktree-path>/sessions/`。worktree 路径不变 → session 路径稳定 → `--continue` 能找到并恢复。

## 交接协议

### 经理 → dev(分配 task)

经理调 `assign_dev(taskId, devId)`。工具内部:
1. `bd show <taskId>` 读规格文件路径(从 notes)。
2. `bd update <taskId> --claim --assignee dev<id>-<reqId>`(状态 → in_progress)。
3. 启动 reasonix,把"实现这个子任务,规格在 <文件>"作为指令传入。

**交接信息载体**:bd issue 的 `notes` 字段(指向规格文件)+ 规格文件内容。dev 读这两样就够了。

### dev → 经理(完成/失败回报)

dev 跑完后,`assign_dev` 工具根据 reasonix 退出码处理:
- **成功**:`bd close <taskId>` + commit + merge。dev 的产出在 git commit 里,经理看 git log。
- **失败**:`bd reopen <taskId>` + `bd comment <taskId> "dev<id> reasonix 失败(退出码 N)"`。task 回到队列,经理可重试或换 dev。

**交接信息载体**:bd issue 的状态(closed/reopened)+ comment(失败原因)+ git commit(产出)。

### 经理退出前(整体汇报)

经理进程结束前(所有 task+bug 关闭,或决定停止),在**父 epic** 上留一条汇总 comment:

```bash
bd comment <epicId> "执行完成汇总:处理 N 个 task(dev1: x 个, dev2: y 个),M 个 bug 已修。cache 命中率 z%。剩余待办:..."
```

这样下次 `/execute` 或 `/wf status` 时,经理/用户能从 epic comment 看到上次执行的全貌。

### dev session 复用(--continue,隐式交接)

同一 dev 的连续 task 通过 `--continue` 复用 session——**不需要显式交接**。dev 的 reasonix session 记得:
- 前一个 task 做了什么(项目理解已建立)。
- 代码库结构(不用重新 explore)。
- 之前踩过的坑。

**这是上下文复用的核心收益**:经理把有依赖链的一串 task(A→B→C)给同一个 dev,就是为了让 dev 在 A 建立的上下文上直接做 B、C,不用重新读项目。

## 重要约束

- **不创建本地 handoff markdown 作真相源**:交接信息写 bd。本地 `.workflow/` 里的文件是产物(prd.md、规格、diff),不是状态载体——状态在 bd。
- **进度写 bd comment,不写本地 TODO**:dev 遇到阻碍,`bd comment` + 建 bug;不要写本地 `TODO.md`——别的 session 看不到。
- **reasonix `-dir` 不能变**:dev 的 worktree 路径固定(在 dev 池创建时锁定),改了会找不到旧 session,`--continue` 失效。dev 池(`extensions/dev-pool.ts`)已保证这点。
- **经理不自以为是地跳过 bd**:经理每一步都经 bd(claim/close/comment),不依赖内存——因为经理进程随时可能退出。

## reasonix 执行层注意

> 交接场景下 bd 操作的接口要点(完整接口表见 bd-work skill):

- **`--dolt-auto-commit on` 必需**:交接的核心是跨进程可见性——不带这个 flag,你写的 comment 别的 session/process 看不到。
- **`-C <repo>`**:你在 worktree 里,操作 bd 时指向主 repo 或用 worktree 共享路径。
- **comment 单数**:`bd comment <id> "text"` 写一条;`bd comments <id>` 读列表(复数)。
- **查状态恢复上下文**:`bd show <id> --json`(单 task)、`bd children <epicId> --json`(整个 epic 的子任务)、`bd list --status=in_progress --json`(所有进行中的)。
- **禁用 `bd edit`(交互卡死)、`bd doctor --fix`(误删依赖)**。
- **JSON 解析剥离前导 warning 行**(bd 可能在 JSON 前输出 warning)。

## 交接信息该放哪(速查)

| 信息类型 | 放哪 | 为什么 |
|---|---|---|
| task 规格 | `.workflow/<reqId>/subtasks/NN-*.md` + bd notes 指向 | dev 读规格文件;bd notes 是指针 |
| task 完成/失败 | bd issue 状态(closed/open) | 状态机权威 |
| 失败原因 | bd comment | 跨 session 可见 |
| 阻碍 | bd bug issue + `dep add --type=blocks` | 进 ready 队列的 blocker 统计 |
| 整体执行汇总 | 父 epic 的 bd comment | 下次 /execute 或 /wf status 可读 |
| 代码产出 | git commit(每子任务一个) | git 是代码层权威 |
| 临时草稿 | agent 本地内存(当前 turn) | 不要当跨 session 真相源 |
