// skills-lib.mjs — install-skills / uninstall-skills 共享的逻辑库。
//
// 把项目自带的 skill 安装到 omp 和 reasonix 共享的全局 skill 根
// (~/.omp/agent/skills)。两个入口脚本(install / uninstall)各自薄封装,
// 核心逻辑都在这里,避免重复。
//
// 设计见 scripts/install-skills.mjs 头注释。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 路径常量
// ---------------------------------------------------------------------------

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

/** 本项目拥有的 skill:源目录(相对 PROJECT_ROOT)→ 安装名。
 *  这份清单是"所有权"依据——install 会建/覆盖这些,uninstall 只删这些。
 *  两个入口脚本共用同一份清单,保证装/卸对称。 */
export const OWNED = [
  { src: "skills/bd-plan",            name: "bd-plan" },
  { src: "skills/bd-split",           name: "bd-split" },
  { src: "skills/bd-work",            name: "bd-work" },
  { src: "skills/bd-handoff",         name: "bd-handoff" },
  { src: "skills/plan-interrogation", name: "plan-interrogation" },
  { src: ".agents/skills/beads",      name: "beads" },
];

/** 默认目标根:当前机器上 omp 和 reasonix 共享的全局 skill 目录。 */
export const DEFAULT_TARGET = path.join(os.homedir(), ".omp", "agent", "skills");

/** 标记文件:uninstall 据此识别"是我们 copy 装的"(symlink 直接读 link 判定)。 */
export const MARKER = ".installed-by-pi-workflow";

// ---------------------------------------------------------------------------
// 彩色输出辅助
// ---------------------------------------------------------------------------

export const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  blue: "\x1b[34m", cyan: "\x1b[36m",
};
export const color = (c, s) => `${C[c]}${s}${C.reset}`;
export const log = (m) => console.log(m);
export const say = (verb, name, extra = "") =>
  log(`  ${color("green", "✓")} ${verb.padEnd(10)} ${name}${extra ? color("dim", "  " + extra) : ""}`);
export const warn = (name, extra) =>
  log(`  ${color("yellow", "!")} ${color("yellow", "skip").padEnd(10)} ${name}${extra ? color("dim", "  " + extra) : ""}`);
export const note = (verb, name, extra = "") =>
  log(`  ${color("cyan", verb.padEnd(10))} ${name}${extra ? color("dim", "  " + extra) : ""}`);
export function die(msg, code = 1) { console.error(color("red", `✗ ${msg}`)); process.exit(code); }

// ---------------------------------------------------------------------------
// 文件系统辅助
// ---------------------------------------------------------------------------

export function lstatSafe(p) { try { return fs.lstatSync(p); } catch { return null; } }
export function readlinkSafe(p) { try { return fs.realpathSync(p); } catch { return null; } }

/** 目标是否指向我们的源(精确判定所有权)?
 *  - symlink:指向本项目源目录(绝对路径相等)
 *  - copy:目录里有 marker 文件
 *  - 否则:false(别人的 skill,绝不碰) */
export function pointsToOurSource(targetPath, srcAbs) {
  const st = lstatSafe(targetPath);
  if (!st) return false;
  if (st.isSymbolicLink()) {
    return readlinkSafe(targetPath) === srcAbs;
  }
  return fs.existsSync(path.join(targetPath, MARKER));
}

/** 目标当前状态(供 --list 和判断用)。
 *  返回:absent | symlink(本项目的)| symlink-foreign(指向别处)| copy(本项目)| foreign(别人占了) */
export function statusOf(destAbs, srcAbs) {
  const st = lstatSafe(destAbs);
  if (!st) return "absent";
  if (st.isSymbolicLink()) {
    const real = readlinkSafe(destAbs);
    return real === srcAbs ? "symlink" : "symlink-foreign";
  }
  if (fs.existsSync(path.join(destAbs, MARKER))) return "copy";
  return "foreign";
}

// ---------------------------------------------------------------------------
// CLI 解析
// ---------------------------------------------------------------------------

/** 解析公共参数,两个入口共用。mode 由入口脚本传入("install"|"uninstall")。 */
export function parseArgs(argv, { mode }) {
  const a = argv.slice(2);
  const copy = a.includes("--copy");
  const dryRun = a.includes("--dry-run") || a.includes("-n");
  const targetIdx = a.indexOf("--target");
  const target = (targetIdx !== -1 && a[targetIdx + 1])
    ? path.resolve(a[targetIdx + 1])
    : DEFAULT_TARGET;

  if (mode === "uninstall" && copy) {
    die("--copy 只用于 install。卸载会自动识别 symlink 或 copy 两种安装方式。");
  }
  return { copy, dryRun, target };
}

// ---------------------------------------------------------------------------
// 核心操作
// ---------------------------------------------------------------------------

export function ensureTargetDir(target, dryRun) {
  if (!fs.existsSync(target)) {
    if (dryRun) { note("mkdir", target); return; }
    fs.mkdirSync(target, { recursive: true });
  }
}

