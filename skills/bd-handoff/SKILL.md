---
name: bd-handoff
description: 跨 agent session 交接工作状态,把进度、决策、待办固化进 beads 而非本地文件。用于经理↔dev 交接、pi dev subagent 跨 task 复用上下文、build 结束前汇报、多 session 恢复上下文。核心是 beads 是跨 session 权威状态层,交接信息写进 bd comment/issue,不写本地 handoff markdown。触发词:交接、handoff、session 复用、跨 task 上下文、经理退出、恢复上下文、多 session、进度同步、跨 session。
---

# bd-handoff · 跨 session 交接

在 pi-workflow 的主 session 即经理架构里,有多个 agent session 并存(主 session + N 个 dev subagent)。这个 skill 规范化它们之间如何交接工作状态。

**核心原则:beads 是跨 session 的权威状态层。** 交接信息写进 bd 的 comment/issue/依赖,而不是本地 markdown handoff 文件——因为本地文件别的 session 看不到,而 bd 跨 worktree/进程共享。

## 何时使用

- **经理(主 session)→ dev**:经理把 task 分配给 dev 时,通过 bd issue 的 notes/规格文件传递上下文。
- **dev → 经理**:dev 完成/失败后,通过 output JSON 文件 + bd issue 的状态 + comment 回报。
- **build 结束前**:`/wf done` 退出 build 模式前,把整体进度汇总写进 epic 的 comment。
- **dev 跨 task 复用**:同一 dev 的连续 task 不再有持久 session——每次 `subagent` 都是 fresh spawn,上下文复用靠 bd comment(显式交接)和 cache.ts 前缀缓存(DeepSeek 系统提示日期冻结,保持前缀缓存命中)。

## session 模型(理解交接的前提)

pi-workflow 有这些 session:

| session | 宿主 | 生命周期 | 跨调用复用 |
|---|---|---|---|
| 主 pi session | pi | 整个交互(idle / plan / build 三模式) | 天然复用(就是当前对话) |
| dev pi subagent | pi-subagents `subagent` | 单个 task 的执行 | **不复用**(每次 subagent 调用都是 fresh spawn,上下文靠 bd + cache.ts) |

**关键**:
- **经理就是主 session 自己**(build 模式下)。manager-prompt.md 在 `/execute` 时注入主 session,主 session 直接跑流水线,用户可观察。没有独立经理进程,所以"经理进程每次新启动"这个问题不存在了——但主 session 仍是单一职责,要做的事还是必须落 bd,不能留在内存里。
- dev 不再有持久 session 路径(原 `~/.reasonix/projects/<escaped-worktree-path>/sessions/` 机制早已废弃)。每个 task 是 `subagent({agent:"dev"})` fresh spawn 的 pi subagent(定义在 `.pi/agents/dev.md`,在专属 worktree 里跑),无 session 复用。跨 task 上下文复用靠:**(a) bd comment(显式交接进度/坑/决策)** + **(b) cache.ts 前缀缓存(冻结 DeepSeek 系统提示里的日期,保持 prompt 前缀稳定,命中 DeepSeek prefix cache)**。

## 交接协议

### 经理(主 session)→ dev(分配 task)

经理先调 `bd_task(action="claim", taskId)`,再调 `subagent({agent:"dev", task="..."})`。bd_task 工具内部:
1. `bd show <taskId>` 读规格文件路径(从 notes)。
2. `bd update <taskId> --claim --assignee dev<id>-<reqId>`(状态 → in_progress)。

然后 `subagent({agent:"dev", ...})` spawn 一个 pi dev subagent(定义在 `.pi/agents/dev.md`),把"实现这个子任务,规格在 <文件>"作为指令传入,在专属 worktree 里执行。

**交接信息载体**:bd issue 的 `notes` 字段(指向规格文件)+ 规格文件内容。dev 读这两样就够了。

### dev → 经理(完成/失败回报)

