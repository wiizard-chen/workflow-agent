#!/usr/bin/env node

/**
 * Deterministic bootstrap generator for the E70 PRD review candidate.
 *
 * This is documentation tooling only. It is not E70 implementation, a generic
 * Document Bundle runtime, an approval mechanism, or engineering eligibility.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(import.meta.url);
const epicDir = dirname(generatorPath);
const bundleDir = resolve(epicDir, "bundle");
const sourcePrdPath = resolve(epicDir, "PRD.md");
const v2Dir = resolve(epicDir, "../..");
const repositoryRoot = resolve(epicDir, "../../../..");
const e02PrdPath = resolve(epicDir, "../E02/PRD.md");
const e02ManifestPath = resolve(epicDir, "../E02/bundle/manifest.json");
const e02SourcePath = resolve(repositoryRoot, "packages/v2-domain/src/index.ts");

const E02_FINAL_CANDIDATE_COMMIT =
  "536d98693506fc30ea2388d61e135e8c81262813";
const E02_APPROVED_MANIFEST_SHA256 =
  "95a111697d11d867c9a28368b9d8edf4bcc6dd4da716f9a93347264cec3096c8";
const E02_PRD_SHA256 =
  "b61d2642e66183a8eb772d9986fffbf4f56fe7932b1a016c279fe2845c136b58";
const E02_SOURCE_SHA256 =
  "04bcc42725ed99305cd8b50ee9404182edb13e173d8792e1f278d04371179e95";
const HISTORICAL_V1_APPROVED_MANIFEST_SHA256 =
  "d0e5cd1a3754d168b144ed696a79dba3aee9c4698372fbda77a6293721c4ead3";
const HISTORICAL_V1_APPROVED_SOURCE_PRD_SHA256 =
  "a71cfc195c8f8f3df94a7393e20aec57bd324e8b89ae88ba059cfdaa8637e0f2";
const HISTORICAL_V1_BUNDLE_MARKDOWN_SHA256 =
  "5820f9f784a6345b454f48bcc281328562e6efc2059996cbb8b85dd613d64bb9";

const renderer = Object.freeze({
  id: "pi-workflow-e70-bootstrap-safe-preformatted-html-v2",
  mode: "escaped-markdown-pre",
  version: 2,
});

const linkRewrites = [
  [
    "../../INITIATIVE_CHARTER.md#7-3-three-layer-readiness-gate",
    "../../../INITIATIVE_CHARTER.md#7-3-three-layer-readiness-gate",
  ],
  [
    "../../ARCHITECTURE_RFC.md#11-4-readiness-handoff-and-no-cycle-approval",
    "../../../ARCHITECTURE_RFC.md#11-4-readiness-handoff-and-no-cycle-approval",
  ],
  [
    "../../INITIAL_EPIC_MAP.md#e70-readiness-and-governance-evidence",
    "../../../INITIAL_EPIC_MAP.md#e70-readiness-and-governance-evidence",
  ],
  [
    "../../THIRD_PARTY_REUSE_SURVEY.md#1-decision-posture",
    "../../../THIRD_PARTY_REUSE_SURVEY.md#1-decision-posture",
  ],
  [
    "../E02/PRD.md#2-bounded-result",
    "../../E02/PRD.md#2-bounded-result",
  ],
];

const outputPaths = {
  html: resolve(bundleDir, "approved-prd.html"),
  markdown: resolve(bundleDir, "approved-prd.md"),
  structured: resolve(bundleDir, "document.json"),
  manifest: resolve(bundleDir, "manifest.json"),
  manifestSha256: resolve(bundleDir, "manifest.sha256"),
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readUtf8(path) {
  return readFileSync(path, "utf8");
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slugForHeading(title) {
  return title
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function markdownSections(markdown) {
  const headings = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+)$/gm)].map(
    (match) => ({ index: match.index, slug: slugForHeading(match[2]) }),
  );
  const sections = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (sections.has(heading.slug)) {
      throw new Error("Duplicate Markdown heading slug: " + heading.slug);
    }
    const end =
      index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    sections.set(heading.slug, markdown.slice(heading.index, end));
  }
  return sections;
}

function sectionHashes(markdown) {
  return Object.fromEntries(
    [...markdownSections(markdown)]
      .map(([slug, section]) => [slug, sha256(section)])
      .sort(([left], [right]) => compare(left, right)),
  );
}

function requiredSection(markdown, slug) {
  const section = markdownSections(markdown).get(slug);
  if (!section) {
    throw new Error("Missing required Markdown section: " + slug);
  }
  return section;
}

function relocateMarkdown(sourceMarkdown) {
  let relocated = sourceMarkdown;
  for (const [sourceTarget, bundleTarget] of linkRewrites) {
    const sourceLink = "](" + sourceTarget + ")";
    const count = relocated.split(sourceLink).length - 1;
    if (count !== 1) {
      throw new Error(
        "Expected exactly one E70 source link " +
          sourceTarget +
          "; found " +
          count,
      );
    }
    relocated = relocated.replace(sourceLink, "](" + bundleTarget + ")");
  }
  return relocated;
}

function acceptanceCriteria(markdown) {
  const section = requiredSection(
    markdown,
    "11-acceptance-criteria-continuous-reduced-set",
  );
  const criteria = [];
  for (const match of section.matchAll(
    /^- \*\*(AC-\d{3}) — (.+?)\.\*\* (.+)$/gm,
  )) {
    criteria.push({
      id: match[1],
      title: match[2],
      statement: match[3],
    });
  }
  if (criteria.length !== 12) {
    throw new Error(
      "Expected 12 E70 acceptance criteria; found " + criteria.length,
    );
  }
  return criteria;
}

function nonGoals(markdown) {
  const section = requiredSection(
    markdown,
    "10-explicit-non-goals-and-stop-boundary",
  );
  const values = [...section.matchAll(/^- (.+)$/gm)].map(
    (match) => match[1],
  );
  if (values.length !== 14) {
    throw new Error("Expected 14 E70 non-goals; found " + values.length);
  }
  return values;
}

function decisions(markdown) {
  const section = requiredSection(
    markdown,
    "1-authority-dependency-baseline-and-frozen-decisions",
  );
  const values = {};
  for (const line of section.split("\n")) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length === 2 && /^R\d{2}$/.test(cells[0])) {
      values[cells[0]] = cells[1];
    }
  }
  if (Object.keys(values).length !== 12) {
    throw new Error(
      "Expected 12 E70 frozen decisions; found " +
        Object.keys(values).length,
    );
  }
  return values;
}

function verificationCommands(markdown) {
  const section = requiredSection(
    markdown,
    "12-delivery-plan-allowed-change-surface-and-verification-contract",
  );
  const label = "The future implementation strict verification contract is:";
  const start = section.indexOf(label);
  const block = section.slice(start).match(/```text\n([\s\S]*?)\n```/);
  if (start < 0 || !block) {
    throw new Error("Missing E70 verification command block");
  }
  const commands = block[1].split("\n").filter(Boolean);
  if (commands.length !== 9) {
    throw new Error(
      "Expected 9 E70 verification commands; found " + commands.length,
    );
  }
  return commands;
}

function publicExports(markdown) {
  const section = requiredSection(
    markdown,
    "9-typed-rejection-and-public-export-contract",
  );
  const block = section.match(
    /The public `\.` entrypoint export allowlist is exact:\n\n```text\nTypes:\n([\s\S]*?)\n\nValues:\n([\s\S]*?)\n```/,
  );
  if (!block) {
    throw new Error("Missing E70 public export allowlist");
  }
  const types = block[1].split("\n").filter(Boolean);
  const values = block[2].split("\n").filter(Boolean);
  const expectedValues = [
    "createReadinessCandidateBinding",
    "createGovernanceEvidence",
    "assessReadiness",
    "projectReadinessFreshness",
    "qualifyReadinessForConsumption",
  ];
  if (
    types.length !== 39 ||
    new Set(types).size !== types.length ||
    JSON.stringify(values) !== JSON.stringify(expectedValues)
  ) {
    throw new Error(
      "Unexpected E70 public export allowlist: " +
        types.length +
        " types and " +
        values.length +
        " values",
    );
  }
  return { types, values };
}

function buildDocument(sourceMarkdown) {
  return {
    acceptanceCriteria: acceptanceCriteria(sourceMarkdown),
    documentType: "bounded-epic-prd",
    metadata: {
      approvalStatus: "not-approved",
      deliveryUnits: 1,
      engineeringEligibility: "ineligible",
      epic: "workflow-agent-c2b.6",
      initiative: "workflow-agent-c2b",
      mapId: "E70",
      maximumTasks: 5,
      status: "pending-human-confirmation",
      targetActiveEngineeringTime: "2h",
      title: "Readiness and governance evidence",
      verificationProfile: "strict",
      version: "draft-v2",
    },
    schemaVersion: 2,
    publicExports: publicExports(sourceMarkdown),
    scope: {
      included: [
        "exact candidate binding",
        "immutable governance evidence qualification",
        "immutable hash-linked ReadinessAssessment",
        "pure explicit-input freshness projection",
        "fail-closed downstream consumer qualification",
      ],
      nonGoals: nonGoals(sourceMarkdown),
    },
    sectionHashes: sectionHashes(sourceMarkdown),
    sourcePrdSha256: sha256(sourceMarkdown),
    traceability: { decisions: decisions(sourceMarkdown) },
    verification: {
      commands: verificationCommands(sourceMarkdown),
      profile: "strict",
    },
  };
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
    "<title>E70 PRD — pending human confirmation</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#7c2d12;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px;box-shadow:0 1px 3px #0001}</style>",
    "</head>",
    "<body><main>",
    "<header><strong>E70 PRD CANDIDATE — PENDING HUMAN CONFIRMATION</strong><br>The approved-prd filename confers no approval authority.<br>Bundle Markdown SHA-256: " +
      markdownSha256 +
      "<br>Renderer: " +
      renderer.id +
      "</header>",
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
  return Object.fromEntries(
    names.map((name) => {
      const content = readUtf8(resolve(v2Dir, name));
      return [
        name,
        {
          path: "../../../" + name,
          sha256: sha256(content),
          sectionHashes: sectionHashes(content),
        },
      ];
    }),
  );
}

function verifyE02Baseline() {
  const actual = {
    manifest: sha256(readUtf8(e02ManifestPath)),
    prd: sha256(readUtf8(e02PrdPath)),
    source: sha256(readUtf8(e02SourcePath)),
  };
  if (actual.manifest !== E02_APPROVED_MANIFEST_SHA256) {
    throw new Error("E02 approved Manifest baseline changed");
  }
  if (actual.prd !== E02_PRD_SHA256) {
    throw new Error("E02 PRD baseline changed");
  }
  if (actual.source !== E02_SOURCE_SHA256) {
    throw new Error("E02 delivered source baseline changed");
  }
  return actual;
}

function buildManifest({
  sourceMarkdown,
  bundleMarkdown,
  html,
  documentJson,
}) {
  const e02 = verifyE02Baseline();
  const commands = verificationCommands(sourceMarkdown);
  const exports = publicExports(sourceMarkdown);
  return {
    approvalStatus: "pending-human-confirmation",
    authorityDocuments: authorityChain(),
    candidate: {
      bundleConfirmationStatus: "pending-human-confirmation",
      bundleMarkdownSha256: sha256(bundleMarkdown),
      sourcePrdSha256: sha256(sourceMarkdown),
      status: "pending-human-confirmation",
      statusSemantics:
        "This deterministic candidate has no approval authority until a Human Governor confirms this exact Manifest hash and Beads write/readback succeeds.",
    },
    dependencyBaselines: {
      E02: {
        approvedManifest: {
          path: "../../E02/bundle/manifest.json",
          sha256: e02.manifest,
        },
        finalCandidateCommit: E02_FINAL_CANDIDATE_COMMIT,
        packageSource: {
          path: "../../../../../packages/v2-domain/src/index.ts",
          sha256: e02.source,
        },
        prd: {
          path: "../../E02/PRD.md",
          sha256: e02.prd,
        },
        requiredDisposition: "local-complete-committed-not-pushed",
      },
    },
    documentBundleId: "workflow-agent-c2b-e70-draft-v2-candidate",
    documents: {
      html: {
        authority: "candidate-pending-human-confirmation",
        mediaType: "text/html",
        path: "approved-prd.html",
        sha256: sha256(html),
      },
      markdown: {
        authority: "candidate-pending-human-confirmation",
        mediaType: "text/markdown",
        path: "approved-prd.md",
        sha256: sha256(bundleMarkdown),
      },
      source: {
        authority: "candidate-pending-human-confirmation",
        mediaType: "text/markdown",
        path: "../PRD.md",
        sha256: sha256(sourceMarkdown),
      },
      structured: {
        authority: "candidate-pending-human-confirmation",
        mediaType: "application/json",
        path: "document.json",
        sha256: sha256(documentJson),
      },
    },
    engineeringEligibility: "ineligible",
    epicId: "workflow-agent-c2b.6",
    generator: {
      checkCommand: "node docs/v2/epics/E70/generate-bundle.mjs --check",
      id: "pi-workflow-e70-bootstrap-bundle-generator-v2",
      mode: "frozen-source-with-bundle-relative-link-relocation",
      path: "../generate-bundle.mjs",
      scope:
        "E70 PRD candidate documentation only; not a readiness evaluator, production renderer, or approval mechanism.",
      sha256: sha256(readUtf8(generatorPath)),
      version: 2,
    },
    governance: {
      approvalDoesNotAuthorizeReadinessOrEngineering: true,
      beadsAuthority: true,
      requiresExactManifestConfirmation: true,
      requiresWriteReadback: true,
    },
    initiativeId: "workflow-agent-c2b",
    historicalApproval: {
      approvedAt: "2026-08-02T16:29:35Z",
      approvedManifestSha256: HISTORICAL_V1_APPROVED_MANIFEST_SHA256,
      approvedSourcePrdSha256: HISTORICAL_V1_APPROVED_SOURCE_PRD_SHA256,
      bundleMarkdownSha256: HISTORICAL_V1_BUNDLE_MARKDOWN_SHA256,
      principal: "Wzchen / Human Portfolio Governor",
      status: "approved-v1-current-until-v2-confirmation",
      statement:
        "The v1 approval is immutable history and does not approve this draft-v2 candidate.",
    },
    mapId: "E70",
    renderer,
    schemaVersion: 2,
    sectionHashes: sectionHashes(sourceMarkdown),
    sourcePrdSha256: sha256(sourceMarkdown),
    status: "candidate",
    publicExportContract: {
      types: exports.types,
      values: exports.values,
      sha256: sha256(
        "Types:\n" +
          exports.types.join("\n") +
          "\n\nValues:\n" +
          exports.values.join("\n") +
          "\n",
      ),
      source: "PRD.md#9-typed-rejection-and-public-export-contract",
    },
    verificationContract: {
      commands,
      profile: "strict",
      sha256: sha256(commands.join("\n") + "\n"),
      source:
        "PRD.md#12-delivery-plan-allowed-change-surface-and-verification-contract",
    },
  };
}

function buildOutputs() {
  const sourceMarkdown = readUtf8(sourcePrdPath);
  const bundleMarkdown = relocateMarkdown(sourceMarkdown);
  const html = renderHtml(bundleMarkdown, sha256(bundleMarkdown));
  const documentJson = json(buildDocument(sourceMarkdown));
  const manifestJson = json(
    buildManifest({ sourceMarkdown, bundleMarkdown, html, documentJson }),
  );
  return {
    sourceMarkdown,
    bundleMarkdown,
    html,
    documentJson,
    manifestJson,
    manifestSha256: sha256(manifestJson) + "  manifest.json\n",
  };
}

function anchorsForMarkdown(markdown) {
  return new Set(markdownSections(markdown).keys());
}

function validateMarkdownLinks(markdown, baseDirectory, label) {
  let checked = 0;
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/i.test(target)) {
      continue;
    }
    const [pathPart, fragment] = target.split("#", 2);
    const resolved = resolve(baseDirectory, pathPart);
    const repositoryRelative = relative(repositoryRoot, resolved);
    if (repositoryRelative === ".." || repositoryRelative.startsWith("../")) {
      throw new Error(label + " link escapes repository: " + target);
    }
    if (!existsSync(resolved)) {
      throw new Error(label + " has a missing target: " + target);
    }
    if (fragment && !anchorsForMarkdown(readUtf8(resolved)).has(fragment)) {
      throw new Error(label + " has a missing target anchor: " + target);
    }
    checked += 1;
  }
  if (checked !== 5) {
    throw new Error(label + " expected 5 local links; checked " + checked);
  }
}

function validateSafeHtml(html, bundleMarkdown) {
  const forbidden = [
    /<script\b/i,
    /<iframe\b/i,
    /<object\b/i,
    /<embed\b/i,
    /<base\b/i,
    /<form\b/i,
    /\son[a-z]+\s*=/i,
    /javascript\s*:/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(html)) {
      throw new Error("Unsafe HTML pattern: " + pattern);
    }
  }
  if (!html.includes('http-equiv="Content-Security-Policy"')) {
    throw new Error("Generated HTML is missing Content-Security-Policy");
  }
  if (!html.includes("<pre>" + escapeHtml(bundleMarkdown) + "</pre>")) {
    throw new Error("Generated HTML does not contain escaped Markdown");
  }
}

function validateFileSet() {
  const expected = [
    "approved-prd.html",
    "approved-prd.md",
    "document.json",
    "manifest.json",
    "manifest.sha256",
  ].sort();
  const actual = readdirSync(bundleDir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Unexpected E70 bundle file set: " + JSON.stringify(actual));
  }
}

function writeOutputs(outputs) {
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(outputPaths.markdown, outputs.bundleMarkdown, "utf8");
  writeFileSync(outputPaths.html, outputs.html, "utf8");
  writeFileSync(outputPaths.structured, outputs.documentJson, "utf8");
  writeFileSync(outputPaths.manifest, outputs.manifestJson, "utf8");
  writeFileSync(outputPaths.manifestSha256, outputs.manifestSha256, "utf8");
}

function validateOutputs(outputs) {
  const expectedByPath = new Map([
    [outputPaths.markdown, outputs.bundleMarkdown],
    [outputPaths.html, outputs.html],
    [outputPaths.structured, outputs.documentJson],
    [outputPaths.manifest, outputs.manifestJson],
    [outputPaths.manifestSha256, outputs.manifestSha256],
  ]);
  for (const [path, expected] of expectedByPath) {
    if (!existsSync(path) || readUtf8(path) !== expected) {
      throw new Error(
        "Missing or stale E70 bundle file: " + relative(repositoryRoot, path),
      );
    }
  }
  validateFileSet();
  validateMarkdownLinks(outputs.sourceMarkdown, epicDir, "E70 source PRD");
  validateMarkdownLinks(outputs.bundleMarkdown, bundleDir, "E70 bundle PRD");
  validateSafeHtml(outputs.html, outputs.bundleMarkdown);
  const manifest = JSON.parse(outputs.manifestJson);
  const document = JSON.parse(outputs.documentJson);
  if (
    manifest.approvalStatus !== "pending-human-confirmation" ||
    manifest.engineeringEligibility !== "ineligible" ||
    document.metadata.approvalStatus !== "not-approved"
  ) {
    throw new Error("E70 candidate lifecycle markers are unsafe");
  }
}

const mode = process.argv[2] ?? "--write";
if (!["--write", "--check"].includes(mode) || process.argv.length > 3) {
  throw new Error(
    "Usage: node docs/v2/epics/E70/generate-bundle.mjs [--write|--check]",
  );
}

const outputs = buildOutputs();
if (mode === "--write") {
  writeOutputs(outputs);
}
validateOutputs(outputs);
process.stdout.write(
  "E70 PRD candidate bundle " +
    (mode === "--write" ? "generated" : "verified") +
    ": " +
    sha256(outputs.manifestJson) +
    "\n",
);
