import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openArtifactStore } from "@pi-workflow/workflowd";

function root(prefix = "workflowd-e07-") {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

function metadata(overrides = {}) {
  return {
    mediaType: "text/plain",
    authority: "test-fixture",
    retentionClass: "standard",
    redaction: { status: "not-required" },
    ...overrides,
  };
}

function open(rootPath, mode = "read-write") {
  return openArtifactStore({ artifactRoot: rootPath, mode, now: () => 1_700_000_000_000 });
}

function close(store) {
  if (store?.ok) store.value.close();
}

test("E07 import is side-effect free and creates only on open", () => {
  const artifactRoot = join(root(), "artifacts");
  try {
    assert.equal(existsSync(artifactRoot), false);
    const opened = open(artifactRoot);
    assert.equal(opened.ok, true);
    assert.equal(existsSync(artifactRoot), true);
    close(opened);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 writes immutable content-addressed objects and returns a closed public record", () => {
  const artifactRoot = root();
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const input = new Uint8Array([1, 2, 3]);
    const first = opened.value.put(input, metadata());
    assert.equal(first.ok, true);
    if (!first.ok) return;
    input[0] = 99;
    assert.match(first.value.artifactId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.value.byteSize, 3);
    assert.equal(first.value.relativePath, "objects/" + first.value.sha256.slice(0, 2) + "/" + first.value.sha256);
    assert.equal(Object.hasOwn(first.value, "metadataHash"), false);
    assert.equal(Object.hasOwn(first.value, "metadataText"), false);
    assert.equal(lstatSync(join(artifactRoot, first.value.relativePath)).mode & 0o777, 0o600);
    const read = opened.value.read(first.value.artifactId);
    assert.equal(read.ok, true);
    if (read.ok) assert.deepEqual([...read.value], [1, 2, 3]);
    const manifest = opened.value.manifest();
    assert.equal(manifest.ok, true);
    if (manifest.ok) assert.deepEqual(manifest.value.map((item) => item.artifactId), [first.value.artifactId]);
  } finally {
    close(opened);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 duplicate digest is idempotent while metadata collision is rejected", () => {
  const artifactRoot = root();
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const bytes = new TextEncoder().encode("same");
    const first = opened.value.put(bytes, metadata());
    const duplicate = opened.value.put(bytes, metadata());
    assert.equal(first.ok, true);
    assert.deepEqual(duplicate, first);
    const collision = opened.value.put(bytes, metadata({ authority: "different" }));
    assert.equal(collision.ok, false);
    if (!collision.ok) assert.equal(collision.rejection.code, "collision");
    const manifest = opened.value.manifest();
    assert.equal(manifest.ok, true);
    if (manifest.ok) assert.equal(manifest.value.length, 1);
  } finally {
    close(opened);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 registry survives close/reopen and keeps the same content identity", () => {
  const artifactRoot = root();
  let record;
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const stored = opened.value.put(new TextEncoder().encode("reopen"), metadata({ retentionClass: "governance" }));
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    record = stored.value;
  } finally {
    close(opened);
  }
  const reopened = open(artifactRoot);
  try {
    assert.equal(reopened.ok, true);
    if (!reopened.ok || !record) return;
    const manifest = reopened.value.manifest();
    assert.equal(manifest.ok, true);
    if (manifest.ok) assert.deepEqual(manifest.value, [record]);
    const scan = reopened.value.scan();
    assert.deepEqual(scan, { ok: true, value: { status: "clean", registered: 1, missing: [], corrupt: [], orphans: [] } });
  } finally {
    close(reopened);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 verify, read, and scan detect truncation and missing objects", () => {
  const artifactRoot = root();
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const stored = opened.value.put(new TextEncoder().encode("integrity"), metadata());
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    const objectPath = join(artifactRoot, stored.value.relativePath);
    writeFileSync(objectPath, "bad", { mode: 0o600 });
    const corrupt = opened.value.verify(stored.value.artifactId);
    assert.equal(corrupt.ok, false);
    if (!corrupt.ok) assert.equal(corrupt.rejection.code, "corrupt");
    const corruptScan = opened.value.scan();
    assert.equal(corruptScan.ok, true);
    if (corruptScan.ok) assert.deepEqual(corruptScan.value.corrupt, [stored.value.artifactId]);
    unlinkSync(objectPath);
    const missing = opened.value.verify(stored.value.artifactId);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.rejection.code, "not_found");
    const missingScan = opened.value.scan();
    assert.equal(missingScan.ok, true);
    if (missingScan.ok) assert.deepEqual(missingScan.value.missing, [stored.value.artifactId]);
  } finally {
    close(opened);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 scan reports canonical orphan files without deleting them", () => {
  const artifactRoot = root();
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const orphanBytes = new TextEncoder().encode("orphan");
    const digest = "0".repeat(64);
    const prefix = join(artifactRoot, "objects", digest.slice(0, 2));
    // The filename is a valid digest-shaped orphan; its bytes need not match
    // the name because scan reports registry absence rather than accepting it.
    mkdirSync(prefix, { mode: 0o700 });
    writeFileSync(join(prefix, digest), orphanBytes, { mode: 0o600 });
    const scan = opened.value.scan();
    assert.equal(scan.ok, true);
    if (scan.ok) {
      assert.equal(scan.value.status, "issues");
      assert.deepEqual(scan.value.orphans, ["objects/" + digest.slice(0, 2) + "/" + digest]);
    }
    assert.equal(existsSync(join(prefix, digest)), true);
  } finally {
    close(opened);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 hardlinks and symlinks fail closed", () => {
  const artifactRoot = root();
  const outsideRoot = root("workflowd-e07-outside-");
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const stored = opened.value.put(new TextEncoder().encode("protected"), metadata());
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    const objectPath = join(artifactRoot, stored.value.relativePath);
    const hardlink = join(artifactRoot, "hardlink");
    linkSync(objectPath, hardlink);
    const hardlinked = opened.value.verify(stored.value.artifactId);
    assert.equal(hardlinked.ok, false);
    if (!hardlinked.ok) assert.equal(hardlinked.rejection.code, "corrupt");
    unlinkSync(hardlink);
    unlinkSync(objectPath);
    const outside = join(outsideRoot, "outside");
    writeFileSync(outside, "outside", { mode: 0o600 });
    symlinkSync(outside, objectPath);
    const linked = opened.value.verify(stored.value.artifactId);
    assert.equal(linked.ok, false);
    if (!linked.ok) assert.equal(linked.rejection.code, "corrupt");
  } finally {
    close(opened);
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("E07 read-only mode never writes and returns independent byte copies", () => {
  const artifactRoot = root();
  const opened = open(artifactRoot);
  let record;
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const stored = opened.value.put(new TextEncoder().encode("copy"), metadata());
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    record = stored.value;
  } finally {
    close(opened);
  }
  const readOnly = open(artifactRoot, "read-only");
  try {
    assert.equal(readOnly.ok, true);
    if (!readOnly.ok || !record) return;
    const bytes = readOnly.value.read(record.artifactId);
    assert.equal(bytes.ok, true);
    if (bytes.ok) {
      bytes.value[0] = 0;
      const again = readOnly.value.read(record.artifactId);
      assert.equal(again.ok, true);
      if (again.ok) assert.deepEqual([...again.value], [...new TextEncoder().encode("copy")]);
    }
    const put = readOnly.value.put(new Uint8Array([1]), metadata());
    assert.equal(put.ok, false);
    if (!put.ok) assert.equal(put.rejection.code, "read_only");
  } finally {
    close(readOnly);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 hostile metadata and byte objects fail before mutation", () => {
  const artifactRoot = root();
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const before = opened.value.manifest();
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("boom"); } });
    const badMetadata = opened.value.put(new Uint8Array([1]), hostile);
    assert.equal(badMetadata.ok, false);
    if (!badMetadata.ok) assert.equal(badMetadata.rejection.code, "invalid_input");
    const badBytes = opened.value.put(new Proxy(new Uint8Array([1]), { getPrototypeOf() { throw new Error("boom"); } }), metadata());
    assert.equal(badBytes.ok, false);
    if (!badBytes.ok) assert.equal(badBytes.rejection.code, "invalid_input");
    const after = opened.value.manifest();
    assert.deepEqual(after, before);
  } finally {
    close(opened);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 broad object permissions are reported as corruption", () => {
  const artifactRoot = root();
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const stored = opened.value.put(new Uint8Array([7]), metadata());
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    const path = join(artifactRoot, stored.value.relativePath);
    chmodSync(path, 0o644);
    const result = opened.value.verify(stored.value.artifactId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "corrupt");
  } finally {
    close(opened);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("E07 registry metadata hash tamper fails closed", async () => {
  const artifactRoot = root();
  const opened = open(artifactRoot);
  try {
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const stored = opened.value.put(new Uint8Array([8]), metadata());
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(artifactRoot, "artifact-meta.db"));
    database.prepare("UPDATE workflow_artifact_registry SET metadata_hash = $hash").run({ $hash: "0".repeat(64) });
    database.close();
    const result = opened.value.verify(stored.value.artifactId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "registry_corrupt");
    const scan = opened.value.scan();
    assert.equal(scan.ok, false);
    if (!scan.ok) assert.equal(scan.rejection.code, "registry_corrupt");
  } finally {
    close(opened);
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});
