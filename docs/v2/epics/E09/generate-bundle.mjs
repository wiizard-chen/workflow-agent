#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const epicDir = dirname(fileURLToPath(import.meta.url));
const bundleDir = resolve(epicDir, "bundle");
const sourcePath = resolve(epicDir, "PRD.md");
const v2Dir = resolve(epicDir, "../..");
const outputs = Object.freeze({
  html: resolve(bundleDir, "approved-prd.html"),
  markdown: resolve(bundleDir, "approved-prd.md"),
  structured: resolve(bundleDir, "document.json"),
  manifest: resolve(bundleDir, "manifest.json"),
  digest: resolve(bundleDir, "manifest.sha256"),
});
const renderer = Object.freeze({ id: "pi-workflow-e09-worker-safe-preformatted-html", mode: "escaped-markdown-pre", version: 1 });
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
  return Object.fromEntries(sections.sort(([a], [b]) => a.localeCompare(b)).map(([name, text]) => [name, hash(text)]));
}

function authorityDocuments() {
  return Object.fromEntries(["ARCHITECTURE_RFC.md", "INITIAL_EPIC_MAP.md", "INITIATIVE_CHARTER.md", "THIRD_PARTY_REUSE_SURVEY.md"].map((name) => {
    const content = read(resolve(v2Dir, name));
    return [name, { path: `../../../${name}`, sha256: hash(content), sectionHashes: sectionHashes(content) }];
  }));
}

function dependencies() {
  const map = read(resolve(v2Dir, "INITIAL_EPIC_MAP.md"));
  const heading = /^##\s+E09\b/m.exec(map);
  if (!heading) throw new Error("missing_E09_map_entry");
  const rest = map.slice(heading.index);
  const next = /^##\s+/m.exec(rest.slice(heading[0].length));
  const block = next ? rest.slice(0, heading[0].length + next.index) : rest;
  const line = /^- \*\*Dependencies:\*\*\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!line) throw new Error("missing_E09_dependencies");
  const result = line.split(",").map((value) => value.trim().replace(/\.$/, ""));
  if (result.join(",") !== "E06,E08") throw new Error(`unexpected_E09_dependencies:${result.join(",")}`);
  return Object.freeze(result);
}

function renderHtml(markdown, markdownHash) {
  const escaped = markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="robots" content="noindex,nofollow">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-ancestors &#39;none&#39;; style-src &#39;unsafe-inline&#39;">',
    "<title>E09 PRD — local worker host</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#14532d;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px}</style>",
    "</head><body><main>", `<header><strong>E09 PRD — pending exact manifest confirmation</strong><br>Bundle Markdown SHA-256: ${markdownHash}<br>Renderer: ${renderer.id}</header>`, `<pre>${escaped}</pre>`, "</main></body></html>", "",
  ].join("\n");
}

function generate() {
  const source = read(sourcePath);
  const sourcePrdSha256 = hash(source);
  const rendered = renderHtml(source, sourcePrdSha256);
  const deps = dependencies();
  const document = json({
    schemaVersion: 1,
    documentType: "bounded-epic-prd",
    metadata: {
      initiative: "workflow-agent-c2b", epic: "workflow-agent-voi", mapId: "E09",
      title: "Pi SDK Engineering Lead worker host", version: "draft-v1",
      productStatus: "draft-recommended-mvp", approvalStatus: "pending-exact-manifest-confirmation",
      engineeringEligibility: "ineligible-until-bundle-readback", deliveryUnits: 1, maximumTasks: 5,
      verificationProfile: "strict",
    },
    sourcePrdSha256,
    sectionHashes: sectionHashes(source),
    dependencies: deps,
    scope: {
      package: "@pi-workflow/workflow-worker",
      implementationArea: "apps/workflow-worker/src",
      included: ["typed worker lifecycle", "Pi SDK SessionManager adapter", "strict ResourceLoader", "diagnostic-only prompt", "injected lease/heartbeat port", "generation persistence", "resume/handoff", "signal-aware process runner"],
      excluded: ["workflowd import", "daemon IPC", "Dev/Reviewer", "repository mutation", "shell/Git/GitHub/Beads", "sandbox", "scheduler", "network/provider discovery"],
    },
    verification: {
      profile: "strict",
      commands: ["npm --workspace=@pi-workflow/workflow-worker run test", "npm --workspace=@pi-workflow/workflow-worker run typecheck", "npm --workspace=@pi-workflow/workflowd run test", "npm test", "npm run typecheck", "npm run validate:v2-boundaries", "node docs/v2/epics/E09/generate-bundle.mjs --check", "git diff --check"],
    },
    authorityDocuments: authorityDocuments(),
    rendered: { htmlSha256: hash(rendered), renderer },
  });
  const files = Object.freeze({ "approved-prd.md": source, "approved-prd.html": rendered, "document.json": document });
  const fileHashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)]));
  const manifest = json({ schemaVersion: 1, bundleType: "approved-document-bundle", generatedBy: "docs/v2/epics/E09/generate-bundle.mjs", files: fileHashes, documentSha256: hash(document), sourcePrdSha256 });
  return Object.freeze({ files, manifest, manifestSha256: hash(manifest) });
}

const result = generate();
if (process.argv.includes("--check")) {
  if (!existsSync(outputs.manifest) || read(outputs.manifest) !== result.manifest || read(outputs.digest).trim() !== result.manifestSha256) throw new Error("E09_bundle_not_deterministic");
  for (const [name, content] of Object.entries(result.files)) if (read(resolve(bundleDir, name)) !== content) throw new Error(`E09_bundle_file_mismatch:${name}`);
  console.log(`E09 bundle check passed: ${result.manifestSha256}`);
} else {
  mkdirSync(bundleDir, { recursive: true });
  for (const [name, content] of Object.entries(result.files)) writeFileSync(resolve(bundleDir, name), content, "utf8");
  writeFileSync(outputs.manifest, result.manifest, "utf8");
  writeFileSync(outputs.digest, `${result.manifestSha256}\n`, "utf8");
  console.log(`E09 bundle generated: ${result.manifestSha256}`);
}
