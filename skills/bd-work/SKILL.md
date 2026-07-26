---
name: bd-work
description: 实现单个 beads task 的工作循环:认领 → 读规格 → 实现 → 验证 → 关闭。用于 omp dev subagent 执行 assign_dev 分配的 task、实现子任务、认领工作、关闭完成的 task、报告阻碍。核心是 dev 只做当前 task、不越界、严守验证门、阻碍建 bug。触发词:实现 task、认领、assign_dev、dev 工作、close、done、实现子任务、认领工作、遇到阻碍、blocker。
---

# bd-work · 认领 → 实现 → 关闭(单个 task)

实现**一个** beads task 的标准工作循环。这是 omp dev subagent 在执行阶段最频繁执行的动作——经理每调一次 `assign_dev(taskId, devId)`,dev 就跑一遍这个循环。

> **角色定位**:这个 skill 主要给 **omp dev subagent** 用(执行层,deepseek-flash)。dev 是单一职责执行者:**只实现当前分配的 task,不拆分、不测试、不分配、不越界**。经理(assign_dev 工具)负责 claim 和 bd 状态管理,但 dev 要理解整个循环以便正确报告。

## 何时使用

- 经理调 `assign_dev` 把一个 task 分配给你时。
- 你是一个 omp dev subagent,收到"实现这个子任务"的指令时(每个 task 是一个全新的 omp subagent 进程,上下文由 bd comment + cache.ts 前缀缓存携带,无 session 复用)。
- 实现过程中发现需要建阻碍 bug 时。

## dev 的工作循环

### 1. 认领(由 assign_dev 完成,dev 无需手动 claim)

`assign_dev` 工具内部已经做了原子认领:

```bash
bd update <taskId> --claim --assignee dev<id>-<reqId>
```

dev 收到任务时,task 已经在你名下(状态 = in_progress)。你不需要手动 claim——但如果因某种原因需要重新认领,用上面的命令。

### 2. 读规格(必做)

**动手前先 `bd show` 读完整规格**:

```bash
bd show <taskId> --json
```

规格文件路径在 issue 的 `notes` 字段(形如 `规格文件:<绝对路径>`)。读那个 `.workflow/<reqId>/subtasks/NN-*.md` 文件,理解:
- 这个 task 要做什么(背景 + 目标)。
- **验收标准**(实现到什么程度算完成)。
- **范围边界**(明确不做什么——防止越界)。

### 3. 实现(单一职责)

- **只做这一个 task**:不要顺手实现"看起来相关"的其他 task——那些有它们自己的规格和 dev。
- **严守验收标准**:规格里的验收标准是你的完成判据,不是建议。
- **遵守仓库约定**:读周围代码,匹配既有命名、风格、分层(你已在 worktree 内,代码可见)。

### 4. 验证(验证门)

实现后跑验证命令(在目标 repo 内):

```bash
# 验证命令来自 workflow.config.json 的 build.verifyCommand,或 /wf verify 设置
# 例:npm test / go build ./... / pytest -q
```

**验证门是 P0 安全机制**:
- 没配验证命令 → 默认**失败**(不是静默通过)。这是有意的——避免 dev 无监督写入直接 commit。
- 验证失败 → 不要强行 commit,回去修。
- 验证通过 → 进入提交。

### 5. 关闭 task

实现 + 验证通过后,**由 assign_dev 工具内部关闭**(dev 不需要手动 close,工具会处理 commit → merge → bd close)。但如果 dev 手动管理:

```bash
bd close <taskId> --reason="实现完成,<一句话说明>"
```

### 6. 报告阻碍(建 bug)

如果实现中发现**真实的阻碍**(不是你不会做,而是规格有矛盾、依赖的 task 产出有问题、或发现了 bug):

```bash
# 建 bug,挂在同一 epic 下
bd create "bug: <一句话描述>" --type=bug --parent=<epicId> --description="<详细说明>"

# 标注这个 bug 阻塞当前 task(如果当前 task 因此无法完成)
bd dep add <taskId> <bugId> --type=blocks
```

