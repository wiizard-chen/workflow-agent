#!/usr/bin/env node
/**
 * Hermetic, no-model package compatibility diagnostics for pi-workflow.
 *
 * Every executable is resolved to an absolute, executable path before a child
 * starts. Every child runs in its own process group, so timeout, failure, and
 * parent SIGINT/SIGTERM cleanup terminate the whole group rather than merely
 * its leader. The only inherited environment value used for resolution is PATH;
 * child environments are constructed from an allow-list.
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = new Set(["local-source", "clone-parity", "pi-git-install"]);
const EXPECTED_AGENTS = ["dev", "reviewer"];
// This is the complete user-owned Pi state relevant to this harness. Sessions
// are deliberately fingerprinted too: no-session must not be a claim made from
// our temporary path; it must leave the user's real transcript tree unchanged.
const USER_PI_CONFIG_ENTRIES = ["settings.json", "models.json", "models-store.json", "auth.json", "trust.json", "npm", "git", "extensions", "skills", "sessions"];
const USER_ZSHRC = join(homedir(), ".zshrc");
const TERMINATE_GRACE_MS = 1_500;
const RPC_TIMEOUT_MS = 30_000;

function fail(message) { throw new Error(message); }
function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}
function assertFile(path, label) {
  if (!existsSync(path)) fail(`Missing ${label}: ${path}`);
}
function shortOutput(output, limit = 2_000) {
  const text = output.trim();
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}
function pathWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
    if (Object.hasOwn(options, key)) fail(`Duplicate --${key}`);
    options[key] = value;
    index += 1;
  }
  const mode = options.mode ?? "local-source";
  if (!MODES.has(mode)) fail(`--mode must be one of ${[...MODES].join(", ")}`);
  return { mode, candidate: options.candidate, source: options.source };
}

/** Locate a command now, but never permit later children to resolve it via PATH. */
function findExecutableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      if (statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0) return realpathSync(candidate);
    } catch { /* continue looking */ }
  }
  fail(`Could not pre-resolve executable ${name} from PATH; set PATH before invoking this diagnostic`);
}
function validatedExecutable(label, candidate) {
  if (!candidate || !isAbsolute(candidate)) fail(`${label} executable must be an absolute path, not ${String(candidate)}`);
  let resolved;
  try { resolved = realpathSync(candidate); } catch { fail(`${label} executable does not exist: ${candidate}`); }
  const stat = statSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) fail(`${label} executable is not executable: ${resolved}`);
  return resolved;
}
function resolveTools() {
  // The overrides are deliberately required to be absolute; they make a
  // PATH-shadowing test fail closed rather than silently executing the shadow.
  const pi = validatedExecutable("pi", process.env.WF_PI_EXECUTABLE ?? findExecutableOnPath("pi"));
  const git = validatedExecutable("git", process.env.WF_GIT_EXECUTABLE ?? findExecutableOnPath("git"));
  const npm = validatedExecutable("npm", process.env.WF_NPM_EXECUTABLE ?? findExecutableOnPath("npm"));
  const node = validatedExecutable("node", process.env.WF_NODE_EXECUTABLE ?? process.execPath);
  return { pi, git, npm, node };
}

/**
 * Hash a filesystem object and, crucially, hash the target contents of links.
 * A link whose target changes but whose link text does not must change the user
 * configuration fingerprint. Cycles are represented deterministically.
 */
function hashTree(path) {
  const hash = createHash("sha256");
  const active = new Set();
  const visit = (current, label) => {
    let stat;
    try { stat = lstatSync(current); } catch {
      hash.update(`missing\0${label}\0`);
      return;
    }
    if (stat.isSymbolicLink()) {
      let target;
      try { target = realpathSync(current); } catch {
        hash.update(`dangling-symlink\0${label}\0`);
        return;
      }
      hash.update(`symlink\0${label}\0${target}\0`);
      if (active.has(target)) { hash.update(`cycle\0${target}\0`); return; }
      active.add(target);
      visit(target, `${label}=>`);
      active.delete(target);
      return;
    }
    const identity = realpathSync(current);
    if (active.has(identity)) { hash.update(`cycle\0${identity}\0`); return; }
    active.add(identity);
    if (stat.isDirectory()) {
      hash.update(`directory\0${label}\0`);
      for (const entry of readdirSync(current).sort()) visit(join(current, entry), join(label, entry));
    } else if (stat.isFile()) {
      hash.update(`file\0${label}\0`);
      hash.update(readFileSync(current));
      hash.update("\0");
    } else {
      hash.update(`other\0${label}\0`);
    }
    active.delete(identity);
  };
  visit(path, ".");
  return hash.digest("hex");
}
function userConfigFingerprint() {
  // Follow symlinks and compare every relevant normal user Pi file, including
  // ~/.pi/agent/sessions. This is intentionally a real before/after checksum,
  // not an assertion based on the isolated session-dir pathname.
  const config = createHash("sha256");
  const entries = {};
  for (const entry of USER_PI_CONFIG_ENTRIES) {
    const digest = hashTree(join(homedir(), ".pi", "agent", entry));
    entries[entry] = digest;
    config.update(`${entry}\0${digest}\0`);
  }
  return { piConfiguration: config.digest("hex"), entries, zshrc: hashTree(USER_ZSHRC) };
}
function fingerprintsEqual(before, after) {
  return before.piConfiguration === after.piConfiguration
    && before.zshrc === after.zshrc
    && JSON.stringify(before.entries) === JSON.stringify(after.entries);
}

