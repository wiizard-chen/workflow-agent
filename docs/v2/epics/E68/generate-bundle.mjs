#!/usr/bin/env node

/**
 * Deterministic E68 qualification-PRD document bundle generator.
 *
 * This generator creates documentation evidence only. It does not run a
 * provider, select a backend, or authorize an implementation.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(import.meta.url);
const epicDir = dirname(generatorPath);
const bundleDir = resolve(epicDir, "bundle");
const sourcePrdPath = resolve(epicDir, "PRD.md");
const v2Dir = resolve(epicDir, "../..");
const repositoryRoot = resolve(epicDir, "../../../..");

const outputPaths = Object.freeze({
  html: resolve(bundleDir, "approved-prd.html"),
  markdown: resolve(bundleDir, "approved-prd.md"),
  structured: resolve(bundleDir, "document.json"),
  manifest: resolve(bundleDir, "manifest.json"),
  manifestSha256: resolve(bundleDir, "manifest.sha256"),
});

const renderer = Object.freeze({
  id: "pi-workflow-e68-bootstrap-safe-preformatted-html",
  mode: "escaped-markdown-pre",
  version: 1,
});

const read = (path) => readFileSync(path, "utf8");
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

function slug(title) {
  return title.replaceAll("`", "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sectionHashes(markdown) {
  const headings = [...markdown.matchAll(/^#{1,6}[ \t]+(.+)$/gm)];
  const sections = headings.map((heading, index) => {
    const start = heading.index;
    const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    return [slug(heading[1]), markdown.slice(start, end)];
  });
  const names = new Set(sections.map(([name]) => name));
  if (names.size !== sections.length) throw new Error("duplicate PRD heading slug");
  return Object.fromEntries(sections.map(([name, section]) => [name, sha256(section)])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(markdown, markdownSha256) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-ancestors &#39;none&#39;; style-src &#39;unsafe-inline&#39;">',
    "<title>E68 qualification PRD — pending human confirmation</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#374151;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px;box-shadow:0 1px 3px #0001}</style>",
    "</head>",
    "<body><main>",
    "<header><strong>E68 PRD CANDIDATE — PENDING HUMAN CONFIRMATION</strong><br>This bundle authorizes no provider adoption or external effect.<br>Bundle Markdown SHA-256: " + markdownSha256 + "<br>Renderer: " + renderer.id + "</header>",
    "<pre>" + escapeHtml(markdown) + "</pre>",
    "</main></body>",
    "</html>",
    "",
  ].join("\n");
}

function authorityChain() {
  const names = ["ARCHITECTURE_RFC.md", "INITIAL_EPIC_MAP.md", "INITIATIVE_CHARTER.md", "THIRD_PARTY_REUSE_SURVEY.md"];
  return Object.fromEntries(names.map((name) => {
    const content = read(resolve(v2Dir, name));
    return [name, {
      path: `../../../${name}`,
      sha256: sha256(content),
      sectionHashes: sectionHashes(content),
    }];
  }));
}

function mapDependencies() {
  const map = read(resolve(v2Dir, "INITIAL_EPIC_MAP.md"));
  const heading = map.indexOf("## E68 —");
  if (heading < 0) throw new Error("E68 heading missing from Initial Epic Map");
  const nextHeading = map.indexOf("## E69 —", heading + 1);
  const section = map.slice(heading, nextHeading < 0 ? map.length : nextHeading);
  const line = section.match(/^- \*\*Dependencies:\*\* (.+)$/m)?.[1];
  if (!line) throw new Error("E68 dependency field missing from Initial Epic Map");
  const dependencies = line === "none"
    ? []
    : line.split(/,\s*/).map((item) => item.trim().replace(/[.;]+$/, "")).filter(Boolean);
  if (dependencies.length !== 1 || dependencies[0] !== "E01") {
    throw new Error(`unexpected E68 dependencies: ${dependencies.join(",")}`);
  }
  return dependencies;
}

