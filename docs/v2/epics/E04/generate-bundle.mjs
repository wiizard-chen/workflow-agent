#!/usr/bin/env node

/** Deterministic E04 PRD candidate bundle generator; documentation only. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(import.meta.url);
const epicDir = dirname(generatorPath);
const bundleDir = resolve(epicDir, "bundle");
const sourcePath = resolve(epicDir, "PRD.md");
const v2Dir = resolve(epicDir, "../..");
const out = Object.freeze({
  html: resolve(bundleDir, "approved-prd.html"),
  markdown: resolve(bundleDir, "approved-prd.md"),
  structured: resolve(bundleDir, "document.json"),
  manifest: resolve(bundleDir, "manifest.json"),
  manifestSha256: resolve(bundleDir, "manifest.sha256"),
});
const renderer = Object.freeze({
  id: "pi-workflow-e04-bootstrap-safe-preformatted-html",
  mode: "escaped-markdown-pre",
  version: 1,
});

const read = (path) => readFileSync(path, "utf8");
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

function sections(markdown) {
  const heads = [...markdown.matchAll(/^#{1,6}[ \t]+(.+)$/gm)];
  const entries = heads.map((head, index) => {
    const start = head.index;
    const end = index + 1 < heads.length ? heads[index + 1].index : markdown.length;
    const slug = head[1].replaceAll("`", "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return [slug, markdown.slice(start, end)];
  });
  if (new Set(entries.map(([slug]) => slug)).size !== entries.length) throw new Error("duplicate PRD heading slug");
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)).map(([slug, text]) => [slug, hash(text)]));
}

function authorityDocuments() {
  return Object.fromEntries(["ARCHITECTURE_RFC.md", "INITIAL_EPIC_MAP.md", "INITIATIVE_CHARTER.md", "THIRD_PARTY_REUSE_SURVEY.md"].map((name) => {
    const content = read(resolve(v2Dir, name));
    return [name, { path: `../../../${name}`, sha256: hash(content), sectionHashes: sections(content) }];
  }));
}

function mapDependencies(epicId) {
  const map = read(resolve(v2Dir, "INITIAL_EPIC_MAP.md"));
  const heading = new RegExp(`^##\\s+${epicId}\\b`, "m").exec(map);
  if (!heading) throw new Error(`missing ${epicId} entry in INITIAL_EPIC_MAP.md`);
  const remainder = map.slice(heading.index);
  const nextHeading = /^##\s+/m.exec(remainder.slice(heading[0].length));
  const block = nextHeading
    ? remainder.slice(0, heading[0].length + nextHeading.index)
    : remainder;
  const line = /^- \*\*Dependencies:\*\*\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!line) throw new Error(`missing Dependencies field for ${epicId}`);
  if (/^none\.?$/i.test(line)) return [];
  const dependencies = line.split(",").map((value) => value.trim().replace(/\.$/, ""));
  if (dependencies.some((value) => !/^E\d+$/.test(value))) throw new Error(`invalid ${epicId} dependency field: ${line}`);
  if (new Set(dependencies).size !== dependencies.length) throw new Error(`duplicate ${epicId} dependency`);
  return dependencies;
}

const dependencyBaselineCatalog = Object.freeze({
  E01: Object.freeze({ requiredCommit: "d5debd4d03114a80a45b14ccdb7439b944d6461d" }),
  E68: Object.freeze({ qualificationEvidenceRequired: true }),
});

function html(markdown, markdownHash) {
  const escaped = markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="robots" content="noindex,nofollow">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-ancestors &#39;none&#39;; style-src &#39;unsafe-inline&#39;">',
    "<title>E04 PRD — pending human confirmation</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,monospace}main{max-width:1100px;margin:auto;padding:32px}header{background:#374151;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px}</style>",
    "</head><body><main>",
    `<header><strong>E04 PRD CANDIDATE — PENDING HUMAN CONFIRMATION</strong><br>Bundle Markdown SHA-256: ${markdownHash}<br>Renderer: ${renderer.id}</header>`,
    `<pre>${escaped}</pre>`, "</main></body></html>", "",
  ].join("\n");
}

function generate() {
  const source = read(sourcePath);
  const markdown = source;
  const rendered = html(markdown, hash(markdown));
  const dependencies = mapDependencies("E04");
  const dependencyBaselines = Object.fromEntries(dependencies.map((id) => {
    const baseline = dependencyBaselineCatalog[id];
    if (!baseline) throw new Error(`missing dependency baseline for ${id}`);
    return [id, baseline];
  }));
  const document = json({
    schemaVersion: 1,
    documentType: "bounded-epic-prd",
    metadata: {
      initiative: "workflow-agent-c2b",
      epic: "workflow-agent-c2b.8",
      mapId: "E04",
      title: "SQLite WAL store and migration bootstrap",
      version: "draft-v1",
      approvalStatus: "pending-human-confirmation",
      engineeringEligibility: "ineligible",
      deliveryUnits: 1,
      maximumTasks: 5,
      verificationProfile: "strict",
    },
    sourcePrdSha256: hash(source),
    sectionHashes: sections(source),
    dependencies,
    scope: { package: "@pi-workflow/workflowd", implementationArea: "apps/workflowd/src/persistence" },
    verification: {
      profile: "strict",
      commands: [
        "npm --workspace=@pi-workflow/workflowd run test",
        "npm run typecheck:v2",
        "npm run validate:v2-boundaries",
        "git diff --check",
      ],
    },
  });
  const manifest = json({
    schemaVersion: 1,
    status: "candidate",
    approvalStatus: "pending-human-confirmation",
    documentBundleId: "workflow-agent-c2b-e04-draft-v1-candidate",
    initiativeId: "workflow-agent-c2b",
    epicId: "workflow-agent-c2b.8",
    mapId: "E04",
    sourcePrdSha256: hash(source),
    authorityDocuments: authorityDocuments(),
    dependencies,
    dependencyBaselines,
    documents: {
      source: { path: "../PRD.md", mediaType: "text/markdown", sha256: hash(source) },
      markdown: { path: "approved-prd.md", mediaType: "text/markdown", sha256: hash(markdown) },
      html: { path: "approved-prd.html", mediaType: "text/html", sha256: hash(rendered) },
      structured: { path: "document.json", mediaType: "application/json", sha256: hash(document) },
    },
    renderer,
    generator: { path: "../generate-bundle.mjs", id: "pi-workflow-e04-bootstrap-bundle-generator", sha256: hash(read(generatorPath)), checkCommand: "node docs/v2/epics/E04/generate-bundle.mjs --check" },
    governance: { exactManifestConfirmationRequired: true, beadsWriteReadbackRequired: true, approvalDoesNotAuthorizeMigrationOfUserDatabase: true },
  });
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(out.markdown, markdown);
  writeFileSync(out.html, rendered);
  writeFileSync(out.structured, document);
  writeFileSync(out.manifest, manifest);
  writeFileSync(out.manifestSha256, hash(manifest) + "\n");
  return hash(manifest);
}

function check() {
  for (const path of Object.values(out)) if (!existsSync(path)) throw new Error(`missing generated output: ${path}`);
  const before = read(out.manifestSha256).trim();
  const after = generate();
  if (before !== after || read(out.manifestSha256).trim() !== after) throw new Error("E04 bundle is not deterministic");
  return after;
}

const isCheck = process.argv.includes("--check");
console.log(`${isCheck ? "E04 bundle check passed" : "E04 bundle generated"}: ${isCheck ? check() : generate()}`);
