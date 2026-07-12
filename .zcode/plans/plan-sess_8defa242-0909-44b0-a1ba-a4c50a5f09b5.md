# 生成 beads skill 四件套 + 各 agent 前置角色定位

## 目标
在 `skills/` 下生成一套 beads 原生 skill 四件套(bd-plan/bd-split/bd-work/bd-handoff),**同时符合 omp 和 reasonix 两种宿主**;同时补齐各 agent 的前置角色定位文件(manager 已有,dev 新建)。内容对齐截图的 bd-plan/bd-split/bd-work/bd-handoff,但适配本项目 v3 经理驱动架构,并包含 reasonix 执行层频繁调 bd 所需的真实接口指引。

## 调研结论(方案成立的基础)
1. **跨宿主 SKILL.md 格式统一**:omp、reasonix、Claude Code 都用 Anthropic skill 规范(`name`+`description` frontmatter + markdown)。项目现有 `skills/plan-interrogation/SKILL.md` 和 reasonix 全局 `to-prd`/`to-issues`/`handoff` 同格式。
2. **omp 发现路径**(已验证可用):`package.json` 的 `pi.skills: ["./skills"]` + `workflow.ts:618` 的 `resources_discover` 把 `skills/` 暴露 → 放进 `skills/` 即被 omp 自动发现。
3. **reasonix 发现路径**:reasonix `run -dir <worktree>` 会读 worktree 内的 `AGENTS.md`。需在 `AGENTS.md` 加一段 skill 路径指引(reasonix 读 AGENTS.md 里的路径提示去加载)。
4. **bd 真实接口**已在 `extensions/bd.ts` 封装验证,与官方文档有 13 处差异(DECISION_LOG.md 记录),skill 必须用这些真实命令。
5. **当前缺口**:`dev-pool.ts:113` 的 `reasonixArgs` 只给 dev 一句"实现子任务"指令,没有角色定位和 bd 操作规范 → dev.md 需要补,并通过 assign_dev 注入。

## 要生成的文件(6 个新文件 + 2 处编辑)

### A. 四件套 skill(`skills/` 下,对标截图但适配本项目)

**1. `skills/bd-plan/SKILL.md`** — 需求 → PRD(plan 环节)
- 触发:讨论需求、写 PRD、PLAN 阶段、`/wf prd` 前
- 内容:含 `/wf analyze` 仓库简报前置(跨需求复用)、deepseek-pro 讨论 → glm-5.2 写 PRD 的工作流、PRD 模板、plan-interrogation skill 联动
- bd 操作:`bd create <需求> --type=epic`(父 epic)、PRD 落到 `.workflow/<reqId>/prd.md`
- omp vs reasonix 视角:此 skill 主要给主 session omp 用(PLAN 模式只读)

**2. `skills/bd-split/SKILL.md`** — PRD → task + 依赖(split 环节)
- 触发:拆 PRD、拆子任务、`split_prd_to_tasks`、执行模式开始
- 内容:经理视角的拆分原则(独立 task、依赖链路由 A→B→C 给同一 dev)、tracer-bullet 垂直切片、`depends_on` 用 blocks 类型
- bd 操作:`bd create --type=task --parent=<epic>`、`bd dep add <child> <parent> --type=blocks`、规格写到 `subtasks/NN-*.md` 并在 `bd update --notes` 指向
- **重要接口提醒**:`bd ready` 会含 parent epic,必须按 `issue_type==="task"` 过滤;parent-child 依赖不阻塞,只有 `--type blocks` 进 blocker 统计

**3. `skills/bd-work/SKILL.md`** — 认领/实现/关闭(work 环节,reasonix dev 最频繁用)
- 触发:实现单个 task、`assign_dev` 内部、dev 认领工作
- 内容:dev 视角——只实现当前 task、不越界、先 `bd show` 读规格、实现后 `bd close`、遇阻碍建 `--type=bug` 并 `bd dep add --type=blocks`
- bd 操作(高频):`bd show <id>`、`bd update <id> --claim --assignee <agent>`、`bd close <id> --reason=...`、`bd create --type=bug`、`bd comment <id>`(单数!)
- **`## reasonix 执行层注意` 独立章节**(见下文统一内容)

