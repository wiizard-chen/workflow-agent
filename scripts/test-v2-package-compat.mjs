#!/usr/bin/env node
/**
 * Hermetic compatibility checks for the root Pi package.
 *
 * The checks deliberately use Pi's RPC resource registry rather than a model
 * prompt.  All Pi state (including npm-installed pi-subagents) lives below a
 * single temporary directory, and the caller's Pi directory is fingerprinted
 * before and after the run.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MODES = new Set(["local-source", "clone-parity", "pi-git-install"]);
const PROVIDER_ENV = /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|TOKEN|SECRET|CREDENTIAL|PASSWORD)$/;
const EXPECTED_AGENTS = ["dev", "reviewer"];
const USER_PI_DIR = join(homedir(), ".pi", "agent");
const USER_ZSHRC = join(homedir(), ".zshrc");

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  const mode = options.mode ?? "local-source";
  if (!MODES.has(mode)) fail(`--mode must be one of ${[...MODES].join(", ")}`);
  return { mode, candidate: options.candidate, source: options.source };
}

function shortOutput(output, limit = 1800) {
  const text = output.trim();
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

function pathWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** A byte-oriented tree digest; it intentionally ignores mtimes and ownership. */
function hashTree(path) {
  const hash = createHash("sha256");
  const visit = (current, label) => {
    if (!existsSync(current)) {
      hash.update(`missing\0${label}\0`);
      return;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${label}\0${readlinkSync(current)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`directory\0${label}\0`);
      for (const entry of readdirSync(current).sort()) visit(join(current, entry), join(label, entry));
      return;
    }
    if (!stat.isFile()) {
      hash.update(`other\0${label}\0`);
      return;
    }
    hash.update(`file\0${label}\0`);
    hash.update(readFileSync(current));
    hash.update("\0");
  };
  visit(path, ".");
  return hash.digest("hex");
}

function userConfigFingerprint() {
  return {
    piAgent: hashTree(USER_PI_DIR),
    zshrc: hashTree(USER_ZSHRC),
  };
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) fail(`${message}: expected ${expected}, got ${actual}`);
}

function assertFile(path, label) {
  if (!existsSync(path)) fail(`Missing ${label}: ${path}`);
}

