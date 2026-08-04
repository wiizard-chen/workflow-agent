#!/usr/bin/env node

/**
 * Deterministic E11 PRD/document bundle generator.
 *
 * This produces documentation evidence only. It does not launch a daemon or
 * worker, create an artifact, mutate a repository, or write Beads state.
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
const renderer = Object.freeze({
  id: "pi-workflow-e11-walking-skeleton-safe-preformatted-html",
  mode: "escaped-markdown-pre",
  version: 1,
});
const EXPECTED_MAP_SECTION_SHA256 = "8656b55ea858e3778f3e57dcf9b8d307904ccfc0791a92be317eaee61825db5c";
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

function mapSection() {
  const map = read(resolve(v2Dir, "INITIAL_EPIC_MAP.md"));
  const heading = /^##\s+E11\b/m.exec(map);
  if (!heading) throw new Error("missing_E11_map_entry");
  const rest = map.slice(heading.index);
  const next = /^##\s+/m.exec(rest.slice(heading[0].length));
  const block = next ? rest.slice(0, heading[0].length + next.index) : rest;
  const sectionSha256 = hash(block);
  if (sectionSha256 !== EXPECTED_MAP_SECTION_SHA256) throw new Error(`unexpected_E11_map_section_sha256:${sectionSha256}`);
  return Object.freeze({ path: "../../INITIAL_EPIC_MAP.md#E11", sha256: sectionSha256 });
}

function dependencies() {
  const map = read(resolve(v2Dir, "INITIAL_EPIC_MAP.md"));
  const heading = /^##\s+E11\b/m.exec(map);
  if (!heading) throw new Error("missing_E11_map_entry");
  const rest = map.slice(heading.index);
  const next = /^##\s+/m.exec(rest.slice(heading[0].length));
  const block = next ? rest.slice(0, heading[0].length + next.index) : rest;
  const line = /^- \*\*Dependencies:\*\*\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!line) throw new Error("missing_E11_dependencies");
  const result = line.split(",").map((value) => value.trim().replace(/[.;]+$/, ""));
  const expected = ["E03", "E06", "E07", "E08", "E09", "E10"];
  if (result.join(",") !== expected.join(",")) throw new Error(`unexpected_E11_dependencies:${result.join(",")}`);
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
    "<title>E11 PRD — First local walking skeleton</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#14532d;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px;box-shadow:0 1px 3px #0001}</style>",
    "</head><body><main>", `<header><strong>E11 PRD CANDIDATE — PENDING EXACT MANIFEST CONFIRMATION</strong><br>Bundle Markdown SHA-256: ${markdownHash}<br>Renderer: ${renderer.id}</header>`, `<pre>${escaped}</pre>`, "</main></body></html>", "",
  ].join("\n");
}

function buildDocument(source, rendered, deps, map) {
  const sourcePrdSha256 = hash(source);
  return json({
    schemaVersion: 1,
    documentType: "bounded-epic-prd",
    metadata: {
      initiative: "workflow-agent-c2b", epic: "workflow-agent-c2b.15", mapId: "E11",
      title: "First local walking skeleton", version: "draft-v1",
      productStatus: "draft-recommended-mvp", approvalStatus: "pending-exact-manifest-confirmation",
      engineeringEligibility: "ineligible-until-bundle-readback", deliveryUnits: 1, maximumTasks: 5,
      verificationProfile: "strict", activeEngineeringTime: "2h",
    },
    sourcePrdSha256,
    sectionHashes: sectionHashes(source),
    mapSection: map,
    dependencies: deps,
    dependencyBaselines: dependencyBaselines(deps),
    scope: {
      implementationArea: "root-level scripts/ or root test/ synthetic harness",
      included: ["synthetic E03 Job command/query/events", "E06 client/daemon composition", "E08 fenced Worker generation", "deterministic fake Pi Lead", "one-time synthetic role permit seam", "immutable E07 JSON artifact", "E10 evidence-bound Step completion", "restart/recovery/idempotency smoke", "responsive status/replay"],
      excluded: ["production repository mutation", "TaskAttempt", "RoleRun", "generic LaunchPermit", "scheduler", "Beads", "Git/GitHub/PR", "sandbox", "model/provider/network", "external durable execution"],
    },
    packageBoundary: {
      allowedComposition: ["@pi-workflow/workflowd", "@pi-workflow/workflow-worker"],
      workerDependencyRule: "structural ports only; workflow-worker must not import workflowd",
      forbiddenCapabilities: ["private application imports", "native SQLite/SQL handles", "shell", "Git", "Beads", "repository writer", "network/provider", "arbitrary completion evidence"],
    },
    syntheticFixture: {
      command: "synthetic.e11.job.start@v1",
      query: "synthetic.e11.job.read@v1",
      events: ["synthetic.e11.job.started@v1", "synthetic.e11.job.completed@v1"],
      stableJobId: "e11-job-001", stableStepId: "e11-step-001", role: "synthetic-role",
      artifactMetadata: { mediaType: "application/json", authority: "workflowd.synthetic-e11", retention: "standard", redaction: "not-required" },
      statePath: ["prepare", "executing", "effect-observed", "validated", "completed"],
    },
    verification: {
      profile: "strict",
      commands: ["npm --workspace=@pi-workflow/v2-protocol run test", "npm --workspace=@pi-workflow/workflowd run test", "npm --workspace=@pi-workflow/workflow-worker run test", "npm run test:e11", "npm test", "npm run typecheck", "npm run validate:v2-boundaries", "node docs/v2/epics/E11/generate-bundle.mjs --check", "git diff --check"],
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
  const map = mapSection();
  const document = buildDocument(source, rendered, deps, map);
  const files = Object.freeze({ "approved-prd.md": source, "approved-prd.html": rendered, "document.json": document });
  const fileHashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)]));
  const manifest = json({
    schemaVersion: 1,
    status: "candidate",
    approvalStatus: "pending-exact-manifest-confirmation",
    bundleType: "approved-document-bundle",
    documentBundleId: "workflow-agent-c2b-e11-draft-v1-candidate",
    initiativeId: "workflow-agent-c2b",
    epicId: "workflow-agent-c2b.15",
    mapId: "E11",
    mapSection: map,
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
      id: "pi-workflow-e11-walking-skeleton-bundle-generator",
      sha256: hash(read(generatorPath)),
      checkCommand: "node docs/v2/epics/E11/generate-bundle.mjs --check",
    },
    governance: {
      exactManifestConfirmationRequired: true,
      beadsWriteReadbackRequired: true,
      implementationRequiresApprovedInputs: true,
      syntheticFixtureOnly: true,
      noProductionRepositoryMutation: true,
      workerToWorkflowdImportForbidden: true,
      completionRequiresArtifactAndStepEvidence: true,
      restartRecoveryMustBeIdempotent: true,
    },
  });
  return Object.freeze({ files, manifest, manifestSha256: hash(manifest) });
}

const result = generate();
if (process.argv.includes("--check")) {
  if (!existsSync(output.manifest) || !existsSync(output.digest) || read(output.manifest) !== result.manifest || read(output.digest).trim() !== result.manifestSha256) throw new Error("E11_bundle_not_deterministic");
  for (const [name, content] of Object.entries(result.files)) if (!existsSync(resolve(bundleDir, name)) || read(resolve(bundleDir, name)) !== content) throw new Error(`E11_bundle_file_mismatch:${name}`);
  console.log(`E11 bundle check passed: ${result.manifestSha256}`);
} else {
  mkdirSync(bundleDir, { recursive: true });
  for (const [name, content] of Object.entries(result.files)) writeFileSync(resolve(bundleDir, name), content, "utf8");
  writeFileSync(output.manifest, result.manifest, "utf8");
  writeFileSync(output.digest, `${result.manifestSha256}\n`, "utf8");
  console.log(`E11 bundle generated: ${result.manifestSha256}`);
}