class ProcessSupervisor {
  constructor() { this.groups = new Set(); }
  add(child) {
    // detached:true gives the child a new process group whose pgid is the
    // child pid. Keep this record after the leader exits: grandchildren may
    // still be in that known group and must be cleaned up.
    const group = { child, pgid: child.pid, terminating: undefined, leaderExited: false };
    this.groups.add(group);
    return group;
  }
  remove(group) { this.groups.delete(group); }
  async terminate(group) {
    if (!group || !group.pgid || group.pgid <= 0) return;
    if (group.terminating) return group.terminating;
    group.terminating = (async () => {
      // Never use child.kill() as a fallback: after the leader has exited its
      // pid may be reused. A negative pid only addresses the process group we
      // created with detached:true; ESRCH means that known group is gone.
      const signalGroup = (signal) => {
        try {
          process.kill(-group.pgid, signal);
          return true;
        } catch (error) {
          if (error?.code === "ESRCH") return false;
          throw error;
        }
      };
      const groupWasAlive = signalGroup("SIGTERM");
      if (groupWasAlive) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, TERMINATE_GRACE_MS));
        // Always sweep the known group, even if its leader exited before this
        // cleanup. A pgid is only retained until this immediate TERM→KILL
        // sequence, avoiding a delayed signal to a recycled process group.
        signalGroup("SIGKILL");
      }
    })();
    try { await group.terminating; }
    finally { this.remove(group); }
  }
  async leaderClosed(group) {
    if (!group) return;
    group.leaderExited = true;
    // Sweep immediately while this pgid still denotes the group created by
    // this harness; this covers leader-exit-with-descendants without keeping a
    // stale numeric pgid around for later reuse.
    await this.terminate(group);
  }
  async terminateAll() {
    await Promise.allSettled([...this.groups].map((group) => this.terminate(group)));
  }
}

