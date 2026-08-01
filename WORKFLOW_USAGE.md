# pi-workflow 使用指南

本文档是 `pi-workflow` 的独立日常操作手册。架构与实现细节见 [`README.md`](README.md)，历史决策见 [`DECISION_LOG.md`](DECISION_LOG.md)。

## 1. 最短使用路径

### 恢复已有需求

```bash
cd <目标仓库>
wfpi
```

进入 Pi 后：

```text
/reload
/wf resume
/wf status
```

选择要恢复的 Beads epic。恢复成功后直接继续讨论或执行当前阶段工作。

### 创建新需求

```bash
cd <目标仓库>
wfpi
```

进入 Pi 后：

```text
/wf new <需求名称>
```

然后按顺序执行：

```text
/wf analyze
# 与主 session 讨论需求
/wf research <可选的研究主题>
/wf prd
/wf oracle
# 由 AI 分析仓库、显示建议，确认后直接写入
/wf verify
# 或手工覆盖
/wf verify <测试命令>
/execute --dry-run
/execute
/wf status
/wf done
```

示例：

```text
/wf new add-user-authentication
/wf analyze
/wf research OAuth 2.1 在 CLI 应用中的安全实践
/wf prd
/wf oracle
/wf verify npm test && npx tsc --noEmit
/execute --dry-run
/execute
```

> workflow state 中的验证命令不能为空。可用无参数 `/wf verify` 生成并确认，或 `/wf verify <cmd>` 手工设置；未确认/未设置时，`/execute`、task close 和最终验证都会 fail closed。

---

## 2. 安装与启动

### 一键安装

在 `workflow-agent` 仓库执行：

```bash
bash scripts/setup.sh
```

检查现状但不修改：

```bash
bash scripts/setup.sh --check
```

常用可选参数：

```bash
bash scripts/setup.sh --no-tools
bash scripts/setup.sh --no-keys
bash scripts/setup.sh --no-skills
```

安装脚本会准备：

- `pi`
- `pi-subagents`
- `bd` / Beads
- workflow skills
- `wfpi` shell 命令
- DeepSeek/GLM API key 配置入口

GPT-5.6 的 `codex2api` provider 由 Pi 自身的用户模型配置提供，主要配置文件通常是：

```text
~/.pi/agent/models.json
```

### 在目标仓库启动

```bash
cd <目标仓库>
wfpi
```

目标仓库至少需要满足：

- 是 Git 仓库
- 已安装 `bd`
- 已初始化 Beads

首次使用可执行：

```bash
git init       # 仅当目标目录还不是 Git 仓库
bd init        # 仅当目标仓库尚未初始化 Beads
wfpi
```

---

## 3. workflow 状态

workflow 只有两个活动状态：

```text
plan → build
```

没有 active epic 时是普通 Pi，不属于 workflow 状态。

### 普通 Pi

- 没有 active workflow epic
- 不注入 PLAN skill
- 使用 Pi 自身的默认模型
- `/wf new` 或 `/wf resume` 后进入 workflow

### PLAN

- 主 session 负责需求讨论
- 代码仓库只读
- 自动注入完整 `plan-interrogation` skill
- `researcher`、`scout`、`oracle` 只提供 advisory context
- `/wf prd` 调用权威 `pi-workflow.prd-writer`

### BUILD

- 主 session 是只读 manager
- manager 不能直接调用通用 `bash`、`write`、`edit` 修改代码
- 只有串行 `pi-workflow.dev` 可以写代码
- task reviewer、最终 reviewer 和验证工具组成确定性关闭门
- 当前 writer 并发上限固定为 `1`

---

## 4. PLAN 阶段完整流程

### 创建需求

```text
/wf new <需求名称> [目标仓库路径]
```

通常已经在目标仓库中启动 `wfpi`，因此不需要填写路径：

```text
/wf new improve-order-matching
```

### 分析仓库

```text
/wf analyze
```

强制刷新已有仓库简报：

```text
/wf analyze --refresh
```

产物：

```text
.workflow/_repo-brief.md
```

### 讨论需求

进入 PLAN 后，直接与主 session 对话即可。`plan-interrogation` 会在每个 PLAN turn 自动注入，不需要手工执行：

```text
/skill:plan-interrogation
```

PLAN 讨论规则包括：

- 一次只解决一个关键问题
- 主 session 给出推荐答案
- 能通过代码仓库确认的事实先自行探查
- 设计树的重要分支逐项达成共识

