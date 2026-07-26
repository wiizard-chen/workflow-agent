#!/usr/bin/env node
// install-skills.mjs — 把本项目自带的 skill 安装到全局 skill 根,供 pi 加载。
//
// 用法:
//   node scripts/install-skills.mjs             # 默认:symlink 安装到 ~/.pi/agent/skills/
//   node scripts/install-skills.mjs --copy      # 改用复制(默认 symlink)
//   node scripts/install-skills.mjs --list      # 只查看状态,不改动
//   node scripts/install-skills.mjs --dry-run   # 演练,打印将要做什么但不执行
//   node scripts/install-skills.mjs --target ~/some/dir  # 自定义目标根
//
// 卸载用:node scripts/uninstall-skills.mjs
//
// 设计:
// - 默认 symlink:改项目里的 skill,全局立刻生效,不用重装。
// - 安全:只处理本项目拥有的 skill(OWNED 清单);不碰目录里其他 skill。
// - 跨平台:用 fs.symlink / fs.cp / fs.rm(Node API),不依赖平台 ln/cp。
// - 共享逻辑在 skills-lib.mjs,卸载脚本复用同一份。

import * as lib from "./skills-lib.mjs";
import path from "node:path";

const args = process.argv;

// 解析 --target(公共,两个入口都要)
function targetFromArgs(fallback) {
  const i = args.indexOf("--target");
  if (i === -1) return fallback;
  const t = args[i + 1];
  if (!t) lib.die("--target 需要一个路径参数");
  return path.resolve(t);
}

// --list 是独立分支(只读)
if (args.includes("--list")) {
  lib.printHeader("pi-workflow skill installer · list");
  lib.list(targetFromArgs(lib.DEFAULT_TARGET));
  process.exit(0);
}

lib.printHeader("pi-workflow skill installer");
const opts = lib.parseArgs(args, { mode: "install" });
if (opts.dryRun) lib.log(lib.color("yellow", "  ⚠ DRY-RUN 模式:只打印,不执行\n"));
lib.ensureTargetDir(opts.target, opts.dryRun);
lib.install(opts);
