/**
 * cache.ts — DeepSeek 前缀缓存优化扩展。
 *
 * omp 的 system prompt 里有一行 `Today is YYYY-MM-DD, and the current working
 * directory is '...''.`。date 每天 local-midnight 变一次,导致 system prompt
 * 前缀字节不稳定,击穿 DeepSeek 的服务端前缀缓存。
 *
 * 本扩展在 before_agent_start hook 里,对 DeepSeek 模型把 date 冻结成一个
 * 固定常量(1970-01-01),让前缀在跨 turn / 跨 midnight 时字节稳定 → 前缀
 * 缓存命中。cwd 不动(worktree 路径在 session 内本来就稳定)。
 *
 * 覆盖范围:本扩展作用于所有加载它的 omp 进程——主 session、经理进程,
 * 以及迁移后的 dev subagent(每个 dev 是 omp --print 子进程)。dev subagent
 * 的系统提示(dev.md 角色 + skill 白名单 + bd 接口规范)是静态文本,日期被
 * 冻结后前缀稳定,DeepSeek 服务端前缀缓存跨 task 命中。这替代了原 reasonix
 * 的 --continue session 续跑(靠 bd comment + 稳定前缀补偿上下文复用)。
 *
 * 设计决策:
 * - 只对 DeepSeek 模型生效(glm/zai 不用 DeepSeek 前缀缓存,冻结无益)。
 * - 只冻结 date:这是唯一的 per-turn cache-buster(cwd 在 session 内稳定)。
 * - 不动 payload 其他部分(tool schemas 等在同一 session 内本就稳定)。
 *
 * 为什么不用第三方插件 @rohaquinlop/pi-deepseek-cache:
 *   它 import 老版 pi-coding-agent 的 serializeConversation,
 *   但 omp 16.4.6 的 shim 没导出这个名字(fork 重构进了 snapcompact 命名空间),
 *   omp plugin install 验证失败。本扩展用 omp 原生 hook,零第三方依赖。
 *
 * Hooks:
 * - before_agent_start:冻结 system prompt 里的 date 字段(仅 DeepSeek)。
 * - message_end:读 usage.cacheRead(DS 的 prompt_cache_hit_tokens),累计 telemetry。
 *
 * See DECISION_LOG.md for the full rationale (cache-safety, omp native subagent migration).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 冻结后的 date 常量。用 epoch 日,语义上明确"这不是真实日期"。 */
const FROZEN_DATE = "1970-01-01";

/** 匹配 system prompt 里的 `Today is YYYY-MM-DD,` 片段。 */
const DATE_RE = /Today is \d{4}-\d{2}-\d{2},/g;

/** Telemetry 累计(进程内,非持久)。 */
let cacheStats = { turns: 0, cacheRead: 0, input: 0 };

/** 判断当前 turn 是否用 DeepSeek 模型(前缀缓存只对 DS 有效)。 */
function isDeepSeekModel(ctx: any): boolean {
  const model = ctx?.model;
  if (!model) return false;
  // model.id 形如 "deepseek-v4-pro" / "deepseek-flash";provider 形如 "deepseek"
  if (model.provider === "deepseek") return true;
  const id: string = model.id || model.name || "";
  return id.toLowerCase().includes("deepseek");
}

/**
 * 把 system prompt 字符串里的 date 片段替换成 FROZEN_DATE。
 * 返回新字符串(不 mutate 原值)。无替换则返回 undefined(让 pi 用原值)。
 */
function freezeDateInPrompt(systemPrompt: string): string | undefined {
  if (typeof systemPrompt !== "string") return undefined;
  if (!DATE_RE.test(systemPrompt)) return undefined;
  // reset regex lastIndex (global flag is stateful)
  DATE_RE.lastIndex = 0;
  return systemPrompt.replace(DATE_RE, `Today is ${FROZEN_DATE},`);
}

/** 格式化 cache hit rate 百分比。 */
function pct(hit: number, total: number): string {
  if (total <= 0) return "—";
  return `${(hit / total * 100).toFixed(1)}%`;
}

export default function cacheExtension(pi: ExtensionAPI): void {
  // An opt-in marker lets hermetic no-model diagnostics prove that this exact
  // extension was loaded and its session hook ran. Normal interactive sessions
  // stay silent.
  pi.on("session_start", async (_event: any, ctx: any) => {
    cacheStats = { turns: 0, cacheRead: 0, input: 0 };
    if (process.env.WF_CACHE_DIAGNOSTIC === "1") {
      ctx?.ui?.notify?.("WF_CACHE_EXTENSION_LOADED:before_agent_start,message_end", "info");
    }
  });

  pi.registerCommand("wf-cache-status", {
    description: "Show workflow cache extension diagnostic status",
    handler: async (_args: string, ctx: any) => {
      ctx?.ui?.notify?.("WF_CACHE_EXTENSION_LOADED:before_agent_start,message_end", "info");
    },
  });

  // ── Hook A: 冻结 system prompt 里的 date(仅 DeepSeek)─────────────────────
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!isDeepSeekModel(ctx)) return;          // glm/zai 等不动
    const sp: string | undefined = event?.systemPrompt;
    if (typeof sp !== "string") return;
    const frozen = freezeDateInPrompt(sp);
    if (!frozen) return;                         // 没找到 date 行,不改
    return { systemPrompt: frozen };
  });

  // ── Hook B: telemetry — 读 DeepSeek 的 cacheRead 累计 ─────────────────────
  pi.on("message_end", async (event: any, ctx: any) => {
    if (!isDeepSeekModel(ctx)) return;
    const usage = event?.message?.usage;
    if (!usage) return;
    // DeepSeek: prompt_cache_hit_tokens → usage.cacheRead
    //          prompt_cache_miss_tokens → usage.cacheWrite (DS 常报 0,miss 折进 input)
    const cacheRead = Number(usage.cacheRead) || 0;
    const input = Number(usage.input) || 0;
    cacheStats.turns += 1;
    cacheStats.cacheRead += cacheRead;
    cacheStats.input += input;
    // 最小版 telemetry:每 5 个 turn 通知一次累计命中率
    if (cacheStats.turns % 5 === 0 && (cacheStats.cacheRead + cacheStats.input) > 0) {
      const total = cacheStats.cacheRead + cacheStats.input;
      ctx?.ui?.notify?.(
        `[cache] ${cacheStats.turns} turns | hit ${pct(cacheStats.cacheRead, total)} | ` +
        `read ${cacheStats.cacheRead.toLocaleString()} / ${(total).toLocaleString()} tokens`,
        "info"
      );
    }
  });

  // session_start is also the lifecycle hook used by the opt-in diagnostic
  // marker above; telemetry state is reset there so a fresh session never
  // inherits another session's counters.
}