### 外部研究

```text
/wf research [主题]
```

示例：

```text
/wf research PostgreSQL advisory lock 的故障恢复策略
```

产物：

```text
.workflow/<reqId>/results/research.md
.workflow/<reqId>/results/research.audit.json
```

研究结果是 advisory evidence，不会直接改变 Beads 状态，也不会进入权威 close/finalize 证据链。

### 生成 PRD

```text
/wf prd
```

产物：

```text
.workflow/<reqId>/prd.md
.workflow/<reqId>/results/prd-generation.json
```

生成成功后，扩展会只对这两个不可变文件执行窄化的 `git add -f` + commit；即使仓库忽略整个 `.workflow/`，PRD 仍可从 Git 恢复。`state.json`、`summary.json` 和 task 运行结果不会随之进入 Git。目标仓库没有对应 `.gitignore` 规则时，扩展会只在本地 `.git/info/exclude` 忽略 `_repo-brief.md`、`*/state.json`、`*/results/`；`prd.md` 与 `subtasks/` 不会被本地规则隐藏，也不会改动项目的 tracked `.gitignore`。

### PRD 一致性审查

```text
/wf oracle
```

产物：

```text
.workflow/<reqId>/results/prd-oracle.md
.workflow/<reqId>/results/prd-oracle.audit.json
```

Oracle 只给建议，不替代 PRD writer、task reviewer 或 final reviewer。

---

## 5. BUILD 阶段完整流程

### 设置验证命令

让 builtin scout 只读分析仓库并生成建议，确认后直接写入 workflow state：

```text
/wf verify
```

extension 会展示完整命令并询问是否采用；此步骤只保存命令，不会立即执行。建议命令包含明显危险 shell 操作时会被拒绝并要求手工设置。也可直接覆盖：

```text
/wf verify <命令>
```

示例：

```text
/wf verify npm test && npx tsc --noEmit
```

也可以在 `workflow.config.json` 中设置默认值：

```json
{
  "build": {
    "verifyCommand": "npm test && npx tsc --noEmit"
  }
}
```

### 先拆任务但不写代码

```text
/execute --dry-run
```

该命令会：

- 读取 PRD
- 创建或复用 Beads tasks
- 建立依赖图
- 输出 manager 的执行计划

该命令不会：

- 派发 dev
- 修改业务代码

注意：dry-run 创建的 Beads task 是真实持久化的，后续 `/execute` 会复用，而不是重复创建。

### 执行构建

```text
/execute
```

构建过程：

```text
split tasks
  → claim task
  → pi-workflow.dev 实现、验证、commit
  → pi-workflow.reviewer 审查
  → bd_task close 或 reopen
  → 所有 task closed
  → run_verify
  → pi-workflow.final-reviewer
  → finalize_test
```

### Reviewer fail 自动修复

Task reviewer 返回可定位、无需产品决策的代码问题时，manager 会在**同一次 `/execute`** 内自动执行：

```text
reopen → 保存 review-feedback → claim → dev 修复 → reviewer 复审
```

默认配置：

```json
{
  "execute": {
    "maxReviewerAutoFixes": 3,
    "sameIssueStopAfter": 2
  }
}
```

含义：初始实现之外最多自动修复 3 轮；完全相同的规范化 issue 集连续出现 2 次时提前停止，避免死循环。需求歧义、PRD/架构冲突、外部凭证/数据阻塞或破坏性决策仍会停下询问用户。manager 不会递归调用 `/execute`，也不会跳过 reviewer。

### 查看状态

```text
/wf status
```

重点检查：

- 当前 epic 和 reqId
- `plan` / `build` 模式
- active model profile
- 每个角色的 `model@effort`
- task 状态
- token/cache/cost 摘要

### 完成 workflow

确认所有 task 和最终验证完成后：

```text
/wf done
```

这会清除 active epic，使主 session 回到普通 Pi。

### 放弃并回滚 BUILD

```text
/wf abort
```

该命令会在确认后：

- 把目标仓库 reset 到 `/execute` 记录的 baseline
- reopen epic 下的 tasks
- 尽量保留 `.workflow/` 审计工件

这是破坏性操作，确认前仔细检查将被丢弃的 commit 和未提交修改。

---

## 6. 恢复与重新加载

### 重新加载项目配置

修改以下内容后通常执行：

```text
/reload
/wf resume
/wf status
```

适用文件包括：

