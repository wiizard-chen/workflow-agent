## 目标

新增 `/wf task <一句话描述>` 命令:把一个一句话小需求(不需要正式 PRD)拆成多个可并行的 beads task,挂在当前活动需求的 epic 下,跳过 prd.md。用户随后手动 `/execute` 让经理派 dev 并行实现。

**设计依据(已与用户确认):**
- 方案 B —— 像 `/wf bug` 一样自建 task 后手动 `/execute`,不自动直通 build,不污染 prd.md。
- 拆分粒度 —— 复用现有 `split_prd_to_tasks` 工具的拆分原则(tracer-bullet 垂直切片、依赖最小化、`{"subtasks":[{id,title,depends_on,spec}]}` 结构)。

## 实现位置

全部改动集中在 `extensions/workflow.ts`(1 个文件)。不动 bd.ts、不动 manager-prompt.md、不动 skills —— 因为 manager prompt L104-109 已经支持"epic 下先有 task"的场景,`bd.readyTasks` 也会自动把 `type: "task"` 纳入调度。

## 改动清单(4 处)

### 1. 新增 `cmdTask` 函数(放在 `cmdBug` 之后,L632 附近)

镜像 `cmdBug` 的结构(L559-632),但用 `split_prd_to_tasks` 工具同款的拆分逻辑(L871-878 的 prompt)。流程:

```
1. 校验:desc 非空、wf 存在、wf.epicId 存在(同 cmdBug L560-563)
2. mkdir subtasks/(同 cmdBug L564)
3. runStageText(split 模型)拆分 —— 用 split_prd_to_tasks 同款 prompt:
   - 要求输出 {"subtasks":[{"id":"01","title":"标题","depends_on":[],"spec":"完整规格"}]}
   - 强调 tracer-bullet:垂直切片、独立可提交、依赖最小化
   - 这跟 cmdBug 的"bug 分类"prompt 不同(cmdBug 是 {bugs:[{title,desc}]},没有 depends_on/spec)
4. extractSubtasksJson 解析,失败 fallback 到单个 task(同 cmdBug L583-589 的容错模式)
5. 对每个 subtask:
   a. 写规格文件:subtasks/<id>-<slug(title)>.md(命名规则同 split 工具 L893-894)
      内容:"# <title>\n\n<spec>\n"
   b. bd.create({ title, type: "task", parent: wf.epicId, notes: "规格文件:<abs path>" })
      (注意:type 用 "task" 不是 "bug";不前缀 "bug:";不设 description 字段 —— 跟 split 工具 L897 一致,跟 cmdBug L614-620 不同)
   c. 记录 logicalId → bdId 映射(用于下一步标依赖)
6. 标依赖:对每个 task 的 depends_on,调 bd.depAdd(repo, dependentBdId, dependencyBdId, "blocks")
   (这是 cmdBug 没有的步骤,但 split 工具 L902-906 有 —— 因为 task 之间有真实依赖,bug 之间没有)
7. 更新 wf.subtaskIds = 所有新建 task 的 bdId,saveState(wf)
   (同 split 工具 L908-909;cmdBug 没做这步,但对 /wf status 的进度展示有用)
8. notify 用户:列出新建的 task(id: title + 依赖),提示 "/execute 让经理派 dev 并行实现"
   (措辞跟 cmdBug L628-631 平行,但说 task 不说 bug,强调"并行")
```

**关键差异表(cmdTask vs cmdBug vs split 工具):**

| 维度 | cmdBug | split 工具 | cmdTask(新) |
|---|---|---|---|
| 拆分 prompt | bug 分类({bugs}) | tracer-bullet({subtasks}) | tracer-bullet({subtasks}) ← 复用 split 工具的 |
| bd type | "bug" | "task" | "task" |
| title 前缀 | "bug: ..." | 无 | 无 |
| 标依赖 | ❌ | ✅ depAdd blocks | ✅ depAdd blocks |
| 写规格文件 | ✅ bug-<slug>.md | ✅ <id>-<slug>.md | ✅ <id>-<slug>.md |
| 更新 subtaskIds | ❌ | ✅ | ✅ |
| 之后 | 提示 /execute | (在 build 内自动跑) | 提示 /execute |

### 2. dispatcher 注册 case(在 L1114 `case "bug"` 之后加一行)

```ts
case "task": await cmdTask(pi, ctx, rest); break;
```

### 3. 子命令补全列表(L1096)

在 `subs` 数组加 `"task"`:
```ts
const subs = ["new", "prd", "analyze", "status", "verify", "execute", "resume", "bug", "task", "done", "idle", "abort", "help"];
```

### 4. 帮助文本(L1138 附近加一行)

在 `/wf bug` 那行下面加:
```
/wf task <描述>        一句话需求拆多 task(挂当前 epic,跳过 PRD),/execute 派 dev 并行实现
```

## 不改的东西(明确列出)

- **不动 `cmdExecute`** —— 方案 B 不自动直通 build,所以 L724 的 prd.md 检查保持原样。用户手动 /execute 时,manager prompt 会检测到 epic 下已有 task 并处理。
- **不动 manager-prompt.md** —— L104-109 已支持"epic 下先有 task"。
- **不动 bd.ts** —— `bd.create` 和 `bd.depAdd` 现有签名够用。
- **不动 skills/bd-split** —— cmdTask 直接用 split 模型 + 自己拼 prompt,不依赖 skill 文件(skill 是给经理/dev 读的参考,不是代码依赖)。
- **不加 `--dry-run`** —— cmdBug 也没有,保持轻量。用户要看拆分结果可以直接看 `.workflow/<reqId>/subtasks/` 或 `/wf status`。

## 边界处理

- **无活动需求** → 提示"先 /wf resume 切到需求,或 /wf new"(同 cmdBug L562)
- **无 epicId** → 提示"当前需求缺少 epic id"(同 cmdBug L563)
- **split 模型无输出/解析失败** → fallback 建单个 task(title 用描述前 40 字,spec 用原描述)(同 cmdBug L589 的容错)
- **单个 task 也走 depAdd 循环** —— depends_on 为空时内层 for 不执行,无害
- **建 task 抛异常** → 单个失败不阻断其他,catch 后 notify(同 cmdBug L622-624)

## 验证

- `npx tsc --noEmit` —— 类型检查通过
- `npm test` —— 现有测试 ALL PASS(新增命令不影响现有 cmdBug/cmdExecute/cmdStatus 测试)
- 手动验证(用户自测):`/wf task 给登录页加记住我和图形验证码` → 应在当前 epic 下建 2 个 task,带依赖(无)和规格文件;`/wf status` 能看到;`/execute` 能派 dev

## 风险评估

- **回归风险:极低** —— 只新增函数和 case,不改任何现有 cmd* 的行为。
- **拆分质量风险:中等** —— 一句话输入对 split 模型是挑战,可能拆得过细或过粗。但这是模型能力问题,不是代码问题;用户可以 `/wf abort` 后重试,或手动 `/wf bug` 修单个。
- **跟 cmdBug 的语义重叠** —— 两者都是"跳过 PRD 的轻量入口",区别是 bug(修)/ task(加功能)。帮助文本会区分清楚。