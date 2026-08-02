#!/usr/bin/env node

/**
 * Deterministic bootstrap generator for the E02 review bundle only.
 *
 * This is intentionally not a reusable Document Bundle runtime, an E25
 * implementation, or an approval mechanism. It performs the narrow bootstrap
 * transformation needed to relocate the five PRD links after the approved
 * source is copied one directory deeper into bundle/.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
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
const e01PrdPath = resolve(epicDir, "../E01/PRD.md");
const e01ManifestPath = resolve(
  epicDir,
  "../E01/bundle/manifest.json",
);

const HISTORICAL_APPROVED_SOURCE_PRD_SHA256 =
  "d1aeee69cdae24e437479588fd2d58249198f3e942a2ce027579575f137b7810";
const HISTORICAL_APPROVED_DRAFT_MANIFEST_SHA256 =
  "b67245687bb02639c5040e774e1ae2970661419e2fe0d1f3547592f0d8c3c67d";

const renderer = {
  id: "pi-workflow-e02-bootstrap-safe-preformatted-html-v3",
  mode: "escaped-markdown-pre",
  version: 3,
};

const linkRewrites = [
  ["../../INITIATIVE_CHARTER.md", "../../../INITIATIVE_CHARTER.md"],
  [
    "../../ARCHITECTURE_RFC.md#11-state-model",
    "../../../ARCHITECTURE_RFC.md#11-state-model",
  ],
  [
    "../../INITIAL_EPIC_MAP.md#2-bounded-epic-rules",
    "../../../INITIAL_EPIC_MAP.md#2-bounded-epic-rules",
  ],
  [
    "../../THIRD_PARTY_REUSE_SURVEY.md#1-decision-posture",
    "../../../THIRD_PARTY_REUSE_SURVEY.md#1-decision-posture",
  ],
  [
    "../E01/PRD.md#17-verification-contract",
    "../../E01/PRD.md#17-verification-contract",
  ],
];

const historicalDraftPaths = [
  resolve(bundleDir, "draft-prd.html"),
  resolve(bundleDir, "draft-prd.md"),
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

function slugForHeading(title) {
  return title
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function markdownSections(markdown) {
  const headings = [
    ...markdown.matchAll(/^(#{1,6})[ \t]+(.+)$/gm),
  ].map((match) => ({
    index: match.index,
    slug: slugForHeading(match[2]),
  }));

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
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function requiredSection(markdown, slug) {
  const section = markdownSections(markdown).get(slug);
  if (!section) {
    throw new Error("Missing required Markdown section: " + slug);
  }
  return section;
}

function relocateApprovedMarkdown(sourceMarkdown) {
  let relocated = sourceMarkdown;
  for (const [sourceTarget, bundleTarget] of linkRewrites) {
    const sourceLink = "](" + sourceTarget + ")";
    const count = relocated.split(sourceLink).length - 1;
    if (count !== 1) {
      throw new Error(
        "Expected exactly one E02 source link " +
          sourceTarget +
          "; found " +
          count,
      );
    }
    relocated = relocated.replace(
      sourceLink,
      "](" + bundleTarget + ")",
    );
  }
  return relocated;
}

function acceptanceCriteria(sourceMarkdown) {
  const criteria = [];
  const section = requiredSection(
    sourceMarkdown,
    "6-acceptance-criteria-continuous-reduced-set",
  );
  for (const match of section.matchAll(
    /^- \*\*(AC-\d{3}) — (.+?)\*\* (.+)$/gm,
  )) {
    criteria.push({
      id: match[1],
      statement: match[3],
      title: match[2],
    });
  }
  if (criteria.length !== 12) {
    throw new Error(
      "Expected 12 E02 acceptance criteria; found " + criteria.length,
    );
  }
  return criteria;
}

function nonGoals(sourceMarkdown) {
  const section = requiredSection(
    sourceMarkdown,
    "4-explicit-non-goals-and-authority-handoff",
  );
  const goals = [...section.matchAll(/^- (.+)$/gm)].map((match) => match[1]);
  if (goals.length !== 16) {
    throw new Error("Expected 16 E02 non-goals; found " + goals.length);
  }
  return goals;
}

function expandEpicOwners(ownerCell) {
  const expanded = ownerCell.replace(
    /E(\d{2})[–-]E(\d{2})/g,
    (_match, first, last) => {
      const owners = [];
      for (
        let value = Number.parseInt(first, 10);
        value <= Number.parseInt(last, 10);
        value += 1
      ) {
        owners.push("E" + String(value).padStart(2, "0"));
      }
      return owners.join(" ");
    },
  );
  return [...new Set(expanded.match(/E\d{2}/g) ?? [])];
}

function decisionTraceability(sourceMarkdown) {
  const section = requiredSection(
    sourceMarkdown,
    "1-related-authority-and-frozen-traceability",
  );
  const decisions = {};
  for (const line of section.split("\n")) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length === 3 && /^D\d{2}$/.test(cells[0])) {
      decisions[cells[0]] = expandEpicOwners(cells[2]);
    }
  }
  if (Object.keys(decisions).length !== 21) {
    throw new Error(
      "Expected 21 E02 traceability decisions; found " +
        Object.keys(decisions).length,
    );
  }
  return decisions;
}

function verificationCommands(sourceMarkdown) {
  const section = requiredSection(
    sourceMarkdown,
    "7-strict-verification-contract",
  );
  const block = section.match(/```text\n([\s\S]*?)\n```/);
  if (!block) {
    throw new Error("Missing E02 verification command block");
  }
  return block[1].split("\n").filter(Boolean);
}

function buildDocument(sourceMarkdown, sourcePrdSha256) {
  const decisions = decisionTraceability(sourceMarkdown);
  const commands = verificationCommands(sourceMarkdown);
  return {
    acceptanceCriteria: acceptanceCriteria(sourceMarkdown),
    documentType: "bounded-epic-prd",
    metadata: {
      approvalStatus: "not-approved",
      deliveryUnits: 1,
      engineeringEligibility: "ineligible",
      epic: "workflow-agent-c2b.3",
      initiative: "workflow-agent-c2b",
      mapId: "E02",
      maximumTasks: 5,
      status: "draft",
      targetActiveEngineeringTime: "1.5–2h",
      title: "Domain identities, hierarchy, and primitive transition kernel",
      verificationProfile: "strict",
      version: "draft-v3",
    },
    schemaVersion: 2,
    scope: {
      included: [
        "branded identities and caller-supplied scalar references/timestamps",
        "immutable revisioned envelopes and canonical ordering",
        "Portfolio→Initiative→Epic→DeliveryUnit→Task ownership and parent/repository invariants",
        "generic expected-revision result, typed rejection, DomainTransitionRecord, and single-dimension conformance helper",
        "deterministic zero-side-effect public exports and tests",
      ],
      nonGoals: nonGoals(sourceMarkdown),
    },
    sectionHashes: sectionHashes(sourceMarkdown),
    sourcePrdSha256,
    traceability: {
      decisions,
      ownerEpics: decisions.D21,
    },
    verification: {
      commands,
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
    "<title>E02 PRD — pending human confirmation</title>",
    "<style>body{margin:0;background:#f7f7f8;color:#171717;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}main{max-width:1100px;margin:0 auto;padding:32px}header{background:#111827;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:20px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:24px;box-shadow:0 1px 3px #0001}</style>",
    "</head>",
    "<body><main>",
    "<header><strong>E02 PRD CANDIDATE — PENDING HUMAN CONFIRMATION</strong><br>The legacy approved-prd filename carries no approval authority.<br>Bundle Markdown SHA-256: " +
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

function buildAuthorityChain() {
  const specifications = [
    ["ARCHITECTURE_RFC.md", "../../../ARCHITECTURE_RFC.md"],
    ["INITIAL_EPIC_MAP.md", "../../../INITIAL_EPIC_MAP.md"],
    ["INITIATIVE_CHARTER.md", "../../../INITIATIVE_CHARTER.md"],
    ["THIRD_PARTY_REUSE_SURVEY.md", "../../../THIRD_PARTY_REUSE_SURVEY.md"],
  ];
  const authorityDocuments = {};
  const authoritySectionHashes = {};
  for (const [name, manifestPath] of specifications) {
    const content = readUtf8(resolve(v2Dir, name));
    authorityDocuments[name] = {
      path: manifestPath,
      sha256: sha256(content),
    };
    authoritySectionHashes[name] = sectionHashes(content);
  }
  return { authorityDocuments, authoritySectionHashes };
}

function buildManifest({
  approvedHtml,
  approvedMarkdown,
  documentJson,
  sourceMarkdown,
}) {
  const sourcePrdSha256 = sha256(sourceMarkdown);
  const approvedMarkdownSha256 = sha256(approvedMarkdown);
  const commands = verificationCommands(sourceMarkdown);
  const generatorSha256 = sha256(readUtf8(generatorPath));
  const { authorityDocuments, authoritySectionHashes } =
    buildAuthorityChain();

  return {
    approvalStatus: "pending-human-confirmation",
    candidate: {
      status: "pending-human-confirmation",
      bundleConfirmationStatus: "pending-human-confirmation",
      sourcePrdSha256,
      bundleMarkdownSha256: approvedMarkdownSha256,
      statusSemantics:
        "This deterministic candidate has no approval authority until the user confirms this exact Manifest hash and Beads write/readback succeeds. The DRAFT/NOT APPROVED prose is the frozen pre-confirmation snapshot; after confirmation, the external Beads marker supersedes only lifecycle status, not content.",
    },
    historicalApproval: {
      status: "historical-only",
      principal: "Wzchen / Human Portfolio Governor",
      mode: "bootstrap-manual-chat-v1",
      statement:
        "User replied '批准' to approval of the exact draft manifest " +
        HISTORICAL_APPROVED_DRAFT_MANIFEST_SHA256 +
        "; that approval does not cover this draft-v3 candidate.",
      approvedAt: "2026-08-01T16:17:43Z",
      approvedDraftManifestSha256:
        HISTORICAL_APPROVED_DRAFT_MANIFEST_SHA256,
      approvedSourcePrdSha256: HISTORICAL_APPROVED_SOURCE_PRD_SHA256,
    },
    authorityDocuments,
    authoritySectionHashes,
    documentBundleId: "workflow-agent-c2b-e02-draft-v3-candidate",
    dependencyBaselines: {
      E01: {
        finalCandidateCommit:
          "d5debd4d03114a80a45b14ccdb7439b944d6461d",
        manifest: {
          path: "../../E01/bundle/manifest.json",
          sha256: sha256(readUtf8(e01ManifestPath)),
        },
        prd: {
          path: "../../E01/PRD.md",
          sha256: sha256(readUtf8(e01PrdPath)),
        },
        requiredDisposition: "engineering-complete",
      },
    },
    documents: {
      html: {
        authority: "candidate-pending-human-confirmation",
        mediaType: "text/html",
        path: "approved-prd.html",
        sha256: sha256(approvedHtml),
      },
      markdown: {
        authority: "candidate-pending-human-confirmation",
        mediaType: "text/markdown",
        path: "approved-prd.md",
        sha256: approvedMarkdownSha256,
      },
      source: {
        authority: "candidate-pending-human-confirmation",
        mediaType: "text/markdown",
        path: "../PRD.md",
        sha256: sourcePrdSha256,
      },
      structured: {
        authority: "candidate-pending-human-confirmation",
        mediaType: "application/json",
        path: "document.json",
        sha256: sha256(documentJson),
      },
    },
    engineeringEligibility: "ineligible",
    epicId: "workflow-agent-c2b.3",
    generator: {
      checkCommand:
        "node docs/v2/epics/E02/generate-bundle.mjs --check",
      id: "pi-workflow-e02-bootstrap-bundle-generator-v1",
      mode: "frozen-source-with-bundle-relative-link-relocation",
      path: "../generate-bundle.mjs",
      scope:
        "E02 bootstrap documentation only; not an E25 production renderer or generic Document Bundle runtime capability.",
      sha256: generatorSha256,
      version: 1,
    },
    governance: {
      beadsAuthority: true,
      requiresWriteReadback: true,
      engineeringEligibilityRequiresReadiness: true,
      approvalDoesNotImplyScheduling: true,
      note:
        "Candidate bootstrap bundle only. Exact human Manifest confirmation and Beads write/readback are required before Readiness; approval does not by itself authorize scheduling or external effects.",
    },
    historicalArtifacts: {
      authority: "none",
      disposition: "excluded",
      paths: ["draft-prd.html", "draft-prd.md"],
      reason:
        "Non-authoritative pre-approval historical outputs; intentionally absent from the regenerated bundle and submission candidate.",
    },
    initiativeId: "workflow-agent-c2b",
    mapId: "E02",
    renderer: {
      ...renderer,
      scope:
        "Safe preformatted HTML for the E02 bootstrap review bundle only; not E25 production capability.",
    },
    schemaVersion: 2,
    sectionHashes: sectionHashes(sourceMarkdown),
    sourcePrdSha256,
    status: "candidate",
    verificationContract: {
      commands,
      profile: "strict",
      sha256: sha256(commands.join("\n") + "\n"),
      source: "PRD.md#7-strict-verification-contract",
    },
  };
}

function buildOutputs() {
  const sourceMarkdown = readUtf8(sourcePrdPath);
  const sourcePrdSha256 = sha256(sourceMarkdown);

  const approvedMarkdown = relocateApprovedMarkdown(sourceMarkdown);
  const approvedMarkdownSha256 = sha256(approvedMarkdown);
  const approvedHtml = renderHtml(
    approvedMarkdown,
    approvedMarkdownSha256,
  );
  const documentJson = json(
    buildDocument(sourceMarkdown, sourcePrdSha256),
  );
  const manifestJson = json(
    buildManifest({
      approvedHtml,
      approvedMarkdown,
      documentJson,
      sourceMarkdown,
    }),
  );
  const manifestSha256 =
    sha256(manifestJson) + "  manifest.json\n";

  return {
    approvedHtml,
    approvedMarkdown,
    documentJson,
    manifestJson,
    manifestSha256,
    sourceMarkdown,
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
    if (!pathPart) {
      if (fragment && !anchorsForMarkdown(markdown).has(fragment)) {
        throw new Error(label + " has a missing local anchor: #" + fragment);
      }
      checked += 1;
      continue;
    }
    const resolvedTarget = resolve(baseDirectory, pathPart);
    const repositoryRelative = relative(repositoryRoot, resolvedTarget);
    if (
      repositoryRelative === ".." ||
      repositoryRelative.startsWith("../")
    ) {
      throw new Error(label + " link escapes repository: " + target);
    }
    if (!existsSync(resolvedTarget)) {
      throw new Error(label + " has a missing link target: " + target);
    }
    if (
      fragment &&
      !anchorsForMarkdown(readUtf8(resolvedTarget)).has(fragment)
    ) {
      throw new Error(
        label + " has a missing target anchor: " + target,
      );
    }
    checked += 1;
  }
  if (checked !== 5) {
    throw new Error(label + " expected 5 local links; checked " + checked);
  }
}

function validateSafeHtml(html, approvedMarkdown) {
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
  if (!html.includes("<pre>" + escapeHtml(approvedMarkdown) + "</pre>")) {
    throw new Error("Generated HTML does not contain only escaped Markdown");
  }
  for (const [, relocatedTarget] of linkRewrites) {
    if (!html.includes(relocatedTarget)) {
      throw new Error(
        "Generated HTML is missing relocated link text: " +
          relocatedTarget,
      );
    }
  }
}

function validateBundleFileSet() {
  const expected = [
    "approved-prd.html",
    "approved-prd.md",
    "document.json",
    "manifest.json",
    "manifest.sha256",
  ].sort();
  const actual = readdirSync(bundleDir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Unexpected E02 bundle file set: " + JSON.stringify(actual),
    );
  }
}

function validateGeneratedOutputs(outputs) {
  const expectedByPath = new Map([
    [outputPaths.html, outputs.approvedHtml],
    [outputPaths.markdown, outputs.approvedMarkdown],
    [outputPaths.structured, outputs.documentJson],
    [outputPaths.manifest, outputs.manifestJson],
    [outputPaths.manifestSha256, outputs.manifestSha256],
  ]);
  for (const [path, expected] of expectedByPath) {
    if (!existsSync(path)) {
      throw new Error("Missing generated E02 bundle file: " + path);
    }
    const actual = readUtf8(path);
    if (actual !== expected) {
      throw new Error(
        "Generated E02 bundle file is stale: " +
          relative(repositoryRoot, path),
      );
    }
  }
  for (const path of historicalDraftPaths) {
    if (existsSync(path)) {
      throw new Error(
        "Non-authoritative historical draft must be excluded: " + path,
      );
    }
  }
  validateBundleFileSet();
  validateMarkdownLinks(
    outputs.sourceMarkdown,
    epicDir,
    "E02 source PRD",
  );
  validateMarkdownLinks(
    outputs.approvedMarkdown,
    bundleDir,
    "E02 approved bundle Markdown",
  );
  validateSafeHtml(outputs.approvedHtml, outputs.approvedMarkdown);
}

function writeOutputs(outputs) {
  writeFileSync(outputPaths.markdown, outputs.approvedMarkdown, "utf8");
  writeFileSync(outputPaths.html, outputs.approvedHtml, "utf8");
  writeFileSync(outputPaths.structured, outputs.documentJson, "utf8");
  writeFileSync(outputPaths.manifest, outputs.manifestJson, "utf8");
  writeFileSync(
    outputPaths.manifestSha256,
    outputs.manifestSha256,
    "utf8",
  );
  for (const path of historicalDraftPaths) {
    rmSync(path, { force: true });
  }
}

const mode = process.argv[2] ?? "--write";
if (!["--write", "--check"].includes(mode) || process.argv.length > 3) {
  throw new Error(
    "Usage: node docs/v2/epics/E02/generate-bundle.mjs [--write|--check]",
  );
}

const outputs = buildOutputs();
if (mode === "--write") {
  writeOutputs(outputs);
}
validateGeneratedOutputs(outputs);
process.stdout.write(
  "E02 bootstrap bundle " +
    (mode === "--write" ? "generated" : "verified") +
    ": " +
    sha256(outputs.manifestJson) +
    "\n",
);