function runCommand(supervisor, executable, args, options = {}) {
  const { cwd, env, input, timeoutMs = 60_000, label = [executable, ...args].join(" ") } = options;
  if (!isAbsolute(executable)) fail(`${label} attempted PATH execution: ${executable}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const group = supervisor.add(child);
    let stdout = "";
    let stderr = "";
    let completed = false;
    let timeout;
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolvePromise(result);
    };
    const abort = async (reason) => {
      try { await supervisor.terminate(group); }
      catch (error) { reason = new Error(`${reason.message}\ntermination failed: ${error.message}`); }
      finish(reason);
    };
    timeout = setTimeout(() => { void abort(new Error(`${label} timed out\n${shortOutput(`${stdout}\n${stderr}`)}`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { void abort(new Error(`${label} could not start: ${error.message}`)); });
    child.once("close", async (code, signal) => {
      if (completed) return;
      try { await supervisor.leaderClosed(group); }
      catch (error) { finish(new Error(`${label} cleanup failed: ${error.message}`)); return; }
      if (code !== 0) finish(new Error(`${label} failed (exit ${code}${signal ? `, ${signal}` : ""})\n${shortOutput(`${stdout}\n${stderr}`)}`));
      else finish(undefined, { stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function safePath(tools) {
  return [...new Set([dirname(tools.node), dirname(tools.pi), dirname(tools.git), dirname(tools.npm), "/usr/bin", "/bin"])].join(delimiter);
}
function makeIsolatedEnv(root, tools, extra = {}) {
  const home = join(root, "home");
  const agent = join(root, "agent");
  const sessions = join(root, "sessions");
  const temp = join(root, "tmp");
  const npmCache = join(root, "npm-cache");
  const npmPrefix = join(root, "npm-prefix");
  const emptyNpmrc = join(root, "empty-npmrc");
  const emptyGlobalNpmrc = join(root, "empty-global-npmrc");
  const emptyGitConfig = join(root, "empty-gitconfig");
  for (const directory of [home, agent, sessions, temp, npmCache, npmPrefix]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of [emptyNpmrc, emptyGlobalNpmrc, emptyGitConfig]) writeFileSync(file, "", { mode: 0o600 });
  // Whitelist construction blocks all inherited registry, proxy, auth-token,
  // provider, Pi, npm, and Git environment variables. Both npm spellings are
  // set because npm accepts lowercase config environment names cross-platform.
  const env = {
    PATH: safePath(tools), HOME: home, TMPDIR: temp, TEMP: temp, TMP: temp,
    CI: "1", NO_COLOR: "1", PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o PasswordAuthentication=no",
    npm_config_userconfig: emptyNpmrc, npm_config_globalconfig: emptyGlobalNpmrc,
    NPM_CONFIG_USERCONFIG: emptyNpmrc, NPM_CONFIG_GLOBALCONFIG: emptyGlobalNpmrc,
    npm_config_cache: npmCache, NPM_CONFIG_CACHE: npmCache,
    npm_config_prefix: npmPrefix, NPM_CONFIG_PREFIX: npmPrefix,
    // Keep npm's normal package-lock behavior. The isolated user/global npmrc
    // files protect credentials and host configuration, but must never disable
    // the candidate's committed lockfile.
    npm_config_loglevel: "error", npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false",
    npm_config_proxy: "", npm_config_https_proxy: "", npm_config_noproxy: "",
    NPM_CONFIG_PROXY: "", NPM_CONFIG_HTTPS_PROXY: "", NPM_CONFIG_NOPROXY: "",
    ...extra,
  };
  const forbidden = Object.keys(env).filter((key) => /(?:TOKEN|AUTH|PROXY|REGISTRY|PASSWORD|CREDENTIAL)/i.test(key) && !["npm_config_proxy", "npm_config_https_proxy", "npm_config_noproxy", "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_NOPROXY"].includes(key));
  if (forbidden.length) fail(`isolated environment retained forbidden credential/config keys: ${forbidden.join(", ")}`);
  return { env, home, agent, sessions, temp, emptyNpmrc, emptyGlobalNpmrc };
}

async function makeTargetRepository(root, isolated, tools, supervisor) {
  const target = join(root, "target-repository");
  mkdirSync(target, { recursive: true });
  await runCommand(supervisor, tools.git, ["init", "--quiet"], { cwd: target, env: isolated.env, label: "create temporary target Git repository" });
  writeFileSync(join(target, "README.md"), "temporary compatibility target\n");
  await runCommand(supervisor, tools.git, ["add", "README.md"], { cwd: target, env: isolated.env, label: "stage temporary target repository" });
  await runCommand(supervisor, tools.git, ["-c", "user.name=compat", "-c", "user.email=compat@example.invalid", "commit", "--quiet", "-m", "initial target"], { cwd: target, env: isolated.env, label: "commit temporary target" });
  return target;
}
function readSettings(agentDir) {
  const path = join(agentDir, "settings.json");
  assertFile(path, "isolated Pi settings");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  if (Object.hasOwn(settings, "npmCommand")) fail("isolated Pi settings must omit npmCommand");
  return settings;
}
async function installSubagents(target, isolated, tools, supervisor) {
  const result = await runCommand(supervisor, tools.pi, ["install", "npm:pi-subagents"], { cwd: target, env: isolated.env, timeoutMs: 120_000, label: "isolated pi install npm:pi-subagents" });
  const settings = readSettings(isolated.agent);
  if (!Array.isArray(settings.packages) || !settings.packages.includes("npm:pi-subagents")) fail("isolated settings did not register npm:pi-subagents");
  const packageRoot = join(isolated.agent, "npm", "node_modules", "pi-subagents");
  assertFile(join(packageRoot, "package.json"), "isolated pi-subagents package");
  return { packageRoot, output: shortOutput(`${result.stdout}\n${result.stderr}`) };
}

function parseJsonLines(raw, label) {
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); }
    catch { fail(`${label} emitted non-JSON RPC output: ${line}`); }
  }
  return messages;
}
function writeRuntimeDiagnostic(root, piSubagentsRoot) {
  const diagnostic = join(root, "runtime-registry-diagnostic.ts");
  // The discovery import is pinned to the same isolated package root whose
  // runtime tool provenance we assert below. It cannot accidentally inspect a
  // globally installed pi-subagents copy with the same tool name.
  const agentsModule = pathToFileURL(join(piSubagentsRoot, "src", "agents", "agents.ts")).href;
  writeFileSync(diagnostic, [
    `import { discoverAgentsAll } from ${JSON.stringify(agentsModule)};`,
    "export default function runtimeRegistryDiagnostic(pi: any) {",
    "  pi.on('session_start', async (_event: any, ctx: any) => {",
    "    const tools = pi.getAllTools().map((tool: any) => ({ name: tool.name, sourceInfo: tool.sourceInfo }));",
    "    const commands = pi.getCommands().map((command: any) => ({ name: command.name, sourceInfo: command.sourceInfo }));",
    "    const discovery = discoverAgentsAll(ctx.cwd);",
    "    const agents = [...discovery.user, ...discovery.project, ...discovery.package, ...discovery.builtin].filter((agent: any) => agent.name.startsWith('pi-workflow.')).map((agent: any) => ({ name: agent.name, source: agent.source, filePath: agent.filePath, packageName: agent.packageName, localName: agent.localName }));",
    "    ctx.ui.notify(`WFPICOM_RUNTIME_REGISTRY=${JSON.stringify({ tools, commands })}`, 'info');",
    "    ctx.ui.notify(`WFPICOM_AGENT_DISCOVERY=${JSON.stringify(agents)}`, 'info');",
    "  });",
    "}", "",
  ].join("\n"), { mode: 0o600 });
  return diagnostic;
}

/** A one-request RPC process; no prompt/model request is sent. */
function rpcOnce(target, env, tools, supervisor, request, options = {}) {
  const { label = "Pi RPC diagnostic", executable = tools.pi, extraArgs = [], diagnostics = true } = options;
  if (!isAbsolute(executable)) fail(`${label} attempted PATH execution: ${executable}`);
  return new Promise((resolvePromise, reject) => {
    const childEnv = { ...env, PI_OFFLINE: "1" };
    if (diagnostics) childEnv.WF_CACHE_DIAGNOSTIC = "1";
    const child = spawn(executable, ["--mode", "rpc", "--no-session", "--session-dir", env.PI_CODING_AGENT_SESSION_DIR, ...extraArgs], {
      cwd: target, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const group = supervisor.add(child);
    let stdout = ""; let stderr = ""; let lineBuffer = ""; let responseSeen = false; let settled = false;
    let timeout;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) reject(error); else resolvePromise(value);
    };
    const abort = async (error) => {
      try { await supervisor.terminate(group); } catch (terminationError) { error = new Error(`${error.message}\ntermination failed: ${terminationError.message}`); }
      finish(error);
    };
    const handleLine = (line) => {
      if (!line.trim() || settled) return;
      let message;
      try { message = JSON.parse(line); } catch { void abort(new Error(`${label} emitted non-JSON RPC output: ${line}`)); return; }
      if (message.type === "extension_error") { void abort(new Error(`${label} extension error: ${message.error ?? "unknown"}`)); return; }
      if (message.type === "response" && message.id === request.id) {
        if (message.success !== true) { void abort(new Error(`${label} response failed: ${JSON.stringify(message)}`)); return; }
        responseSeen = true;
        child.stdin.end();
      }
    };
    timeout = setTimeout(() => { void abort(new Error(`${label} timed out\n${shortOutput(`${stdout}\n${stderr}`)}`)); }, RPC_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString(); stdout += text; lineBuffer += text;
      let newline;
      while ((newline = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, ""); lineBuffer = lineBuffer.slice(newline + 1); handleLine(line);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { void abort(new Error(`${label} could not start: ${error.message}`)); });
    child.once("close", async (code, signal) => {
      if (settled) return;
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (settled) return;
      try { await supervisor.leaderClosed(group); }
      catch (error) { finish(new Error(`${label} cleanup failed: ${error.message}`)); return; }
      if (code !== 0) finish(new Error(`${label} failed (exit ${code}${signal ? `, ${signal}` : ""})\n${shortOutput(`${stdout}\n${stderr}`)}`));
      else if (!responseSeen) finish(new Error(`${label} did not return its RPC response\n${shortOutput(stdout)}`));
      else finish(undefined, { stdout, stderr });
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function notification(messages, prefix, label) {
  const entry = messages.find((message) => message.type === "extension_ui_request" && message.method === "notify" && typeof message.message === "string" && message.message.startsWith(prefix));
  if (!entry) fail(`${label} emitted no ${prefix} marker`);
  return entry.message.slice(prefix.length);
}
async function resourceRegistry(target, env, expectedRoot, piSubagentsRoot, expectedAgentSource, tools, supervisor, root, executable = tools.pi) {
  const diagnostic = writeRuntimeDiagnostic(root, piSubagentsRoot);
  const result = await rpcOnce(target, env, tools, supervisor, { id: "resource-registry", type: "get_commands" }, { label: "Pi resource registry diagnostic", executable, extraArgs: ["-e", diagnostic] });
  const messages = parseJsonLines(result.stdout, "Pi resource registry diagnostic");
  const response = messages.find((message) => message.type === "response" && message.id === "resource-registry");
  const commands = response?.data?.commands;
  if (!Array.isArray(commands)) fail("Pi resource registry did not return commands");
  const runtime = JSON.parse(notification(messages, "WFPICOM_RUNTIME_REGISTRY=", "Pi runtime registry"));
  const workflow = commands.find((entry) => entry?.name === "wf" && entry?.source === "extension");
  if (!workflow) fail("Pi resource registry did not register /wf");
  assertEqual(resolve(workflow.sourceInfo?.path ?? workflow.path), join(expectedRoot, "extensions", "workflow.ts"), "/wf extension path");
  const cache = commands.find((entry) => entry?.name === "wf-cache-status" && entry?.source === "extension");
  if (!cache) fail("Pi resource registry did not register opt-in cache diagnostic command");
  assertEqual(resolve(cache.sourceInfo?.path ?? cache.path), join(expectedRoot, "extensions", "cache.ts"), "cache extension marker path");
  notification(messages, "WF_CACHE_EXTENSION_LOADED:", "cache session hook");
  const skill = commands.find((entry) => entry?.name === "skill:bd-work" && entry?.source === "skill");
  if (!skill || !pathWithin(resolve(skill.sourceInfo?.path ?? skill.path), join(expectedRoot, "skills"))) fail("Pi resource registry did not register workflow skills from package root");

  // A same-named tool from an ambient/global extension is not sufficient.
  // sourceInfo is Pi's provenance record, so require both package origin and
  // the exact isolated pi-subagents index that installSubagents just installed.
  const subagentTool = runtime.tools.find((entry) => entry?.name === "subagent");
  if (!subagentTool) fail("isolated Pi did not load pi-subagents extension tool");
  const subagentSource = subagentTool.sourceInfo;
  if (!subagentSource || subagentSource.origin !== "package" || subagentSource.source !== "npm:pi-subagents") fail(`subagent tool provenance is not isolated npm:pi-subagents: ${JSON.stringify(subagentSource)}`);
  assertEqual(resolve(subagentSource.path), join(piSubagentsRoot, "index.ts"), "isolated pi-subagents tool source path");
  const subagentCommand = runtime.commands.find((entry) => entry?.name === "subagents") ?? commands.find((entry) => entry?.name === "subagents");
  if (!subagentCommand) fail("isolated Pi did not register pi-subagents /subagents command");
  const commandPath = subagentCommand.sourceInfo?.path;
  assertEqual(resolve(commandPath ?? ""), join(piSubagentsRoot, "index.ts"), "isolated pi-subagents command source path");
  const subagentSkill = commands.find((entry) => entry?.name === "skill:pi-subagents" && entry?.source === "skill");
  if (!subagentSkill) fail("isolated Pi did not register pi-subagents skill command");
  if (!pathWithin(resolve(subagentSkill.sourceInfo?.path ?? subagentSkill.path), join(piSubagentsRoot, "skills"))) fail("pi-subagents skill provenance is not from isolated package");

  const discoveredAgents = JSON.parse(notification(messages, "WFPICOM_AGENT_DISCOVERY=", "pi-subagents agent discovery"));
  for (const localName of EXPECTED_AGENTS) {
    const runtimeName = `pi-workflow.${localName}`;
    const agent = discoveredAgents.find((entry) => entry?.name === runtimeName);
    if (!agent) fail(`pi-subagents did not discover namespaced workflow agent ${runtimeName}`);
    assertEqual(agent.source, expectedAgentSource, `${runtimeName} discovery source`);
    assertEqual(agent.packageName, "pi-workflow", `${runtimeName} package provenance`);
    assertEqual(agent.localName, localName, `${runtimeName} local name`);
    assertEqual(resolve(agent.filePath), join(expectedRoot, ".pi", "agents", `${localName}.md`), `${runtimeName} discovery path`);
  }

  // Repeat without WF_CACHE_DIAGNOSTIC. This is the targeted regression check
  // that the production V1 registry remains untouched by this harness.
  const normalResult = await rpcOnce(target, env, tools, supervisor, { id: "normal-v1-registry", type: "get_commands" }, { label: "Pi normal V1 registry diagnostic", executable, diagnostics: false });
  const normalMessages = parseJsonLines(normalResult.stdout, "Pi normal V1 registry diagnostic");
  const normalResponse = normalMessages.find((message) => message.type === "response" && message.id === "normal-v1-registry");
  if (normalResponse?.data?.commands?.some((entry) => entry?.name === "wf-cache-status")) fail("WF_CACHE_DIAGNOSTIC-disabled V1 registry exposed wf-cache-status");
  if (normalMessages.some((message) => message.type === "extension_ui_request" && String(message.message ?? "").startsWith("WF_CACHE_EXTENSION_LOADED:"))) fail("WF_CACHE_DIAGNOSTIC-disabled V1 registry emitted cache marker");

  return {
    wfExtension: workflow.sourceInfo?.path ?? workflow.path,
    cacheExtension: cache.sourceInfo?.path ?? cache.path,
    cacheHookMarker: "WF_CACHE_EXTENSION_LOADED:before_agent_start,message_end",
    normalV1CacheInstrumentationAbsent: true,
    skill: skill.sourceInfo?.path ?? skill.path,
    piSubagents: { tool: "subagent", sourceInfo: subagentSource, command: "subagents", commandPath, skill: subagentSkill.sourceInfo?.path ?? subagentSkill.path },
    agents: discoveredAgents.filter((agent) => EXPECTED_AGENTS.some((name) => agent?.name === `pi-workflow.${name}`)),
    commandCount: commands.length,
  };
}

function assertRootManifest(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.name !== "pi-workflow" || !manifest.keywords?.includes("pi-package")) fail("candidate is not the pi-workflow Pi package");
  const pi = manifest.pi;
  if (!pi?.extensions?.includes("./extensions/workflow.ts") || !pi.extensions.includes("./extensions/cache.ts")) fail("candidate Pi manifest lacks workflow/cache extension declarations");
  if (!pi?.skills?.includes("./skills") || !pi?.subagents?.agents?.includes("./.pi/agents")) fail("candidate Pi manifest lacks skills or pi-subagents agent declarations");
  for (const file of ["extensions/workflow.ts", "extensions/cache.ts", "scripts/wfpi", "workflow.config.json", "package-lock.json"]) assertFile(join(root, file), `stable V1 resource ${file}`);
  for (const agent of EXPECTED_AGENTS) assertFile(join(root, ".pi", "agents", `${agent}.md`), `workflow ${agent} agent`);
}
function packageLockDigest(root) { return createHash("sha256").update(readFileSync(join(root, "package-lock.json"))).digest("hex"); }
const PACKAGE_LOCK_ENV_KEYS = ["npm_config_package_lock", "NPM_CONFIG_PACKAGE_LOCK"];
async function assertNormalPackageLock(root, label, tools, supervisor, env) {
  // A package-lock=false environment variable makes npm silently bypass the
  // lock. Fail before spawning npm so this regression cannot be disguised by
  // a subsequently unchanged file hash.
  const overrides = PACKAGE_LOCK_ENV_KEYS.filter((key) => Object.hasOwn(env, key));
  if (overrides.length) fail(`${label} isolated npm environment must not override package-lock: ${overrides.join(", ")}`);
  const configured = await runCommand(supervisor, tools.npm, ["config", "get", "package-lock"], { cwd: root, env, label: `${label} npm config get package-lock` });
  assertEqual(configured.stdout.trim(), "true", `${label} npm must accept package-lock`);
  // --package-lock-only parses the committed lock's production graph rather
  // than consulting node_modules. This proves npm accepts the input before
  // the normal --omit=dev install below changes the installation tree.
  const listed = await runCommand(supervisor, tools.npm, ["ls", "--package-lock-only", "--omit=dev", "--all", "--json"], { cwd: root, env, label: `${label} npm ls --package-lock-only --omit=dev` });
  let tree;
  try { tree = JSON.parse(listed.stdout); }
  catch { fail(`${label} npm lockfile production graph emitted invalid JSON: ${shortOutput(listed.stdout)}`); }
  const devDependencies = productionDependencyNames(root, label);
  assertNoResolvedDependency(tree, devDependencies, `${label} lockfile production graph`);
  return { packageLockEnabled: true, lockfileProductionGraphAccepted: true, lockfileDevDependenciesUnresolved: devDependencies };
}
function productionDependencyNames(root, label) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const names = Object.keys(manifest.devDependencies ?? {}).sort();
  if (names.length === 0) fail(`${label} package.json has no devDependencies to verify`);
  return names;
}
function assertNoResolvedDependency(tree, forbiddenNames, label) {
  const forbidden = new Set(forbiddenNames);
  const visit = (node, location) => {
    if (!node || typeof node !== "object") return;
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (forbidden.has(name)) fail(`${label} production npm resolution retained devDependency ${name} at ${location}`);
      visit(dependency, `${location}>${name}`);
    }
  };
  visit(tree, "root");
}
async function assertProductionInstall(root, lockBefore, label, tools, supervisor, env) {
  assertEqual(packageLockDigest(root), lockBefore, `${label} package-lock.json must remain byte-for-byte unchanged`);
  const packageLock = await assertNormalPackageLock(root, label, tools, supervisor, env);
  assertFile(join(root, "node_modules"), `${label} production node_modules`);
  const devDependencies = productionDependencyNames(root, label);
  for (const dependency of devDependencies) {
    if (existsSync(join(root, "node_modules", dependency))) fail(`${label} installed root dev dependency ${dependency} despite --omit=dev`);
  }
  const listed = await runCommand(supervisor, tools.npm, ["ls", "--omit=dev", "--all", "--json"], { cwd: root, env, label: `${label} npm ls --omit=dev` });
  let tree;
  try { tree = JSON.parse(listed.stdout); }
  catch { fail(`${label} npm ls --omit=dev emitted invalid JSON: ${shortOutput(listed.stdout)}`); }
  assertNoResolvedDependency(tree, devDependencies, label);
  return {
    lockfileUnchanged: true,
    productionInstall: true,
    ...packageLock,
    devDependenciesAbsent: devDependencies,
    devDependenciesUnresolved: devDependencies,
  };
}

function assertIsolatedSessionsUnused(isolated, label) {
  const entries = readdirSync(isolated.sessions);
  if (entries.length !== 0) fail(`${label} wrote persistent data to isolated session directory despite --no-session: ${entries.join(", ")}`);
  return true;
}

async function localSource(candidate, root, tools, supervisor) {
  assertRootManifest(candidate);
  const isolated = makeIsolatedEnv(root, tools);
  const target = await makeTargetRepository(root, isolated, tools, supervisor);
  const subagents = await installSubagents(target, isolated, tools, supervisor);
  const wfpi = join(candidate, "scripts", "wfpi");
  assertFile(wfpi, "local-source wfpi launcher");
  // The launcher receives a validated absolute Pi executable and has no reason
  // to fall back to PATH. This exercises its actual source mode behavior.
  const localEnv = { ...isolated.env, WF_AGENT_HOME: candidate, WF_PI_EXECUTABLE: tools.pi };
  const registry = await resourceRegistry(target, localEnv, candidate, subagents.packageRoot, "user", tools, supervisor, root, wfpi);
  const sessionsUnused = assertIsolatedSessionsUnused(isolated, "local-source");
  return { target, isolated: { agent: isolated.agent, sessions: isolated.sessions, home: isolated.home }, sessionsUnused, piSubagents: subagents.packageRoot, registry, npmCommandOmitted: !Object.hasOwn(readSettings(isolated.agent), "npmCommand") };
}

async function cloneParity(candidate, root, tools, supervisor) {
  assertRootManifest(candidate);
  const isolated = makeIsolatedEnv(root, tools);
  const candidateSha = (await runCommand(supervisor, tools.git, ["rev-parse", "HEAD"], { cwd: candidate, env: isolated.env, label: "resolve candidate commit" })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) fail(`candidate commit is not a full SHA: ${candidateSha}`);
  const clone = join(root, "candidate-clone");
  await runCommand(supervisor, tools.git, ["clone", "--quiet", "--no-local", "--no-hardlinks", candidate, clone], { cwd: root, env: isolated.env, timeoutMs: 120_000, label: "clone exact candidate commit" });
  const cloneSha = (await runCommand(supervisor, tools.git, ["rev-parse", "HEAD"], { cwd: clone, env: isolated.env, label: "read cloned candidate commit" })).stdout.trim();
  assertEqual(cloneSha, candidateSha, "clone parity commit");
  const lockBefore = packageLockDigest(clone);
  const lockfileBeforeInstall = await assertNormalPackageLock(clone, "candidate clone", tools, supervisor, isolated.env);
  const npm = await runCommand(supervisor, tools.npm, ["install", "--omit=dev"], { cwd: clone, env: isolated.env, timeoutMs: 180_000, label: "candidate clone npm install --omit=dev" });
  const production = await assertProductionInstall(clone, lockBefore, "candidate clone", tools, supervisor, isolated.env);
  const target = await makeTargetRepository(root, isolated, tools, supervisor);
  const subagents = await installSubagents(target, isolated, tools, supervisor);
  await runCommand(supervisor, tools.pi, ["install", clone], { cwd: target, env: isolated.env, timeoutMs: 120_000, label: "register cloned root as isolated Pi package" });
  const settings = readSettings(isolated.agent);
  if (!settings.packages.some((entry) => typeof entry === "string" && entry !== "npm:pi-subagents")) fail("isolated settings did not register cloned root package");
  const registry = await resourceRegistry(target, isolated.env, clone, subagents.packageRoot, "package", tools, supervisor, root);
  const sessionsUnused = assertIsolatedSessionsUnused(isolated, "clone-parity");
  return { candidateSha, clone, target, isolated: { agent: isolated.agent, sessions: isolated.sessions, home: isolated.home }, sessionsUnused, piSubagents: subagents.packageRoot, npmInstall: shortOutput(`${npm.stdout}\n${npm.stderr}`), npmCommandOmitted: !Object.hasOwn(settings, "npmCommand"), lockfileBeforeInstall, production, registry };
}

function parseGitSource(source) {
  const match = /^git:github\.com\/wiizard-chen\/workflow-agent@([0-9a-f]{40})$/.exec(source ?? "");
  if (!match) fail("--source must be exactly git:github.com/wiizard-chen/workflow-agent@<40-lowercase-hex-sha>; SSH, credentials, and mutable refs are forbidden");
  return match[1];
}
async function piGitInstall(source, root, tools, supervisor) {
  const expectedSha = parseGitSource(source);
  const isolated = makeIsolatedEnv(root, tools);
  const target = await makeTargetRepository(root, isolated, tools, supervisor);
  const subagents = await installSubagents(target, isolated, tools, supervisor);
  await runCommand(supervisor, tools.pi, ["install", source], { cwd: target, env: isolated.env, timeoutMs: 180_000, label: "actual isolated Pi Git-package install" });
  const settings = readSettings(isolated.agent);
  if (!settings.packages.includes(source)) fail("isolated settings did not retain exact Git source");
  const installed = join(isolated.agent, "git", "github.com", "wiizard-chen", "workflow-agent");
  assertFile(join(installed, "package.json"), "Pi-installed Git package");
  const installedSha = (await runCommand(supervisor, tools.git, ["rev-parse", "HEAD"], { cwd: installed, env: isolated.env, label: "read Pi-installed Git package commit" })).stdout.trim();
  assertEqual(installedSha, expectedSha, "Pi-installed Git package commit");
  const committedLock = (await runCommand(supervisor, tools.git, ["show", "HEAD:package-lock.json"], { cwd: installed, env: isolated.env, label: "read Pi Git-package committed lockfile" })).stdout;
  const committedLockDigest = createHash("sha256").update(committedLock).digest("hex");
  const lockfileBeforeInstall = await assertNormalPackageLock(installed, "Pi Git-package install", tools, supervisor, isolated.env);
  const production = await assertProductionInstall(installed, committedLockDigest, "Pi Git-package install", tools, supervisor, isolated.env);
  const registry = await resourceRegistry(target, isolated.env, installed, subagents.packageRoot, "package", tools, supervisor, root);
  const sessionsUnused = assertIsolatedSessionsUnused(isolated, "pi-git-install");
  return { expectedSha, installed, target, isolated: { agent: isolated.agent, sessions: isolated.sessions, home: isolated.home }, sessionsUnused, piSubagents: subagents.packageRoot, npmCommandOmitted: !Object.hasOwn(settings, "npmCommand"), lockfileBeforeInstall, production, registry };
}

let signalCleanup;
function removeAndAssert(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  if (existsSync(root)) fail(`temporary compatibility state was not cleaned: ${root}`);
}
async function main() {
  const { mode, candidate: rawCandidate, source } = parseArgs(process.argv.slice(2));
  if (mode !== "pi-git-install" && !rawCandidate) fail(`--candidate is required for ${mode} mode`);
  const candidate = rawCandidate ? resolve(rawCandidate) : undefined;
  if (candidate && (!existsSync(candidate) || !existsSync(join(candidate, ".git")))) fail(`candidate must be an existing Git checkout: ${candidate}`);
  const tools = resolveTools();
  const before = userConfigFingerprint();
  const root = mkdtempSync(join(tmpdir(), "workflow-agent-v2-package-compat-"));
  const supervisor = new ProcessSupervisor();
  signalCleanup = async (signal) => {
    try { await supervisor.terminateAll(); removeAndAssert(root); }
    catch (error) { console.error(`package compatibility ${signal} cleanup failed: ${error.message}`); }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  let evidence; let runError;
  try {
    if (mode === "local-source") evidence = await localSource(candidate, root, tools, supervisor);
    else if (mode === "clone-parity") evidence = await cloneParity(candidate, root, tools, supervisor);
    else evidence = await piGitInstall(source, root, tools, supervisor);
  } catch (error) {
    runError = error;
  } finally {
    await supervisor.terminateAll();
    removeAndAssert(root);
  }
  const after = userConfigFingerprint();
  if (!fingerprintsEqual(before, after)) fail(`user Pi configuration changed during isolated compatibility run: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  if (runError) throw runError;
  console.log(JSON.stringify({ ok: true, mode, candidate, source, tools, userConfig: { before, after, unchanged: true, followsSymlinkTargets: true, sessionsCompared: true }, cleanup: { temporaryRoot: root, removed: true, verifiedOnSuccessAndFailure: true }, evidence }, null, 2));
}
process.once("SIGINT", () => { if (signalCleanup) void signalCleanup("SIGINT"); });
process.once("SIGTERM", () => { if (signalCleanup) void signalCleanup("SIGTERM"); });
main().catch((error) => { console.error(`package compatibility FAILED: ${error instanceof Error ? error.stack : String(error)}`); process.exitCode = 1; });
