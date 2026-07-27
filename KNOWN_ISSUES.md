# 已知问题 / 待修复清单

记录于 2026-07-09 的一次审查会话。按严重程度排列,附证据与建议修复方向,供换环境后继续处理。

## P0 —— 安全假象(最优先)

### 1. `verifyCommand` 默认空,验证门形同虚设

- **位置**:`extensions/lib.ts` `runVerify()`
  ```ts
  const cmd = (s.verifyCommand ?? cfg.build.verifyCommand ?? "").trim();
  if (!cmd) return { ok: true, output: "(无验证命令)" };
  ```
- **问题**:没配置 `/wf verify` 或 `workflow.config.json` 里的 `build.verifyCommand`,任何 pi dev subagent 改动都被判定"验证通过"。整条 build 流水线的质量门控在默认状态下等于不存在。
- **风险**:deepseek-flash 在真实代码库里拥有无监督写权限(pi dev subagent `autonomous`,只受 pi 自己的 `deny` 规则约束,不受我们的验证门约束),默认配置下没有任何机制挡住有问题的改动被直接 commit。注:dev 现在在 subagent 内部做闭环 verify→fix,但 P0 门控仍是 commit 前的兜底。
- **从未被真实测试覆盖**:所有冒烟测试都没配置 `verifyCommand`,测的是"门永远开着"这条路径。
- **建议修复**:`cmdBuild` 里检测到没有验证命令时,默认拒绝执行(或强制要求用户显式确认"我知道没有验证命令,继续"),而不是静默通过。

## P1 —— 真实缺陷(有代码/冒烟证据)

### 2. 单进程内存状态单例,无并发/多需求支持,存在数据错位风险(已部分缓解)

- **位置**:`extensions/workflow.ts` `let wf: WorkflowState | undefined;`
- **问题(历史 v3 框架)**:模块级单例。v3 架构下经理是独立 `pi.exec` 子进程,BUILD 跑到一半时如果调用 `/wf new` 开新需求,`wf` 引用被切换,但旧需求的子进程仍在跑,跑完后 `saveState(wf)` 可能写入错误的 reqId 目录或覆盖错误的对象。
- **现状(v4:主 session 即经理)**:经理不再是独立子进程,build 模式跑在主 session 内,且 `/wf new` 已加单例锁——检测到有需求处于 `mode: "build"` 时拒绝执行(见 README 安全/边界)。但模块级 `wf` 单例本身仍是单需求假设,多需求并发(多个 `/wf new` 串行)时状态切替的正确性仍依赖这个锁,没有更深层的隔离。
- **未验证但合理推断**:从未在真实场景里手抖触发过。
- **建议修复**:已部分缓解(单例锁)。若要支持多需求并存,需要把 `wf` 从单例改成 reqId 索引的 map。

### 3. `extractJson` 的容错解析是"猜",猜错不会响亮失败

- **位置**:`extensions/workflow.ts` `extractJson()`
  ```ts
  const s = stripped.indexOf("{");
  const e = stripped.lastIndexOf("}");
  ```
- **问题**:如果模型输出在字符串值中间被截断(比如某个 `spec` 字段内容里恰好包含 `}`),这段逻辑可能"成功"解析出语法合法但语义错误/不完整的 JSON,不会抛异常提醒你,会安静生成缺失或错位的子任务规格,直接送进 build 让 pi dev subagent 执行不完整指令。
- **风险场景**:子任务多、spec 详细时,`splitPrompt` 输出可能撞到 `maxTokens: 8192` 硬顶被截断。未做过"大量子任务"场景的压力测试。
- **建议修复**:JSON 解析失败或解析出的对象缺少必要字段(如每个 subtask 缺 `spec`)时应该报错重试,而不是接受一个可能不完整的结果。

### 4. `aggregateMetrics` 靠字段名猜测,已随 reasonix 移除而过时(已解决/obsolete)

- **位置**:`extensions/lib.ts` `aggregateMetrics()`——`key.includes("cost")`、`key.includes("cache") && key.includes("hit")` 这类启发式匹配。
- **问题(历史)**:过去恰好对上 reasonix v1.11 的字段名。reasonix 是快速迭代项目(TS→Go 重写、v0.x→v1.0→v2),字段名一旦变化,这段代码不会报错,只会把 `cost`/`cacheHit` 算成 `undefined`,`summary.json` 悄悄失去意义,没有任何提示。
- **现状(迁移后)**:reasonix 二进制早已移除,执行层先迁到 omp native subagent,再随上游迁到 pi-subagents(nicobailon)的 `subagent` 工具,不再产出 `reasonix -metrics` JSON。这段基于字段名猜测的 metrics 聚合因此**已过时**——要么随 dev subagent 的新 metrics 输出重写(改用 pi 的 `message_end` hook 聚合 `prompt_cache_hit_tokens`),要么直接移除。

### 5. `review.md` 无强制力,BUILD 终点可能被无视

