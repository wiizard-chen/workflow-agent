---
name: bd-split
description: 把 PRD 拆成尽量独立、可单独实现与验证的 beads task(带依赖关系)。用于执行模式开始时、split_prd_to_tasks 工具调用、PRD 拆子任务。核心是用 tracer-bullet 垂直切片原则拆分,并按"独立 task 散给不同 dev、依赖链给同一 dev"的路由策略标注依赖。触发词:拆 PRD、拆子任务、split、split_prd_to_tasks、任务拆分、依赖图、tracer bullet、垂直切片。
---

# bd-split · PRD → beads task + 依赖

把一份 PRD 拆成一组**尽量独立、可单独实现与验证**的子任务,每个 task 创建为 beads issue 并挂在父 epic 下,依赖关系用 `bd dep add` 标注。这是 pi-workflow 主 session 即经理架构(build 模式)里经理的第一个动作。

> **角色定位**:这个 skill 主要给**主 session(build 模式,即经理)**用。经理调 `split_prd_to_tasks(prd_path)` 工具时,工具内部跑这个拆分逻辑。pi dev subagent 不拆分——dev 只实现经理用 subagent 工具分配给它的单个 task。

## 何时使用

- `/execute` 进入 build 模式后,经理(主 session)读 PRD 的第一步。
- `split_prd_to_tasks` 工具被调用时。
- 任何"把 PRD/规格转成可执行任务清单"的场景。

## 拆分原则(tracer-bullet 垂直切片)

### 核心思想:每个 task 是一个可独立提交的垂直切片

- **垂直**:每个 task 切透所有相关层(schema → API → UI → 测试),不是水平切一层。
- **窄而完整**:每个 task 交付一条窄但完整的路径,完成后可独立 demo 或验证。
- **宁可多个薄片,不要少数厚块**:薄片复用 session 更高效,失败定位更准。

### 依赖最小化(为了 dev session 复用)

拆分的首要目标是**最小化 task 之间的上下文依赖**:

- **独立的 task**(无真实依赖)→ 可以并行调 subagent 分配给不同 dev,让多个 pi dev subagent 同时认知项目(cache.ts 前缀缓存让每个 dev 的公共前缀便宜;并行度取代了 session 复用作为提速手段)。
- **有真实依赖的一串 task**(比如 B 必须在 A 改动的基础上才能做)→ 标注 `depends_on`,经理会把这一串依次用 subagent 分配给 dev。dev 不再有持久 session,但 cache.ts 前缀缓存(冻结系统提示日期)让公共前缀几乎免费复用,bd comment 携带跨 task 上下文——所以"连续做依赖链"仍然比"散给不同 dev 重头认知"更省 token。
- **没有真实依赖就不要人为制造依赖**:两个 task 都改同一个文件不代表有依赖——只有"B 的实现必须基于 A 的产出"才是真依赖。

## 拆分步骤

### 1. 读 PRD,理解全貌

先读 `.workflow/<reqId>/prd.md`(以及自动前置的仓库简报)。理解需求的全部范围和验收标准。

### 2. 草拟垂直切片清单

在脑中列出所有候选 task,每个标注:
- **标题**:短、动词开头(如"添加用户注册端点")。
- **依赖**:是否必须等别的 task 先完成。
- **验收**:怎样算这个 task 完成。

### 3. 产出严格 JSON(供工具解析)

`split_prd_to_tasks` 工具的 split 阶段用 `deepseek-pro`,只输出严格 JSON:

```json
{"subtasks":[
  {"id":"01","title":"标题","depends_on":[],"spec":"完整 Markdown 规格"},
  {"id":"02","title":"标题","depends_on":["01"],"spec":"完整 Markdown 规格"}
]}
```

要求:
- `id` 从 `01` 递增;**被依赖者在前面**(01 被 02 依赖,则 01 排前)。
- `depends_on` 用其他 task 的逻辑 id(如 `"01"`),不是 bd id(bd id 拆分时还没创建)。
- 每个 `spec` 是完整的 Markdown 规格,dev 拿到它就能独立实现——包含背景、要做什么、验收标准、范围边界。

### 4. 写规格文件 + 建 bd task

对每个拆出的 task:

```bash
# a) 写规格文件(dev 会读这个)
# 路径: .workflow/<reqId>/subtasks/01-<slug>.md

# b) 建 bd task,挂在父 epic 下,notes 指向规格文件
bd create "<task 标题>" --type=task --parent=<epicId> --notes="规格文件:<绝对路径>" --json
```

### 5. 标注依赖(blocks 类型)

```bash
# dependent 依赖 dependency(dependency blocks dependent)
bd dep add <dependent_bd_id> <dependency_bd_id> --type=blocks
```

**注意参数顺序**:`bd dep add <dependent> <dependency>` —— 第一个参数是被阻塞的(后续 task),第二个是阻塞方(前置 task)。

## 关键接口提醒(beads 真实行为)

这些是 `extensions/bd.ts` 已验证的真实行为(与官方文档有差异),拆分时必须遵守:

- **`bd ready` 包含 parent epic**:调度时必须按 `issue_type === "task"` 过滤,否则会把 epic 当任务分配给 dev。本项目的 `readyTasks()` 已封装了这个过滤。
- **只有 `--type blocks` 会阻塞**:`bd dep add ... --type blocks` 才进 ready 队列的 blocker 统计;`parent-child`、`related`、`discovered-from` 都**不阻塞**。所以要表达真实依赖,必须用 `--type blocks`。
- **id 格式**:`bd-<reponame>-<hash>` + `.1/.2/.3` 子节点(如 `workflow-agent-73i.1`)。拆分建出来的 task 是 `<epic>.<n>`。

## 反模式(要避免)

- **水平切片**:把"所有 schema 改动"放一个 task、"所有 API"放一个 task——这破坏了独立可验证性,且制造了人为依赖。
- **task 过大**:一个 task 覆盖多个用户故事 → dev session 上下文膨胀、失败难定位。拆小。
- **task 过细**:一个函数级改动也建 task → bd 开销超过收益。每个 task 应该是一个可独立 commit 的改动。
- **人为依赖**:两个 task 改同一文件就标依赖 → 只有"B 必须基于 A 的产出"才是真依赖,同文件改动 git 会合并。
- **规格太薄**:`spec` 只有标题没有验收标准 → dev 实现时只能猜,验证门无法判定。

## pi subagent 执行层注意

> pi dev subagent 通常不调用 split(拆分是经理的职责)。但 dev 实现时会读规格文件,以下 bd 接口在 dev 回查依赖关系时有用:

- **`--dolt-auto-commit on` 必需**:跨进程/worktree 可见性的前提。本项目 `defaultBdExec` 已默认带;手动调要带。
- **`-C <repo>` 全局 flag**:任意 cwd 操作目标 repo。
- **`--json` 程序化解析**:加 `--json`,注意剥离前导 warning 行。
- **查依赖**:`bd show <id> --json` 返回 issue 的依赖字段;`bd children <epicId> --json` 列出所有子 task。
- **分配用 `bd assign`**(不是 `pin`),原子认领用 `bd update <id> --claim`。
- **备注用 `bd comment <id>`(单数)**,禁用 `bd edit`(开交互编辑器)、`bd doctor --fix`(误删依赖)。
- **依赖只有 `--type blocks` 阻塞**:parent-child 不阻塞,不要混淆。