dev 跑完后,把结构化结果写进一个 output JSON 文件(路径由经理在调 subagent 时指定,落在 `.workflow/<reqId>/results/`),经理读这个文件决定下一步:
- **成功**:`bd close <taskId>` + commit + merge。dev 的产出在 git commit 里,经理看 git log。
- **失败**:`bd reopen <taskId>` + `bd comment <taskId> "dev<id> dev subagent 失败(<一句话原因>)"`。task 回到队列,经理可重试或换 dev。

**交接信息载体**:output JSON 文件(dev 的结构化返回)+ bd issue 的状态(closed/reopened)+ comment(失败原因)+ git commit(产出)。

### build 结束前(整体汇报)

`/wf done` 退出 build 模式前(所有 task+bug 关闭,或决定停止),在**父 epic** 上留一条汇总 comment:

```bash
bd comment <epicId> "执行完成汇总:处理 N 个 task(dev1: x 个, dev2: y 个),M 个 bug 已修。cache 命中率 z%。剩余待办:..."
```

这样下次 `/execute` 或 `/wf status` 时,经理/用户能从 epic comment 看到上次执行的全貌。

### dev 跨 task 上下文复用(cache.ts + bd,显式交接)

同一 dev 的连续 task **不再复用 session**(原 `--continue` 机制已废弃)。每次 `subagent({agent:"dev"})` 都是 fresh spawn,什么都不记得。上下文复用靠两条机制,都需要显式落 bd:

- **cache.ts 前缀缓存**(自动):DeepSeek 系统提示里的日期被冻结,prompt 前缀保持稳定 → DeepSeek prefix cache 命中,跨 task 的系统提示 / dev.md / 项目结构说明等"公共前缀"几乎免费复用。
- **bd comment 跨 task 上下文**(显式):dev 把"项目理解、之前踩的坑、关键决策"写进 bd comment。下一个 task 的 dev(即使不是同一个)能从 bd 读到。dev 的 subagent 记得:
  - 前一个 task 做了什么(从 bd comment + git log 读)。
  - 代码库结构(从前缀缓存命中的公共系统提示读)。
  - 之前踩过的坑(从 bd comment 读)。

**上下文复用的核心收益**(现在更显式):经理把有依赖链的一串 task(A→B→C)依次调 subagent(dev),dev 在每个 task 开始时从 bd + cache 读到 A 建立的上下文,直接做 B、C,不用重新读项目——前提是 A 的 dev 把关键发现写进了 bd comment。

## 重要约束

- **不创建本地 handoff markdown 作真相源**:交接信息写 bd。本地 `.workflow/` 里的文件是产物(prd.md、规格、diff、dev 的 output JSON),不是状态载体——状态在 bd。
- **进度写 bd comment,不写本地 TODO**:dev 遇到阻碍,`bd comment` + 建 bug;不要写本地 `TODO.md`——别的 session 看不到。没有持久 session 后,这条**更重要**:dev subagent 返回即失忆,只有 bd comment 是跨 task 记忆。
- **dev worktree 路径固定**:dev 的 worktree 路径(在 dev 池创建时锁定)不变——cache.ts 前缀缓存依赖稳定 worktree + 稳定 dev.md 系统提示的组合,改路径会破坏前缀缓存命中。dev 池(`extensions/dev-pool.ts`)已保证这点。
- **经理(主 session)不自以为是地跳过 bd**:经理每一步都经 bd(claim/close/comment),不依赖内存——因为 build 模式可能因 `/wf done` 或中断而退出,状态必须可恢复。

## pi subagent 执行层注意

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
| dev 结构化返回 | `.workflow/<reqId>/results/*.json`(output JSON) | 经理读这个文件决定 close/reopen |
| 代码产出 | git commit(每子任务一个) | git 是代码层权威 |
| 临时草稿 | agent 本地内存(当前 turn) | 不要当跨 session 真相源 |