- `workflow.config.json`
- `extensions/workflow/**/*.ts`
- `.pi/agents/*.md`
- `.pi/manager-prompt.md`
- `skills/plan-interrogation/SKILL.md`
- 项目级 extensions、skills、prompts、themes

`/reload` 只重新加载资源；`/wf resume` 才会恢复 active epic 并重新应用 workflow main role。

### 修改用户模型注册后

如果修改了：

```text
~/.pi/agent/models.json
```

建议完整重启：

```text
Ctrl+D
```

然后：

```bash
cd <目标仓库>
wfpi
```

再执行：

```text
/wf resume
/wf status
```

### 缺少 state.json 时恢复

```text
/wf resume
```

会展示全部 Beads epic，包括 closed epic。如果选中的 epic 缺少 `.workflow/state.json`，workflow 会提示是否根据 Beads 状态重建。

---

## 7. 模型 profile

模型集中配置在：

```text
workflow.config.json
```

默认 active profile：

```json
"activeModelProfile": "gpt56"
```

### `gpt56`

| 角色 | 模型 | effort |
|---|---|---|
| main | `codex2api/gpt-5.6-sol` | `xhigh` |
| PRD writer | `codex2api/gpt-5.6-sol` | `high` |
| dev | `codex2api/gpt-5.6-luna` | `high` |
| task reviewer | `codex2api/gpt-5.6-terra` | `xhigh` |
| final reviewer | `codex2api/gpt-5.6-terra` | `xhigh` |

### `deepseek-glm`

| 角色 | 模型 | effort |
|---|---|---|
| main | `deepseek/deepseek-v4-pro` | `high` |
| PRD writer | `zai/glm-5.2` | `high` |
| dev | `deepseek/deepseek-v4-flash` | `high` |
| task reviewer | `zai/glm-5.2` | `high` |
| final reviewer | `zai/glm-5.2` | `high` |

### 切换 profile

修改：

```json
"activeModelProfile": "deepseek-glm"
```

然后：

```text
/reload
/wf resume
/wf status
```

无效 profile、无效 effort、模型未注册、模型不可认证或实际模型发生漂移时，workflow 会 fail closed。

### 为什么刚进入 `wfpi` 不是 Sol

`wfpi` 启动时如果还没有 active epic，当前 session 是普通 Pi，使用的是 Pi 全局默认模型。执行以下任一命令后，workflow 才应用 profile 的 main 模型：

```text
/wf new <需求名称>
/wf resume
```

如果希望从启动第一刻就使用 Sol：

```bash
wfpi --model codex2api/gpt-5.6-sol --thinking xhigh
```

只为 `wfpi` 设置默认值，可在 `~/.zshrc` 中使用：

```bash
export WF_AGENT_HOME="/path/to/workflow-agent"

wfpi() {
  "$WF_AGENT_HOME/scripts/wfpi" \
    --model codex2api/gpt-5.6-sol \
    --thinking xhigh \
    "$@"
}
```

修改后：

```bash
source ~/.zshrc
```

---

## 8. Skill collision 提示

可能看到：

```text
[Skill conflicts]
  "beads" collision:
    ✓ <目标仓库>/.agents/skills/beads/SKILL.md
    ✗ ~/.pi/agent/skills/beads/SKILL.md (skipped)
```

这不是错误。它表示：

- 当前项目和全局目录都有名为 `beads` 的 skill
- Pi 选择了项目版本
- 全局版本被跳过
- workflow 和 Beads 仍可正常使用

如果希望消除提示，可删除全局 `beads` symlink：

```bash
rm -f ~/.pi/agent/skills/beads
```

然后：

```text
/reload
```

不要删除这些 workflow 专用 skills：

```text
bd-plan
bd-split
bd-work
bd-handoff
plan-interrogation
```

---

## 9. 常用命令速查

| 命令 | 作用 |
|---|---|
| `/wf new <name> [repo]` | 创建 epic 并进入 PLAN |
| `/plan` | 回到或确认 PLAN 模式 |
| `/wf analyze` | 生成仓库简报 |
| `/wf analyze --refresh` | 强制刷新仓库简报 |
| `/wf research [topic]` | 外部资料研究 |
| `/wf prd` | 生成权威 PRD |
| `/wf oracle` | PRD 一致性建议 |
| `/wf verify` | AI 只读分析并建议验证命令，用户确认后写入 |
| `/wf verify <cmd>` | 手工设置验证命令 |
| `/execute --dry-run` | 拆 task，不派 dev |
| `/execute` | 进入 BUILD 并执行任务 |
| `/wf status` | 查看 workflow、模型和 task 状态 |
| `/wf resume` | 从全部 Beads epic 中恢复 |
| `/wf done` | 完成并返回普通 Pi |
| `/wf abort` | 回滚 BUILD baseline，破坏性操作 |