**4. `skills/bd-handoff/SKILL.md`** — 跨 session 交接(handoff 环节)
- 触发:经理↔dev 交接、session 复用、`--continue`、退出/恢复
- 内容:dev 持有固定 worktree → session 路径稳定 → `--continue` 复用上下文;交接时把进度写进 bd comment 而非本地文件(bd 是跨 session 权威);经理退出前用 `bd comment <epicId>` 汇总
- bd 操作:`bd comment`、`bd show`、`bd list --status=in_progress`
- 约束:不创建本地 markdown handoff 文件当真相源(bd 才是)

### B. 每个 skill 统一包含的 `## reasonix 执行层注意` 章节
基于 `extensions/bd.ts` 已验证的真实接口(DECISION_LOG.md 13 条),至少覆盖:
- `--dolt-auto-commit on` 必需(否则跨 worktree/进程看不到状态)
- `-C <repo>` 全局 flag,任意 cwd 操作目标 repo
- `--json` 程序化解析,且要剥离 stdout 前导 warning 行
- 多 agent 分配用 `bd assign`(不是文档说的 `pin`)
- 原子认领用 `bd update <id> --claim`
- 备注用 `bd comment`(单数,不是 `comment add`)
- 禁用 `bd edit`(开交互编辑器)、`bd doctor --fix`(误删合法依赖)
- 依赖阻塞只有 `--type blocks`;`bd ready` 含 epic 必须过滤 `issue_type==="task"`

### C. agent 前置角色定位文件

**5. `.omp/agents/dev.md`**(新建)— reasonix dev 角色定位
- frontmatter:`name: dev`、`description: 技术开发执行者...`、`model: deepseek-flash`
- 正文:你是 dev(reasonix session),只实现单个 task;不拆分、不测试、不分配;先 `bd show` 读规格再动手;实现后 `bd close`;遇阻碍建 bug + blocks 依赖;严守验证门;不越界实现其他 task
- 联动:指向 bd-work skill 的 reasonix 章节
- 注入方式:`dev-pool.ts:113` 的 `reasonixArgs` instruction 前置这段定位(见下方代码改动)

**6. `.omp/agents/manager.md`**(编辑,补充角色定位与 skill 联动)
- 保留现有内容,在开头加"前置角色定位"小节:你是经理,不写代码,通过三个工具工作;联动 bd-split/bd-work/bd-handoff skill
- 加 bd 真实接口提醒的简短引用(详情指向 bd-split skill)

### D. 让两个宿主都能发现 skill 的配置(2 处编辑)

**7. `AGENTS.md`** — 加一段 skill 路径指引
- 在 beads 集成块附近加:"项目 beads skill 四件套位于 `skills/bd-plan`、`skills/bd-split`、`skills/bd-work`、`skills/bd-handoff`。reasonix dev 应在实现 task 前加载 `bd-work` skill。"
- 这让 reasonix 读 AGENTS.md 时知道去哪找 skill

**8. `extensions/dev-pool.ts`** — `reasonixArgs` 注入 dev 角色定位
- 把 `instruction` 从单句扩展为:前置 dev.md 的核心定位 + 提示加载 bd-work skill + 原"实现这个子任务"指令
- 改动约 5-8 行,保持现有逻辑不变

## 不做的事(边界)
- 不改 `extensions/bd.ts`(接口已验证,只是 skill 里引用它)
- 不改 omp/reasonix 的 skill 加载机制本身
- 不动 `package.json` 的 `pi.skills`(已正确指向 `./skills`,新 skill 自动被发现)
- 不创建本地 markdown handoff/TODO 文件作真相源(bd 才是)
- 不改 `index.html`(上一轮已完成)

## 验证方式
- skill 文件:检查 frontmatter 格式与现有 plan-interrogation 一致;每个含 `## reasonix 执行层注意`
- omp 发现:`workflow.ts:618` 的 `resources_discover` 已把 `skills/` 整个目录暴露,新增子目录自动可见(无需改代码)
- reasonix 发现:AGENTS.md 加路径指引 + dev.md 注入
- bd 接口准确性:与 `extensions/bd.ts` 的实际命令逐条核对
- 运行 `node --experimental-strip-types test/build.test.ts` 确认 dev-pool.ts 改动不破坏现有测试