然后用 `bd comment` 在当前 task 留一条说明:

```bash
bd comment <taskId> "受阻于 bug <bugId>:<原因>。已建 bug,等修复后重试。"
```

## 重要约束

- **不越界**:只实现当前 task 的验收标准。看到"顺便能做"的其他改动——忍住,那是别的 dev 的 task。
- **不跳验证**:验证门失败不能假装通过。验证命令没配 → 报告,不要绕过。
- **不手动 commit 到主分支**:你在 worktree 里,commit 由 assign_dev 工具处理(每个子任务一个 commit,最后 merge)。
- **阻碍用 bd,不用本地文件**:遇到问题建 bd bug,不要写本地 TODO/markdown——bd 才是跨 session 权威,本地文件经理看不到。

## omp subagent 执行层注意

> 你(omp dev subagent)频繁调用 bd。以下是本项目验证过的 beads 1.1.0 真实接口(封装在 `extensions/bd.ts`,与官方文档有差异)。**务必遵守**,否则会踩跨 worktree 可见性、交互卡死等坑。

### 必需 flag

- **`--dolt-auto-commit on`**:每次 bd 写操作都要带。不带的话 Dolt 写只在内存 working set,**跨进程/worktree 看不到**(你的 worktree 和经理进程、其他 dev 的 worktree 是不同进程)。本项目的 `defaultBdExec` 已默认带,但你手动调 bd 时必须显式加:
  ```bash
  bd --dolt-auto-commit on -C <repo> <command>
  ```
- **`-C <repo>`**:全局 flag,指定目标 repo 路径(你在 worktree 里,cwd 是 worktree,但 bd 数据操作要指向主 repo 或用 worktree 共享)。worktree 通过 git common directory 自动共享主仓库的 beads DB,无需手动配。

### 命令真实形态

| 操作 | 正确命令 | 注意 |
|---|---|---|
| 读规格 | `bd show <id> --json` | 解析时剥离前导 warning 行 |
| 原子认领 | `bd update <id> --claim --assignee <agent>` | 并发安全;失败=已被占用 |
| 分配 | `bd assign <id> <name>` | **不是 `pin`**(1.1.0 无此命令) |
| 关闭 | `bd close <id> --reason="..."` | reason 存为 comment |
| 重新打开 | `bd reopen <id>` | 失败时把 task 放回队列 |
| 备注 | `bd comment <id> "text"` | **单数**,不是 `comment add` |
| 查备注 | `bd comments <id>` | 复数(列表) |
| 建 bug | `bd create "title" --type=bug --parent=<epic>` | 挂同一 epic 下 |
| 加依赖 | `bd dep add <dependent> <dependency> --type=blocks` | 第一个参数是被阻塞方 |

### 禁用

- **`bd edit`**:开交互编辑器,headless 模式下会卡死。改字段用 `bd update <id> --字段=值`。
- **`bd doctor --fix`**:会误删合法的 parent-child 依赖(官方文档警告)。自动化里禁用。

### JSON 解析注意

bd 偶尔在 stdout 的 JSON 前输出 warning 行(如 `warning: beads.role not configured`)。程序化解析时要先定位第一个 `[` 或 `{` 再 `JSON.parse`,不要假设 stdout 第一行就是 JSON。本项目的 `parseJson()` 已处理,你自己解析时也要处理。

### 依赖语义

- **只有 `--type blocks` 阻塞**:`bd dep add A B --type blocks` 表示 B blocks A(A 等 B)。只有 blocks 类型进 ready 队列的 blocker 统计。
- **parent-child 不阻塞**:task 挂在 epic 下是 parent-child 关系,**不**构成阻塞。不要把 epic-child 当依赖。
- **`bd ready` 包含 epic**:查可做工作时必须按 `issue_type === "task"` 过滤,否则会把 epic 也当候选。
