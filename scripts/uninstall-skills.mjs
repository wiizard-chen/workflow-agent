#!/usr/bin/env node
// uninstall-skills.mjs — 移除本项目安装到全局 skill 根的 skill。
//
// 用法:
//   node scripts/uninstall-skills.mjs             # 卸载 ~/.omp/agent/skills/ 里本项目拥有的 skill
//   node scripts/uninstall-skills.mjs --dry-run   # 演练,打印将删什么但不执行
//   node scripts/uninstall-skills.mjs --target ~/some/dir  # 自定义目标根
//
// 安装用:node scripts/install-skills.mjs
//
// 安全:
// - 只删本项目拥有的 skill(symlink 指向本项目源,或带 marker 的 copy)。
// - 别人的 skill(symlink 指向别处 / 无 marker 的目录)只读保护,绝不碰。
// - 共享逻辑在 skills-lib.mjs,与 install 完全对称(同一份 OWNED 清单)。

import * as lib from "./skills-lib.mjs";
import path from "node:path";

const args = process.argv;

function targetFromArgs(fallback) {
  const i = args.indexOf("--target");
  if (i === -1) return fallback;
  const t = args[i + 1];
  if (!t) lib.die("--target 需要一个路径参数");
  return path.resolve(t);
}

lib.printHeader("pi-workflow skill uninstaller");
const opts = lib.parseArgs(args, { mode: "uninstall" });
if (opts.dryRun) lib.log(lib.color("yellow", "  ⚠ DRY-RUN 模式:只打印,不执行\n"));
lib.uninstall({ dryRun: opts.dryRun, target: opts.target });