/** 安装。opts: { copy, dryRun, target } */
export function install({ copy, dryRun, target }) {
  log(color("bold", `\n安装 ${copy ? "copy" : "symlink"} → ${color("cyan", target)}\n`));
  let done = 0, skipped = 0;
  for (const { src, name } of OWNED) {
    const srcAbs = path.join(PROJECT_ROOT, src);
    const destAbs = path.join(target, name);

    if (!fs.existsSync(srcAbs)) { warn(name, `源不存在 ${src}`); skipped++; continue; }

    const st = statusOf(destAbs, srcAbs);
    // 决策:是否要(重)建
    if (st === "symlink" && !copy) { say("exists", name, "已是 symlink,跳过"); skipped++; continue; }
    if (st === "copy" && copy)     { say("exists", name, "已是 copy,跳过"); skipped++; continue; }
    if (st === "symlink-foreign" || st === "foreign") {
      warn(name, "目标已存在且非本项目所有,不覆盖");
      log(color("dim", `      (如需覆盖,先手动: rm -rf ${destAbs})`));
      skipped++; continue;
    }
    // st === absent,或形态变更(symlink↔copy 同源)→ 删旧重建
    if (st === "copy" && !copy) note("reinstall", name, "symlink←copy → 删旧重建");
    if (st === "symlink" && copy) note("reinstall", name, "copy←symlink → 删旧重建");

    if (dryRun) {
      note(copy ? "copy→" : "link→", name, `${src} → ${path.relative(os.homedir(), destAbs)}`);
      done++; continue;
    }

    if (st !== "absent") {
      try { fs.rmSync(destAbs, { recursive: true, force: true }); }
      catch (e) { warn(name, `删旧失败: ${e.message}`); skipped++; continue; }
    }
    try {
      if (copy) {
        fs.cpSync(srcAbs, destAbs, { recursive: true });
        fs.writeFileSync(path.join(destAbs, MARKER), new Date().toISOString() + "\n");
      } else {
        fs.symlinkSync(srcAbs, destAbs);
      }
      say(copy ? "copied" : "linked", name);
      done++;
    } catch (e) {
      warn(name, `失败: ${e.message}`);
      skipped++;
    }
  }
  summary(done, skipped, "安装", dryRun);
  if (!dryRun && !copy) {
    log(color("dim", `\n  提示:symlink 模式下,改了项目里的 skill 全局立刻生效,不用重装。`));
    log(color("dim", `  重开 omp/reasonix 或重新加载即可看到新 skill。`));
  }
}

/** 卸载。opts: { dryRun, target } */
export function uninstall({ dryRun, target }) {
  log(color("bold", `\n卸载本项目 skill ← ${color("cyan", target)}\n`));
  let done = 0, skipped = 0;
  for (const { src, name } of OWNED) {
    const srcAbs = path.join(PROJECT_ROOT, src);
    const destAbs = path.join(target, name);
    const st = statusOf(destAbs, srcAbs);

    if (st === "absent") { warn(name, "目标不存在"); skipped++; continue; }
    if (st === "symlink-foreign" || st === "foreign") {
      warn(name, "非本项目所有,不删"); skipped++; continue;
    }
    // st === symlink(本项目)或 copy(本项目 marker)
    if (dryRun) { note("rm", name); done++; continue; }
    try {
      fs.rmSync(destAbs, { recursive: true, force: true });
      say("removed", name);
      done++;
    } catch (e) { warn(name, `失败: ${e.message}`); skipped++; }
  }
  summary(done, skipped, "卸载", dryRun);
}

/** 列出状态。 */
export function list(target) {
  log(color("bold", `\nskill 状态 @ ${color("cyan", target)}\n`));
  log(`  ${"name".padEnd(22)} ${"state".padEnd(16)} ${color("dim", "detail")}`);
  log(`  ${"-".repeat(22)} ${"-".repeat(16)} ${"─".repeat(30)}`);
  for (const { src, name } of OWNED) {
    const srcAbs = path.join(PROJECT_ROOT, src);
    const destAbs = path.join(target, name);
    const st = statusOf(destAbs, srcAbs);
    let state, detail = "";
    switch (st) {
      case "absent":           state = color("dim", "absent"); detail = "未安装"; break;
      case "symlink":          state = color("green", "symlink"); detail = "→ " + path.relative(os.homedir(), srcAbs); break;
      case "symlink-foreign":  state = color("yellow", "symlink?"); detail = "指向别处"; break;
      case "copy":             state = color("blue", "copy"); detail = "复制安装"; break;
      case "foreign":          state = color("red", "foreign"); detail = "存在但非本项目所有"; break;
    }
    log(`  ${name.padEnd(22)} ${state.padEnd(16)} ${color("dim", detail)}`);
  }
  log("");
}

export function summary(done, skipped, action, dryRun) {
  log("");
  log(`  ${color("bold", action + "完成")}: ${color("green", done)} 成功, ${skipped} 跳过${dryRun ? color("yellow", "  (dry-run,未实际执行)") : ""}`);
}

/** 公共页眉,两个入口都先打这个。 */
export function printHeader(title) {
  log(color("bold", color("blue", title)));
  log(color("dim", `  project: ${PROJECT_ROOT}`));
}