---

## 10. 常见故障

### `/wf` 或 `/execute` 不存在

确认使用的是：

```bash
wfpi
```

而不是未安装扩展的普通：

```bash
pi
```

然后执行：

```text
/reload
```

### `/execute` 提示验证命令为空

执行：

```text
/wf verify npm test
```

应根据目标仓库替换为真实质量门，例如：

```text
/wf verify npm test && npm run lint && npx tsc --noEmit
```

### profile 模型不可用

检查：

```bash
pi --list-models gpt-5.6
```

并确认：

```text
~/.pi/agent/models.json
```

已注册 Sol、Terra、Luna，provider 凭证可用。修改模型注册后完整重启 `wfpi`。

### `/reload` 后模型仍然不对

执行：

```text
/wf resume
/wf status
```

因为 `/reload` 不等于激活 workflow role。

### PLAN 没有自动追问

检查：

```text
/wf status
```

只有 `mode=plan` 的 workflow 主 session 会自动注入 `plan-interrogation`。普通 Pi、BUILD 和 child subagent 不会自动注入。

### Beads 尚未初始化

在目标仓库执行：

```bash
bd init
```

然后重新启动：

```bash
wfpi
```

### 查看 Beads 状态

```bash
bd ready
bd list --status=open
bd list --status=in_progress
bd blocked
bd show <issue-id>
```

---

## 11. 产物位置

目标仓库内：

```text
.workflow/
├── _repo-brief.md
└── <reqId>/
    ├── state.json
    ├── prd.md
    ├── subtasks/
    └── results/
        ├── research.md
        ├── prd-generation.json
        ├── prd-oracle.md
        ├── split.json
        ├── <taskId>.claim.json
        ├── <taskId>.json
        ├── <taskId>.review.json
        ├── verify.json
        ├── cumulative.diff
        ├── final-review.json
        └── summary.json
```

权威状态分工：

- Beads：epic、task、依赖、blocker、状态
- Git：代码改动、PRD/audit、冻结 task specs/split manifest 和最终 evidence
- `.workflow/` 动态文件：state、summary、per-task claim/result/review 等运行态工件；扩展用本地 `.git/info/exclude` 只忽略 `_repo-brief.md`、`*/state.json` 和 `*/results/`，不忽略 PRD/spec，并把旧版已跟踪的动态文件自动迁出 Git

不可变工件采用分阶段窄化 commit，不会跟踪整个 `.workflow/`：PRD 完成时提交 PRD + generation audit；split/轻量 task/bug 创建后提交 specs + split manifest；最终通过时提交 final evidence。BUILD dev 若修改 PRD 或既有 spec，扩展会按 claim baseline 自动恢复并判该次 dev audit 失败。

---

## 12. 安全边界

使用时应记住：

- PLAN 主 session 对代码只读
- BUILD manager 对代码只读
- 只有串行 dev subagent 可以写业务代码
- manager 不应直接获得通用 shell/write/edit
- advisory researcher/scout/oracle 不修改 Beads
- task close 必须绑定 claim 后的有效 commit range
- 最终验证必须绑定当前 command、HEAD、PRD hash、diff hash、runId 和模型审计
- 不配置验证命令就不能进入权威 BUILD close/finalize 流程
- `/wf abort` 会丢弃 baseline 之后的代码，必须谨慎确认
- workflow 默认不会替你 push；commit/push 行为仍受当前仓库和用户授权约束

---

## 13. 日常推荐模板

每天开始工作：

```bash
cd <目标仓库>
wfpi --model codex2api/gpt-5.6-sol --thinking xhigh
```

Pi 中：

```text
/wf resume
/wf status
```

继续 PLAN：

```text
/wf analyze
# 继续需求讨论
/wf prd
/wf oracle
```

开始 BUILD：

```text
/wf verify
/execute --dry-run
/execute
```

完成：

```text
/wf status
/wf done
```

配置变更：

```text
/reload
/wf resume
/wf status
```

用户模型注册变更：完整退出并重新启动 `wfpi`。
