#!/usr/bin/env node

/**
 * Deterministic E03 PRD review-bundle generator.
 *
 * This is bootstrap documentation tooling only. It does not approve a PRD,
 * issue grants, dispatch protocol messages, or establish engineering authority.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  id: "pi-workflow-e03-bootstrap-safe-preformatted-html",
  mode: "escaped-markdown-pre",
  version: 1,
});

function readUtf8(path) {
  return readFileSync(path, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function slug(title) {
  return title
    .replaceAll("`", "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sectionHashes(markdown) {
  const headings = [...markdown.matchAll(/^#{1,6}[ \t]+(.+)$/gm)];
  const sections = [];
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index;
    const end = index + 1 < headings.length
      ? headings[index + 1].index
      : markdown.length;
    sections.push([slug(headings[index][1]), markdown.slice(start, end)]);
  }
  const unique = new Set(sections.map(([name]) => name));
  if (unique.size !== sections.length) throw new Error("duplicate PRD heading slug");
  return Object.fromEntries(
    sections
      .map(([name, section]) => [name, sha256(section)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
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
    "<title>E03 PRD — pending human confirmation</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#1e3a8a;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px;box-shadow:0 1px 3px #0001}</style>",
    "</head>",
    "<body><main>",
    "<header><strong>E03 PRD CANDIDATE — PENDING HUMAN CONFIRMATION</strong><br>The approved-prd filename carries no approval authority.<br>Bundle Markdown SHA-256: " + markdownSha256 + "<br>Renderer: " + renderer.id + "</header>",
    "<pre>" + escapeHtml(markdown) + "</pre>",
    "</main></body>",
    "</html>",
    "",
  ].join("\n");
}

function authorityChain() {
  const names = [
    "ARCHITECTURE_RFC.md",
    "INITIAL_EPIC_MAP.md",
    "INITIATIVE_CHARTER.md",
    "THIRD_PARTY_REUSE_SURVEY.md",
  ];
  return Object.fromEntries(names.map((name) => {
    const content = readUtf8(resolve(v2Dir, name));
    return [name, {
      path: `../../../${name}`,
      sha256: sha256(content),
      sectionHashes: sectionHashes(content),
    }];
  }));
}

function buildDocument(sourceMarkdown) {
  return {
    schemaVersion: 1,
    documentType: "bounded-epic-prd",
    metadata: {
      initiative: "workflow-agent-c2b",
      epic: "workflow-agent-c2b.7",
      mapId: "E03",
      title: "Versioned Command/Query/Event schemas",
      version: "draft-v1",
      productStatus: "approved-for-mvp-implementation",
      approvalStatus: "pending-human-confirmation",
      engineeringEligibility: "pending-exact-manifest-confirmation",
      deliveryUnits: 1,
      verificationProfile: "strict",
    },
    sourcePrdSha256: sha256(sourceMarkdown),
    sectionHashes: sectionHashes(sourceMarkdown),
    scope: {
      package: "@pi-workflow/v2-protocol",
      included: [
        "generic command/query/event envelopes",
        "exact protocol and schema tuple validation",
        "immutable runtime schema registry and canonical manifest hash",
        "server-derived principal context and verified grant binding",
        "synthetic E11 catalog",
      ],
      excluded: [
        "transport and daemon",
        "authentication and grant issuance/consumption",
        "persistence, handlers, workers, Beads, GitHub, and Dashboard",
        "E70-E83 domain-family authority",
      ],
    },
    verification: {
      profile: "strict",
      commands: [
        "npm --workspace=@pi-workflow/v2-protocol run test",
        "npm run typecheck:v2",
        "npm run test:v2",
        "node scripts/validate-v2-boundaries.mjs",
        "git diff --check",
      ],
    },
  };
}

function buildManifest(sourceMarkdown, approvedMarkdown, approvedHtml, documentJson) {
  return {
    schemaVersion: 1,
    status: "candidate",
    approvalStatus: "pending-human-confirmation",
    documentBundleId: "workflow-agent-c2b-e03-draft-v1-candidate",
    initiativeId: "workflow-agent-c2b",
    epicId: "workflow-agent-c2b.7",
    mapId: "E03",
    sourcePrdSha256: sha256(sourceMarkdown),
    authorityDocuments: authorityChain(),
    documents: {
      source: { path: "../PRD.md", mediaType: "text/markdown", sha256: sha256(sourceMarkdown) },
      markdown: { path: "approved-prd.md", mediaType: "text/markdown", sha256: sha256(approvedMarkdown) },
      html: { path: "approved-prd.html", mediaType: "text/html", sha256: sha256(approvedHtml) },
      structured: { path: "document.json", mediaType: "application/json", sha256: sha256(documentJson) },
    },
    renderer,
    generator: {
      path: "../generate-bundle.mjs",
      id: "pi-workflow-e03-bootstrap-bundle-generator",
      sha256: sha256(readUtf8(generatorPath)),
      checkCommand: "node docs/v2/epics/E03/generate-bundle.mjs --check",
    },
    dependencyBaselines: {
      E02: {
        requiredManifestSha256: "95a111697d11d867c9a28368b9d8edf4bcc6dd4da716f9a93347264cec3096c8",
        finalCandidateCommit: "536d98693506fc30ea2388d61e135e8c81262813",
      },
    },
    publicContract: {
      package: "@pi-workflow/v2-protocol",
      packageEntrypoint: ".",
      noDeepImports: true,
      manifestHashBindsExactSchemaCatalog: true,
    },
    governance: {
      exactManifestConfirmationRequired: true,
      beadsWriteReadbackRequired: true,
      approvalDoesNotAuthorizeTransportOrExternalEffects: true,
    },
  };
}

function writeOutputs() {
  const sourceMarkdown = readUtf8(sourcePrdPath);
  const approvedMarkdown = sourceMarkdown;
  const approvedHtml = renderHtml(approvedMarkdown, sha256(approvedMarkdown));
  const documentJson = json(buildDocument(sourceMarkdown));
  const manifestJson = json(buildManifest(sourceMarkdown, approvedMarkdown, approvedHtml, documentJson));
  const manifestHash = sha256(manifestJson);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(outputPaths.markdown, approvedMarkdown);
  writeFileSync(outputPaths.html, approvedHtml);
  writeFileSync(outputPaths.structured, documentJson);
  writeFileSync(outputPaths.manifest, manifestJson);
  writeFileSync(outputPaths.manifestSha256, manifestHash + "\n");
  return manifestHash;
}

function checkOutputs() {
  for (const path of Object.values(outputPaths)) {
    if (!existsSync(path)) throw new Error("missing generated output: " + path);
  }
  const before = readUtf8(outputPaths.manifestSha256).trim();
  const after = writeOutputs();
  const actual = readUtf8(outputPaths.manifestSha256).trim();
  if (before !== after || actual !== after) {
    throw new Error("generated bundle is not deterministic");
  }
  return after;
}

const check = process.argv.includes("--check");
const hash = check ? checkOutputs() : writeOutputs();
console.log(`${check ? "E03 bundle check passed" : "E03 bundle generated"}: ${hash}`);
