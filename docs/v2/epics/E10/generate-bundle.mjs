#!/usr/bin/env node

/**
 * Deterministic E10 PRD/document bundle generator.
 *
 * This file produces contract evidence only. It does not migrate a Runtime
 * database, launch a worker, make a recovery decision, or write Beads state.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(import.meta.url);
const epicDir = dirname(generatorPath);
const bundleDir = resolve(epicDir, "bundle");
const sourcePath = resolve(epicDir, "PRD.md");
const v2Dir = resolve(epicDir, "../..");
const repositoryRoot = resolve(epicDir, "../../../..");
const output = Object.freeze({
  html: resolve(bundleDir, "approved-prd.html"),
  markdown: resolve(bundleDir, "approved-prd.md"),
  structured: resolve(bundleDir, "document.json"),
  manifest: resolve(bundleDir, "manifest.json"),
  digest: resolve(bundleDir, "manifest.sha256"),
});
const renderer = Object.freeze({ id: "pi-workflow-e10-step-ledger-safe-preformatted-html", mode: "escaped-markdown-pre", version: 1 });
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const read = (path) => readFileSync(path, "utf8");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function slug(title) {
  return title.replaceAll("`", "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sectionHashes(markdown) {
  const headings = [...markdown.matchAll(/^#{1,6}[ \t]+(.+)$/gm)];
  const sections = headings.map((heading, index) => {
    const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    return [slug(heading[1]), markdown.slice(heading.index, end)];
  });
  if (new Set(sections.map(([name]) => name)).size !== sections.length) throw new Error("duplicate_prd_heading_slug");
  return Object.fromEntries(sections.sort(([left], [right]) => left.localeCompare(right)).map(([name, text]) => [name, hash(text)]));
}

function authorityDocuments() {
  const names = ["ARCHITECTURE_RFC.md", "INITIAL_EPIC_MAP.md", "INITIATIVE_CHARTER.md", "THIRD_PARTY_REUSE_SURVEY.md"];
  return Object.fromEntries(names.map((name) => {
    const content = read(resolve(v2Dir, name));
    return [name, { path: `../../../${name}`, sha256: hash(content), sectionHashes: sectionHashes(content) }];
  }));
}

function dependencies() {
  const map = read(resolve(v2Dir, "INITIAL_EPIC_MAP.md"));
  const heading = /^##\s+E10\b/m.exec(map);
  if (!heading) throw new Error("missing_E10_map_entry");
  const rest = map.slice(heading.index);
  const next = /^##\s+/m.exec(rest.slice(heading[0].length));
  const block = next ? rest.slice(0, heading[0].length + next.index) : rest;
  const line = /^- \*\*Dependencies:\*\*\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!line) throw new Error("missing_E10_dependencies");
  const result = line.split(",").map((value) => value.trim().replace(/[.;]+$/, ""));
  const expected = ["E02", "E05", "E07", "E08"];
  if (result.join(",") !== expected.join(",")) throw new Error(`unexpected_E10_dependencies:${result.join(",")}`);
  return Object.freeze(result);
}

function dependencyBaselines(deps) {
  return Object.fromEntries(deps.map((mapId) => {
    const path = resolve(repositoryRoot, `docs/v2/epics/${mapId}/bundle/manifest.sha256`);
    if (!existsSync(path)) throw new Error(`missing_${mapId}_manifest_baseline`);
    const manifestSha256 = read(path).trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(manifestSha256)) throw new Error(`invalid_${mapId}_manifest_baseline`);
    return [mapId, { path: `../../${mapId}/bundle/manifest.sha256`, manifestSha256 }];
  }));
}

function renderHtml(markdown, markdownHash) {
  const escaped = markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-ancestors &#39;none&#39;; style-src &#39;unsafe-inline&#39;">',
    "<title>E10 PRD — Step Ledger and recovery scanner</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#7c2d12;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px;box-shadow:0 1px 3px #0001}</style>",
    "</head><body><main>", `<header><strong>E10 PRD CANDIDATE — PENDING EXACT MANIFEST CONFIRMATION</strong><br>Bundle Markdown SHA-256: ${markdownHash}<br>Renderer: ${renderer.id}</header>`, `<pre>${escaped}</pre>`, "</main></body></html>", "",
  ].join("\n");
}

function buildDocument(source, rendered, deps) {
  const sourcePrdSha256 = hash(source);
  return json({
    schemaVersion: 1,
    documentType: "bounded-epic-prd",
    metadata: {
      initiative: "workflow-agent-c2b", epic: "workflow-agent-c2b.14", mapId: "E10",
      title: "Step Ledger and generic recovery scanner", version: "draft-v1",
      productStatus: "draft-recommended-mvp", approvalStatus: "pending-exact-manifest-confirmation",
      engineeringEligibility: "ineligible-until-bundle-readback", deliveryUnits: 1, maximumTasks: 5,
      verificationProfile: "strict", runtimeSchemaMigration: 4,
    },
    sourcePrdSha256,
    sectionHashes: sectionHashes(source),
    dependencies: deps,
    dependencyBaselines: dependencyBaselines(deps),
    scope: {
      package: "@pi-workflow/workflowd",
      implementationArea: "apps/workflowd/src/steps",
      migrationVersion: 4,
      included: ["Step current-state projection", "immutable StepAttemptRecord", "canonical input/hash binding", "E08 lease/fencing guarded mutations", "E07 read-only artifact verification seam", "interrupted-step scanner", "deterministic recovery report", "explicit append-only recovery decisions"],
      excluded: ["TaskAttempt", "RoleRun", "LaunchPermit", "scheduler", "worker launch", "Git/GitHub/Beads", "Dev/Reviewer recovery", "artifact repair/deletion", "automatic external-effect inference", "external durable-execution provider"],
    },
    publicBoundary: {
      facade: "openStepLedger",
      methods: ["prepare", "transition", "observeEffect", "validate", "complete", "read", "scan", "adopt", "retry", "supersede", "manualRecovery", "inspect", "close"],
      forbiddenExports: ["native SQLite handle", "SQL", "filesystem writer", "artifact writer/deleter", "lease store", "worker process handle", "arbitrary mutation callback", "TaskAttempt", "RoleRun", "LaunchPermit"],
    },
    verification: {
      profile: "strict",
      commands: ["npm --workspace=@pi-workflow/workflowd run test", "npm --workspace=@pi-workflow/workflowd run typecheck", "npm test", "npm run typecheck", "npm run validate:v2-boundaries", "node docs/v2/epics/E10/generate-bundle.mjs --check", "git diff --check"],
    },
    authorityDocuments: authorityDocuments(),
    rendered: { htmlSha256: hash(rendered), renderer },
  });
}

function generate() {
  const source = read(sourcePath);
  const sourcePrdSha256 = hash(source);
  const rendered = renderHtml(source, sourcePrdSha256);
  const deps = dependencies();
  const document = buildDocument(source, rendered, deps);
  const files = Object.freeze({ "approved-prd.md": source, "approved-prd.html": rendered, "document.json": document });
  const fileHashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)]));
  const manifest = json({
    schemaVersion: 1,
    status: "candidate",
    approvalStatus: "pending-exact-manifest-confirmation",
    bundleType: "approved-document-bundle",
    documentBundleId: "workflow-agent-c2b-e10-draft-v1-candidate",
    initiativeId: "workflow-agent-c2b",
    epicId: "workflow-agent-c2b.14",
    mapId: "E10",
    sourcePrdSha256,
    authorityDocuments: authorityDocuments(),
    dependencies: deps,
    dependencyBaselines: dependencyBaselines(deps),
    documents: {
      source: { path: "../PRD.md", mediaType: "text/markdown", sha256: sourcePrdSha256 },
      "approved-prd.md": { path: "approved-prd.md", mediaType: "text/markdown", sha256: fileHashes["approved-prd.md"] },
      "approved-prd.html": { path: "approved-prd.html", mediaType: "text/html", sha256: fileHashes["approved-prd.html"] },
      "document.json": { path: "document.json", mediaType: "application/json", sha256: fileHashes["document.json"] },
    },
    files: fileHashes,
    documentSha256: hash(document),
    renderer,
    generator: {
      path: "../generate-bundle.mjs",
      id: "pi-workflow-e10-step-ledger-bundle-generator",
      sha256: hash(read(generatorPath)),
      checkCommand: "node docs/v2/epics/E10/generate-bundle.mjs --check",
    },
    governance: {
      exactManifestConfirmationRequired: true,
      beadsWriteReadbackRequired: true,
      implementationRequiresApprovedInputs: true,
      scannerIsReadOnly: true,
      recoveryDecisionMustBeExplicit: true,
    },
  });
  return Object.freeze({ files, manifest, manifestSha256: hash(manifest) });
}

const result = generate();
if (process.argv.includes("--check")) {
  if (!existsSync(output.manifest) || !existsSync(output.digest) || read(output.manifest) !== result.manifest || read(output.digest).trim() !== result.manifestSha256) throw new Error("E10_bundle_not_deterministic");
  for (const [name, content] of Object.entries(result.files)) if (!existsSync(resolve(bundleDir, name)) || read(resolve(bundleDir, name)) !== content) throw new Error(`E10_bundle_file_mismatch:${name}`);
  console.log(`E10 bundle check passed: ${result.manifestSha256}`);
} else {
  mkdirSync(bundleDir, { recursive: true });
  for (const [name, content] of Object.entries(result.files)) writeFileSync(resolve(bundleDir, name), content, "utf8");
  writeFileSync(output.manifest, result.manifest, "utf8");
  writeFileSync(output.digest, `${result.manifestSha256}\n`, "utf8");
  console.log(`E10 bundle generated: ${result.manifestSha256}`);
}