function buildDocument(source) {
  return {
    schemaVersion: 1,
    documentType: "bounded-qualification-epic-prd",
    metadata: {
      initiative: "workflow-agent-c2b",
      epic: "workflow-agent-c2b.9",
      mapId: "E68",
      title: "Native SQLite versus durable backend qualification",
      version: "draft-v1",
      productStatus: "draft",
      approvalStatus: "pending-human-confirmation",
      engineeringEligibility: "pending-exact-manifest-confirmation",
      deliveryUnits: 1,
      verificationProfile: "strict",
    },
    sourcePrdSha256: sha256(source),
    sectionHashes: sectionHashes(source),
    dependencies: mapDependencies(),
    scope: {
      baseline: "native SQLite WAL plus V2 Step Ledger",
      candidates: ["temporal", "restate", "dbos-transact-ts", "hatchet"],
      dispositionSet: ["QUALIFIED", "ADAPT", "REFERENCE", "REJECTED", "BLOCKED"],
      productionCodeChanges: false,
    },
    verification: {
      profile: "strict",
      commands: [
        "node docs/v2/epics/E68/generate-bundle.mjs --check",
        "npm run typecheck:v2",
        "node scripts/validate-v2-boundaries.mjs",
        "git diff --check",
      ],
    },
  };
}

function buildManifest(source, markdown, html, document) {
  const dependencyManifest = read(resolve(repositoryRoot, "docs/v2/epics/E01/bundle/manifest.sha256")).trim().split(/\s+/)[0];
  return {
    schemaVersion: 1,
    status: "candidate",
    approvalStatus: "pending-human-confirmation",
    documentBundleId: "workflow-agent-c2b-e68-draft-v1-candidate",
    initiativeId: "workflow-agent-c2b",
    epicId: "workflow-agent-c2b.9",
    mapId: "E68",
    sourcePrdSha256: sha256(source),
    authorityDocuments: authorityChain(),
    dependencies: mapDependencies(),
    dependencyBaselines: {
      E01: { requiredManifestSha256: dependencyManifest },
    },
    documents: {
      source: { path: "../PRD.md", mediaType: "text/markdown", sha256: sha256(source) },
      markdown: { path: "approved-prd.md", mediaType: "text/markdown", sha256: sha256(markdown) },
      html: { path: "approved-prd.html", mediaType: "text/html", sha256: sha256(html) },
      structured: { path: "document.json", mediaType: "application/json", sha256: sha256(document) },
    },
    renderer,
    generator: {
      path: "../generate-bundle.mjs",
      id: "pi-workflow-e68-bootstrap-bundle-generator",
      sha256: sha256(read(generatorPath)),
      checkCommand: "node docs/v2/epics/E68/generate-bundle.mjs --check",
    },
    candidateCatalog: [
      { id: "native-sqlite-step-ledger", disposition: "baseline" },
      { id: "temporal", disposition: "qualification-candidate" },
      { id: "restate", disposition: "qualification-candidate" },
      { id: "dbos-transact-ts", disposition: "qualification-candidate" },
      { id: "hatchet", disposition: "qualification-candidate" },
    ],
    governance: {
      exactManifestConfirmationRequired: true,
      beadsWriteReadbackRequired: true,
      researchDoesNotAuthorizeBackendAdoption: true,
      separateAdrRequiredForImplementation: true,
    },
  };
}

function generate() {
  const source = read(sourcePrdPath);
  const markdown = source;
  const html = renderHtml(markdown, sha256(markdown));
  const document = json(buildDocument(source));
  const manifest = json(buildManifest(source, markdown, html, document));
  const hash = sha256(manifest);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(outputPaths.markdown, markdown);
  writeFileSync(outputPaths.html, html);
  writeFileSync(outputPaths.structured, document);
  writeFileSync(outputPaths.manifest, manifest);
  writeFileSync(outputPaths.manifestSha256, hash + "\n");
  return hash;
}

function check() {
  for (const path of Object.values(outputPaths)) if (!existsSync(path)) throw new Error(`missing generated output: ${path}`);
  const before = read(outputPaths.manifestSha256).trim();
  const after = generate();
  if (before !== after || read(outputPaths.manifestSha256).trim() !== after) throw new Error("E68 bundle is not deterministic");
  return after;
}

const isCheck = process.argv.includes("--check");
const hash = isCheck ? check() : generate();
console.log(`${isCheck ? "E68 bundle check passed" : "E68 bundle generated"}: ${hash}`);