function command(command, args, options) {
  const { cwd, env, input, timeoutMs = 60_000, label = [command, ...args].join(" ") } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${label} timed out\n${shortOutput(stderr || stdout)}`));
      } else if (code !== 0) {
        reject(new Error(`${label} failed (exit ${code}${signal ? `, ${signal}` : ""})\n${shortOutput(`${stdout}\n${stderr}`)}`));
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function makeIsolatedEnv(root, extra = {}) {
  const home = join(root, "home");
  const agent = join(root, "agent");
  const sessions = join(root, "sessions");
  const temp = join(root, "tmp");
  for (const dir of [home, agent, sessions, temp]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const emptyGitConfig = join(root, "empty-gitconfig");
  writeFileSync(emptyGitConfig, "", { mode: 0o600 });

  // Do not spread process.env: doing so would make user Pi packages, provider
  // credentials, or an inherited PI_SUBAGENT_EXTRA_AGENT_DIRS visible.
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    CI: "1",
    NO_COLOR: "1",
    npm_config_loglevel: "error",
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o PasswordAuthentication=no",
    ...extra,
  };
  for (const key of Object.keys(process.env)) {
    if (PROVIDER_ENV.test(key) || key === "PI_SUBAGENT_EXTRA_AGENT_DIRS") delete env[key];
  }
  return { env, home, agent, sessions, temp };
}

async function makeTargetRepository(root, env) {
  const target = join(root, "target-repository");
  mkdirSync(target, { recursive: true });
  await command("git", ["init", "--quiet"], { cwd: target, env, label: "create temporary target Git repository" });
  writeFileSync(join(target, "README.md"), "temporary compatibility target\n");
  await command("git", ["add", "README.md"], { cwd: target, env, label: "stage temporary target repository" });
  await command("git", ["-c", "user.name=compat", "-c", "user.email=compat@example.invalid", "commit", "--quiet", "-m", "initial target"], {
    cwd: target,
    env,
    label: "commit temporary target repository",
  });
  return target;
}

function readSettings(agentDir) {
  const settingsPath = join(agentDir, "settings.json");
  assertFile(settingsPath, "isolated Pi settings");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (Object.hasOwn(settings, "npmCommand")) fail("isolated Pi settings must omit npmCommand");
  return settings;
}

async function installSubagents(target, isolated) {
  const result = await command("pi", ["install", "npm:pi-subagents"], {
    cwd: target,
    env: isolated.env,
    timeoutMs: 120_000,
    label: "isolated pi install npm:pi-subagents",
  });
  const settings = readSettings(isolated.agent);
  if (!Array.isArray(settings.packages) || !settings.packages.includes("npm:pi-subagents")) {
    fail("isolated Pi settings did not register npm:pi-subagents");
  }
  const packageRoot = join(isolated.agent, "npm", "node_modules", "pi-subagents");
  assertFile(join(packageRoot, "package.json"), "isolated pi-subagents package");
  return { packageRoot, output: shortOutput(`${result.stdout}\n${result.stderr}`) };
}

function parseJsonLines(raw, label) {
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      fail(`${label} emitted non-JSON RPC output: ${line}`);
    }
  }
  return messages;
}

function rpcOnce(target, env, request, options = {}) {
  const { label = "Pi RPC diagnostic", executable = "pi", extraArgs = [] } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ["--mode", "rpc", "--no-session", "--session-dir", env.PI_CODING_AGENT_SESSION_DIR, ...extraArgs], {
      cwd: target,
      env: { ...env, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let responseSeen = false;
    let agentTitle;
    let stdinClosed = false;
    let settled = false;
    const finishInput = () => {
      if (!stdinClosed) {
        stdinClosed = true;
        child.stdin.end();
      }
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => rejectOnce(new Error(`${label} timed out\n${shortOutput(`${stdout}\n${stderr}`)}`)), 30_000);
    const processLine = (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        rejectOnce(new Error(`${label} emitted non-JSON RPC output: ${line}`));
        return;
      }
      if (message.type === "extension_error") {
        rejectOnce(new Error(`${label} extension error: ${message.error ?? "unknown error"}`));
        return;
      }
      if (message.type === "response" && message.id === request.id) {
        if (message.success !== true) {
          rejectOnce(new Error(`${label} response failed: ${JSON.stringify(message)}`));
          return;
        }
        responseSeen = true;
        finishInput();
      }
      if (message.type === "extension_ui_request" && message.method === "select" && typeof message.title === "string") {
        agentTitle = message.title;
        // `/subagents <name>` is a deterministic discovery diagnostic. Close
        // its menu immediately; no model prompt is ever sent.
        if (message.id) child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, result: "Done" })}\n`);
      }
    };
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      lineBuffer += text;
      let newline;
      while ((newline = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newline + 1);
        processLine(line);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => rejectOnce(new Error(`${label} could not start: ${error.message}`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (lineBuffer.trim()) processLine(lineBuffer);
      if (code !== 0) {
        reject(new Error(`${label} failed (exit ${code})\n${shortOutput(`${stdout}\n${stderr}`)}`));
      } else if (!responseSeen) {
        reject(new Error(`${label} did not return its RPC response\n${shortOutput(stdout)}`));
      } else {
        resolvePromise({ stdout, stderr, agentTitle });
      }
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function writeAgentDiagnostic(root, packageRoot) {
  const diagnostic = join(root, "pi-subagents-discovery-diagnostic.ts");
  writeFileSync(diagnostic, [
    `import { discoverAgentsAll } from ${JSON.stringify(join(packageRoot, "src", "agents", "agents.ts"))};`,
    "export default function compatibilityDiscovery(pi: any) {",
    "  pi.on(\"session_start\", async (_event: any, ctx: any) => {",
    "    const found = discoverAgentsAll(ctx.cwd);",
    "    const agents = [...found.user, ...found.package].map((agent: any) => ({ name: agent.name, package: agent.packageName, source: agent.source, filePath: agent.filePath }));",
    "    ctx.ui.notify(`WFPICOM_COMPAT_AGENTS=${JSON.stringify(agents)}`, \"info\");",
    "  });",
    "}",
    "",
  ].join("\n"), { mode: 0o600 });
  return diagnostic;
}

async function assertAgentDiscovery(target, env, expectedSource, expectedRoot, packageRoot, root, executable = "pi") {
  const diagnostic = writeAgentDiagnostic(root, packageRoot);
  const result = await rpcOnce(target, env, { id: "agent-discovery", type: "get_state" }, {
    label: "pi-subagents discovery diagnostic",
    executable,
    extraArgs: ["-e", diagnostic],
  });
  const notification = parseJsonLines(result.stdout, "pi-subagents discovery diagnostic")
    .find((message) => message.type === "extension_ui_request" && message.method === "notify" && typeof message.message === "string" && message.message.startsWith("WFPICOM_COMPAT_AGENTS="));
  if (!notification) fail("pi-subagents discovery diagnostic emitted no agent inventory");
  const agents = JSON.parse(notification.message.slice("WFPICOM_COMPAT_AGENTS=".length));
  const evidence = [];
  for (const agent of EXPECTED_AGENTS) {
    const found = agents.find((entry) => entry?.name === `pi-workflow.${agent}` && entry?.package === "pi-workflow" && entry?.source === expectedSource);
    if (!found) fail(`pi-subagents did not discover namespaced ${agent} from ${expectedSource}`);
    const expectedPath = join(expectedRoot, ".pi", "agents", `${agent}.md`);
    assertEqual(resolve(found.filePath), expectedPath, `pi-subagents ${agent} discovery path`);
    evidence.push({ agent, source: found.source, path: found.filePath });
  }
  return evidence;
}

async function resourceRegistry(target, env, expectedRoot, executable = "pi") {
  const result = await rpcOnce(target, env, { id: "resource-registry", type: "get_commands" }, {
    label: "Pi resource registry diagnostic",
    executable,
  });
  const response = parseJsonLines(result.stdout, "Pi resource registry diagnostic")
    .find((message) => message.type === "response" && message.id === "resource-registry");
  const commands = response?.data?.commands;
  if (!Array.isArray(commands)) fail("Pi resource registry did not return commands");
  const workflow = commands.find((entry) => entry?.name === "wf" && entry?.source === "extension");
  if (!workflow) fail("Pi resource registry did not register /wf");
  const workflowPath = workflow.sourceInfo?.path ?? workflow.path;
  assertEqual(resolve(workflowPath), join(expectedRoot, "extensions", "workflow.ts"), "/wf extension path");
  const skill = commands.find((entry) => entry?.name === "skill:bd-work" && entry?.source === "skill");
  if (!skill) fail("Pi resource registry did not register workflow skills");
  const skillPath = skill.sourceInfo?.path ?? skill.path;
  if (!pathWithin(resolve(skillPath), join(expectedRoot, "skills"))) fail(`workflow skill path escaped package root: ${skillPath}`);
  return {
    wfExtension: workflowPath,
    cacheExtension: join(expectedRoot, "extensions", "cache.ts"),
    skill: skillPath,
    commandCount: commands.length,
  };
}

function assertRootManifest(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.name !== "pi-workflow" || !Array.isArray(manifest.keywords) || !manifest.keywords.includes("pi-package")) {
    fail("candidate is not the pi-workflow Pi package");
  }
  const pi = manifest.pi;
  if (!Array.isArray(pi?.extensions) || !pi.extensions.includes("./extensions/workflow.ts") || !pi.extensions.includes("./extensions/cache.ts")) {
    fail("candidate Pi manifest does not declare workflow/cache core extensions");
  }
  if (!Array.isArray(pi?.skills) || !pi.skills.includes("./skills")) fail("candidate Pi manifest does not declare core skills");
  if (!Array.isArray(pi?.subagents?.agents) || !pi.subagents.agents.includes("./.pi/agents")) {
    fail("candidate Pi manifest does not declare pi-subagents agents");
  }
  for (const file of ["extensions/workflow.ts", "extensions/cache.ts", "scripts/wfpi", "workflow.config.json"]) assertFile(join(root, file), `stable V1 resource ${file}`);
  for (const agent of EXPECTED_AGENTS) assertFile(join(root, ".pi", "agents", `${agent}.md`), `workflow ${agent} agent`);
}

async function localSource(candidate, root) {
  assertRootManifest(candidate);
  const isolated = makeIsolatedEnv(root);
  const target = await makeTargetRepository(root, isolated.env);
  const subagents = await installSubagents(target, isolated);
  const agentDir = join(candidate, ".pi", "agents");
  const localEnv = { ...isolated.env, WF_AGENT_HOME: candidate };
  const wfpi = join(candidate, "scripts", "wfpi");
  assertFile(wfpi, "local-source wfpi launcher");
  const registry = await resourceRegistry(target, localEnv, candidate, wfpi);
  const agents = await assertAgentDiscovery(target, localEnv, "user", candidate, subagents.packageRoot, root, wfpi);
  return {
    target,
    isolated: { agent: isolated.agent, sessions: isolated.sessions, home: isolated.home },
    piSubagents: subagents.packageRoot,
    registry,
    agents,
    npmCommandOmitted: true,
  };
}

async function cloneParity(candidate, root) {
  assertRootManifest(candidate);
  const baseEnv = makeIsolatedEnv(root);
  const candidateSha = (await command("git", ["rev-parse", "HEAD"], { cwd: candidate, env: baseEnv.env, label: "resolve candidate commit" })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) fail(`candidate commit is not a full SHA: ${candidateSha}`);
  const clone = join(root, "candidate-clone");
  await command("git", ["clone", "--quiet", "--no-local", "--no-hardlinks", candidate, clone], {
    cwd: root,
    env: baseEnv.env,
    timeoutMs: 120_000,
    label: "clone exact candidate commit",
  });
  const cloneSha = (await command("git", ["rev-parse", "HEAD"], { cwd: clone, env: baseEnv.env, label: "read cloned candidate commit" })).stdout.trim();
  assertEqual(cloneSha, candidateSha, "clone parity commit");
  const npm = await command("npm", ["install", "--omit=dev"], {
    cwd: clone,
    env: baseEnv.env,
    timeoutMs: 180_000,
    label: "candidate clone npm install --omit=dev",
  });
  assertFile(join(clone, "node_modules"), "candidate clone node_modules after omit-dev install");
  const target = await makeTargetRepository(root, baseEnv.env);
  const subagents = await installSubagents(target, baseEnv);
  await command("pi", ["install", clone], {
    cwd: target,
    env: baseEnv.env,
    label: "register cloned root as isolated Pi package",
  });
  const settings = readSettings(baseEnv.agent);
  if (!settings.packages.some((entry) => typeof entry === "string" && entry !== "npm:pi-subagents")) {
    fail("isolated Pi settings did not register the cloned root package");
  }
  const registry = await resourceRegistry(target, baseEnv.env, clone);
  const agents = await assertAgentDiscovery(target, baseEnv.env, "package", clone, subagents.packageRoot, root);
  return {
    candidateSha,
    clone,
    target,
    isolated: { agent: baseEnv.agent, sessions: baseEnv.sessions, home: baseEnv.home },
    piSubagents: subagents.packageRoot,
    npmInstall: shortOutput(`${npm.stdout}\n${npm.stderr}`),
    npmCommandOmitted: true,
    registry,
    agents,
  };
}

function parseGitSource(source) {
  const match = /^git:github\.com\/wiizard-chen\/workflow-agent@([0-9a-f]{40})$/.exec(source ?? "");
  if (!match) {
    fail("--source must be exactly git:github.com/wiizard-chen/workflow-agent@<40-lowercase-hex-sha>; SSH, credentials, and mutable refs are forbidden");
  }
  return match[1];
}

async function piGitInstall(source, root) {
  const expectedSha = parseGitSource(source);
  const isolated = makeIsolatedEnv(root);
  const target = await makeTargetRepository(root, isolated.env);
  const subagents = await installSubagents(target, isolated);
  await command("pi", ["install", source], {
    cwd: target,
    env: isolated.env,
    timeoutMs: 180_000,
    label: "actual isolated Pi Git-package install",
  });
  const settings = readSettings(isolated.agent);
  if (!settings.packages.includes(source)) fail("isolated Pi settings did not retain the exact Git source");
  const installed = join(isolated.agent, "git", "github.com", "wiizard-chen", "workflow-agent");
  assertFile(join(installed, "package.json"), "Pi-installed Git package");
  const installedSha = (await command("git", ["rev-parse", "HEAD"], { cwd: installed, env: isolated.env, label: "read Pi-installed Git package commit" })).stdout.trim();
  assertEqual(installedSha, expectedSha, "Pi-installed Git package commit");
  assertFile(join(installed, "node_modules"), "Pi Git-package npm install output");
  if (existsSync(join(installed, "node_modules", "typescript"))) {
    fail("Pi Git-package install retained dev dependency typescript; expected npm install --omit=dev");
  }
  const registry = await resourceRegistry(target, isolated.env, installed);
  const agents = await assertAgentDiscovery(target, isolated.env, "package", installed, subagents.packageRoot, root);
  return {
    expectedSha,
    installed,
    target,
    isolated: { agent: isolated.agent, sessions: isolated.sessions, home: isolated.home },
    piSubagents: subagents.packageRoot,
    npmCommandOmitted: true,
    omitDevVerified: true,
    registry,
    agents,
  };
}

async function main() {
  const { mode, candidate: rawCandidate, source } = parseArgs(process.argv.slice(2));
  if (mode !== "pi-git-install" && !rawCandidate) fail(`--candidate is required for ${mode} mode`);
  const candidate = rawCandidate ? resolve(rawCandidate) : undefined;
  if (candidate && !existsSync(candidate)) fail(`candidate does not exist: ${candidate}`);
  if (candidate && !existsSync(join(candidate, ".git"))) fail(`candidate must be a Git checkout: ${candidate}`);

  const before = userConfigFingerprint();
  const root = mkdtempSync(join(tmpdir(), "workflow-agent-v2-package-compat-"));
  let evidence;
  let runError;
  try {
    if (mode === "local-source") evidence = await localSource(candidate, root);
    else if (mode === "clone-parity") evidence = await cloneParity(candidate, root);
    else evidence = await piGitInstall(source, root);
  } catch (error) {
    runError = error;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  const after = userConfigFingerprint();
  if (before.piAgent !== after.piAgent || before.zshrc !== after.zshrc) {
    fail(`user Pi configuration changed during isolated compatibility run: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  if (runError) throw runError;
  if (existsSync(root)) fail(`temporary compatibility state was not cleaned: ${root}`);
  console.log(JSON.stringify({
    ok: true,
    mode,
    candidate: candidate ?? undefined,
    source: source ?? undefined,
    userConfig: { before, after, unchanged: true },
    cleanup: { temporaryRoot: root, removed: true },
    evidence,
  }, null, 2));
}

main().catch((error) => {
  console.error(`package compatibility FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
