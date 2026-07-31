import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = [
  "apps/workflowd",
  "apps/workflow-worker",
  "packages/v2-domain",
  "packages/v2-protocol",
  "packages/v2-testkit",
];

await Promise.all(
  workspaces.map((workspace) =>
    rm(resolve(repositoryRoot, workspace, "dist"), { recursive: true, force: true }),
  ),
);
