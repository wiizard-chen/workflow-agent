#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(import.meta.url);
const epicDir = dirname(generatorPath);
const bundleDir = resolve(epicDir, "bundle");
const sourcePath = resolve(epicDir, "PRD.md");
const schemaPath = resolve(epicDir, "schema-extension.json");
const v2Dir = resolve(epicDir, "../..");
const output = Object.freeze({
  html: resolve(bundleDir, "approved-prd.html"),
  markdown: resolve(bundleDir, "approved-prd.md"),
  structured: resolve(bundleDir, "document.json"),
  manifest: resolve(bundleDir, "manifest.json"),
  digest: resolve(bundleDir, "manifest.sha256"),
});
const renderer = Object.freeze({ id: "pi-workflow-e05-journal-safe-preformatted-html", mode: "escaped-markdown-pre", version: 1 });
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
  const heading = /^##\s+E05\b/m.exec(map);
  if (!heading) throw new Error("missing_E05_map_entry");
  const rest = map.slice(heading.index);
  const block = rest.slice(0, /^##\s+/m.exec(rest.slice(heading[0].length))?.index ?? rest.length);
  const line = /^- \*\*Dependencies:\*\*\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (!line) throw new Error("missing_E05_dependencies");
  const result = line.split(",").map((value) => value.trim().replace(/\.$/, ""));
  if (result.join(",") !== "E03,E04") throw new Error(`unexpected_E05_dependencies:${result.join(",")}`);
  return Object.freeze(result);
}

function html(markdown, markdownHash) {
  const escaped = markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="robots" content="noindex,nofollow">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-ancestors &#39;none&#39;; style-src &#39;unsafe-inline&#39;">',
    "<title>E05 PRD — local MVP bundle</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#14532d;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px}</style>",
    "</head><body><main>",
    `<header><strong>E05 PRD — local MVP</strong><br>Bundle Markdown SHA-256: ${markdownHash}<br>Renderer: ${renderer.id}</header>`,
    `<pre>${escaped}</pre>`, "</main></body></html>", "",
  ].join("\n");
}

function generate() {
  const source = read(sourcePath);
  const schemaText = read(schemaPath);
  const schema = JSON.parse(schemaText);
  const canonicalSchema = JSON.stringify(schema);
  const schemaManifestSha256 = hash(canonicalSchema);
  const schemaDigest = hash(JSON.stringify({ schemaVersion: schema.schemaVersion, tables: schema.tables, triggers: schema.triggers }));
  const markdown = source;
  const markdownSha256 = hash(markdown);
  const rendered = html(markdown, markdownSha256);
  const deps = dependencies();
  const document = json({
    schemaVersion: 1,
    documentType: "bounded-epic-prd",
    metadata: {
      initiative: "workflow-agent-c2b", epic: "workflow-agent-c2b.10", mapId: "E05",
      title: "Command journal, event log, and durable outbox", version: "draft-v1",
      productStatus: "draft-recommended-mvp", approvalStatus: "pending-exact-manifest-confirmation",
      engineeringEligibility: "ineligible-until-bundle-readback", deliveryUnits: 1, maximumTasks: 5,
      verificationProfile: "strict",
    },
    sourcePrdSha256: markdownSha256,
    sectionHashes: sectionHashes(source),
    dependencies: deps,
    scope: {
      package: "@pi-workflow/workflowd",
      implementationArea: "apps/workflowd/src/persistence",
      included: ["command journal", "aggregate revision heads", "append-only events", "opaque projections", "durable outbox lease/ack/retry"],
      excluded: ["transport", "external dispatch", "Domain lifecycle authority", "Beads/Git/GitHub", "general leases and workers"],
    },
      verification: {
      profile: "strict",
      commands: [
        "npm --workspace=@pi-workflow/workflowd run test",
        "npm run test:v1",
        "npm run typecheck",
        "npm run validate:v2-boundaries",
        "node docs/v2/epics/E05/generate-bundle.mjs --check",
        "git diff --check",
      ],
      },
    schemaExtension: { source: "../schema-extension.json", sha256: hash(schemaText), migrationManifestSha256: schemaManifestSha256, schemaDigest },
  });
  const manifest = json({
    schemaVersion: 1,
    status: "candidate",
    approvalStatus: "pending-human-confirmation",
    documentBundleId: "workflow-agent-c2b-e05-draft-v1-candidate",
    initiativeId: "workflow-agent-c2b", epicId: "workflow-agent-c2b.10", mapId: "E05",
    sourcePrdSha256: markdownSha256,
    authorityDocuments: authorityDocuments(),
    dependencies: deps,
    dependencyBaselines: {
      E03: { requiredManifestSha256: "cf9f088c5257e829165e2fa499bd1c4c5b77e46e301569b930822a66dfd8e1af" },
      E04: { requiredManifestSha256: "5acebe61d591882c9ae14954f95a8c8ad2becfd9621d2c6bf23f9a1b8547c280" },
    },
    documents: {
      source: { path: "../PRD.md", mediaType: "text/markdown", sha256: markdownSha256 },
      markdown: { path: "approved-prd.md", mediaType: "text/markdown", sha256: hash(markdown) },
      html: { path: "approved-prd.html", mediaType: "text/html", sha256: hash(rendered) },
      structured: { path: "document.json", mediaType: "application/json", sha256: hash(document) },
      schemaExtension: { path: "../schema-extension.json", mediaType: "application/json", sha256: hash(schemaText) },
    },
    publicContract: { package: "@pi-workflow/workflowd", packageEntrypoint: ".", noDeepImports: true, noNativeHandle: true, noArbitrarySql: true },
    schemaExtension: {
      id: "e05-command-journal-v1",
      migrationVersion: 2,
      migrationManifestSha256: schemaManifestSha256,
      schemaDigest,
      migrationId: schema.migrationId,
      tables: schema.tables.map(({ name, columns, indexes }) => ({ name, columns, indexes })),
      triggers: schema.triggers,
      transportNeutral: true,
      atLeastOnceOnly: true,
    },
    renderer,
    generator: { path: "../generate-bundle.mjs", id: "pi-workflow-e05-journal-bundle-generator", sha256: hash(read(generatorPath)), checkCommand: "node docs/v2/epics/E05/generate-bundle.mjs --check" },
    governance: { exactManifestConfirmationRequired: true, beadsWriteReadbackRequired: true, approvalDoesNotAuthorizeExternalEffects: true, approvalDoesNotAuthorizeMigrationOfUserDatabase: true },
  });
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(output.markdown, markdown); writeFileSync(output.html, rendered); writeFileSync(output.structured, document); writeFileSync(output.manifest, manifest); writeFileSync(output.digest, hash(manifest) + "\n");
  return hash(manifest);
}

function check() {
  for (const path of Object.values(output)) if (!existsSync(path)) throw new Error(`missing_generated_output:${path}`);
  const before = read(output.digest).trim();
  const after = generate();
  if (before !== after || read(output.digest).trim() !== after) throw new Error("E05_bundle_not_deterministic");
  return after;
}

const isCheck = process.argv.includes("--check");
console.log(`${isCheck ? "E05 bundle check passed" : "E05 bundle generated"}: ${isCheck ? check() : generate()}`);