- **位置**:`extensions/workflow.ts` `cmdBuild()` 结尾,review 完成后只是 `ctx.ui.notify(...)`。
- **问题**:review 是"建议性"(主动设计决定,不改),但系统没有任何机制强制或提醒用户真的打开看——BUILD 完成的 notify 和其它 info 级别通知视觉上没有区别,即使 review 里写了 blocker 也不会有更强的提示。
- **建议修复**:review 中出现"blocker"关键词时,`notify` 级别提升为 `error`,并在 `state.json` 里记录 `reviewSeverity` 字段供后续查询。

## P2 —— 未验证的合理风险(没有踩过,但值得警惕)

### 6. 跨平台假设:全程只在 macOS 验证过

- `runVerify` 用 `bash -lc`,Windows 上无 bash 会直接失效。
- `fs.realpathSync` 的符号链接行为、路径分隔符在 Windows 上可能不同。
- README 没有任何跨平台声明,是隐藏假设。

### 7. `waitTurnComplete` 的 2.5 秒静默期检测是经验值,没做边界测试

- **位置**:`extensions/workflow.ts` `waitTurnComplete()`,600 秒硬顶。
- 网络抖动、模型输出忽快忽慢场景下可能误判"turn 已结束"(提前判定完成导致截断)。真实边界场景从未触发验证。

### 8. `slug()` 对标题做 `.slice(0, 40)` 硬切,可能切在多字节字符中间

- JS 字符串按 UTF-16 code unit 切,不按字素簇。极端长或非常规 Unicode 标题理论上能生成非法/错位文件名。概率低,无测试覆盖。

### 9. 测试覆盖的是"状态机逻辑正确性",不是"真实故障场景"

- `test/build.test.ts` 全部用假的 pi/subagent 调用(原 `execReasonix` 桩,现为 fake subagent 测试桩),测的是我们自己 `runBuildPipeline` 的逻辑,完全没测:
  - pi dev subagent 真实失败(网络断、限流、`subagent` 返回的 output JSON 格式异常、非零退出码)时 `subagent` 调用的实际行为
  - glm/deepseek 长时间不响应时的真实超时表现
  - 大规模 PRD/子任务(10+ 个)下 prompt 是否会撞 token 上限

### 10. 产品定位问题:小需求过度工程,大需求验证不足

- 极简需求(如加一个函数)走完整 plan(讨论+分析+PRD+拆分)+ build(pi dev subagent+review)链路,token/时间成本远超直接用 pi 实现。
- 真正需要这套流程的复杂需求(多子任务、跨模块依赖)从未被真实测试覆盖——所有冒烟测试都是玩具级场景(临时 repo、种子 commit、单函数需求)。

## 已确认不是缺陷、无需处理的结论(避免重复纠结)

- **架构选择本身(pi 编排 + pi-subagents subagent 执行)是合理的**,已核实:
  - omp/opencode 的 subagent 机制历史上是"内部模型/prompt 角色切换",无法承载"委托给独立外部进程"(原 reasonix 执行层)这种需求——这也是当初引入外部 reasonix 二进制的理由。现已统一:dev 执行由 pi-subagents(nicobailon)的 `subagent` 工具承担(`subagent({agent:"dev", ...})` spawn 一个定义在 `.pi/agents/dev.md` 的 subagent),编排与执行同源。(注:omp 是 pi 的前身,这段历史保留以解释架构演化。)
  - pi 的 plugin hook 体系没有暴露 `before_provider_request` 级别的钩子,无法在插件层修复它的缓存命中率问题;fork 内核改的维护成本远超现有方案。
  - DeepSeek 前缀缓存机制(原 reasonix 自带 90%+~99.82%,用户长期实测)在迁移后由 `cache.ts` 覆盖 dev subagent 层,命中率表现被保留——和编排层用什么工具无关,编排层脆弱不会污染执行层的缓存表现,两者物理隔离(`subagent` 只是 spawn 一个 subagent 等返回)。
- 严格串行、无并行 —— 主动设计取舍,避免多进程写冲突。
- 失败即停、无自动重试 —— 主动设计取舍,人工介入优于自动重试可能导致的连锁错误。

## 建议优先级(下次处理时按此顺序)

1. **P0 #1**(验证门默认拒绝)—— 安全性问题,投入小、价值最高。
2. **P1 #2**(单例状态竞态防护,已部分缓解)—— build 中拒绝新 `/wf new` 的单例锁已落地;若要多需求并存,需把 `wf` 单例改成 reqId 索引。
3. **P1 #3、#4**(解析容错改成显式失败;#4 的 metrics 聚合随 reasonix 移除已 obsolete)—— 把"静默错误"改成"响亮报错",不需要大改架构。
4. **P1 #5**(review 严重程度提示)—— 小改动,提升可见性。
5. P2 系列按实际使用场景触发情况决定是否处理。
