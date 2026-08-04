#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(import.meta.url);
const epicDir = dirname(generatorPath);
const bundleDir = resolve(epicDir, "bundle");
const sourcePath = resolve(epicDir, "PRD.md");
const v2Dir = resolve(epicDir, "../..");
const output = Object.freeze({
  html: resolve(bundleDir, "approved-prd.html"),
  markdown: resolve(bundleDir, "approved-prd.md"),
  structured: resolve(bundleDir, "document.json"),
  manifest: resolve(bundleDir, "manifest.json"),
  digest: resolve(bundleDir, "manifest.sha256"),
});
const renderer = Object.freeze({ id: "pi-workflow-e08-lease-fencing-safe-preformatted-html", mode: "escaped-markdown-pre", version: 1 });
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const read = (path) => readFileSync(path, "utf8");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

function slug(title) {
  return title.replaceAll("`", "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sectionHashes(markdown) {
  const heads = [...markdown.matchAll(/^#{1,6}[ \t]+(.+)$/gm)];
  const sections = heads.map((head, index) => {
    const end = index + 1 < heads.length ? heads[index + 1].index : markdown.length;
    return [slug(head[1]), markdown.slice(head.index, end)];
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
  const heading = /^##\s+E08\b/m.exec(map);
  if (!heading) throw new Error("missing_E08_map_entry");
  const rest = map.slice(heading.index);
  const next = /^##\s+/m.exec(rest.slice(heading[0].length));
  const block = next ? rest.slice(0, heading[0].length + next.index) : rest;
  const line = /^- \*\*Dependencies:\*\*\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!line) throw new Error("missing_E08_dependencies");
  const result = line.split(",").map((value) => value.trim().replace(/\.$/, ""));
  if (result.join(",") !== "E04,E05") throw new Error(`unexpected_E08_dependencies:${result.join(",")}`);
  return Object.freeze(result);
}

function html(markdown, markdownHash) {
  const escaped = markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="robots" content="noindex,nofollow">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-ancestors &#39;none&#39;; style-src &#39;unsafe-inline&#39;">',
    "<title>E08 PRD — local lease candidate</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#1e3a8a;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px}</style>",
    "</head><body><main>",
    `<header><strong>E08 PRD — pending exact manifest confirmation</strong><br>Bundle Markdown SHA-256: ${markdownHash}<br>Renderer: ${renderer.id}</header>`,
    `<pre>${escaped}</pre>`, "</main></body></html>", "",
  ].join("\n");
}

function generate() {
  const source = read(sourcePath);
  const markdownSha256 = hash(source);
  const rendered = html(source, markdownSha256);
  const deps = dependencies();
  const document = json({
    schemaVersion: 1,
    documentType: "bounded-epic-prd",
    metadata: {
      initiative: "workflow-agent-c2b", epic: "workflow-agent-c2b.13", mapId: "E08",
      title: "Lease, heartbeat, and fencing core", version: "draft-v1",
      productStatus: "draft-recommended-mvp", approvalStatus: "pending-exact-manifest-confirmation",
      engineeringEligibility: "ineligible-until-bundle-readback", deliveryUnits: 1, maximumTasks: 5,
      verificationProfile: "strict",
    },
    sourcePrdSha256: markdownSha256,
    sectionHashes: sectionHashes(source),
    dependencies: deps,
    scope: {
      package: "@pi-workflow/workflowd",
      implementationArea: "apps/workflowd/src/leases",
      included: ["durable lease table", "monotonic fencing token", "acquire/renew/heartbeat/revoke", "stale-command guard", "bounded heartbeat controller", "restart/read-only/fault behavior"],
      excluded: ["scheduler policy", "worker launch", "business authority", "distributed consensus", "external effects"],
    },
    verification: {
      profile: "strict",
      commands: ["npm --workspace=@pi-workflow/workflowd run test", "npm test", "npm run typecheck", "npm run validate:v2-boundaries", "node docs/v2/epics/E08/generate-bundle.mjs --check", "git diff --check"],
    },
    authorityDocuments: authorityDocuments(),
    rendered: { htmlSha256: hash(rendered), renderer },
  });
  const files = Object.freeze({
    "approved-prd.md": source,
    "approved-prd.html": rendered,
    "document.json": document,
  });
  const fileHashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)]));
  const manifest = json({
    schemaVersion: 1,
    bundleType: "approved-document-bundle",
    generatedBy: "docs/v2/epics/E08/generate-bundle.mjs",
    files: fileHashes,
    documentSha256: hash(document),
    sourcePrdSha256: markdownSha256,
  });
  const manifestSha256 = hash(manifest);
  return Object.freeze({ files, manifest, manifestSha256 });
}

const check = process.argv.includes("--check");
const result = generate();
if (check) {
  if (!existsSync(output.manifest) || read(output.manifest) !== result.manifest || read(output.digest).trim() !== result.manifestSha256) {
    throw new Error("E08_bundle_not_deterministic");
  }
  for (const [name, content] of Object.entries(result.files)) if (read(resolve(bundleDir, name)) !== content) throw new Error(`E08_bundle_file_mismatch:${name}`);
  console.log(`E08 bundle check passed: ${result.manifestSha256}`);
} else {
  mkdirSync(bundleDir, { recursive: true });
  for (const [name, content] of Object.entries(result.files)) writeFileSync(resolve(bundleDir, name), content, "utf8");
  writeFileSync(output.manifest, result.manifest, "utf8");
  writeFileSync(output.digest, `${result.manifestSha256}\n`, "utf8");
  console.log(`E08 bundle generated: ${result.manifestSha256}`);
}
