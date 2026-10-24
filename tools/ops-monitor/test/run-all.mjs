// Runs every *.test.mjs in this directory serially. Node 20 does not expand globs for
// `node --test`, so the file list is built here. OPS_TEST_DIR overrides the directory (used by the
// runner's own test).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.OPS_TEST_DIR
  ? resolve(process.env.OPS_TEST_DIR)
  : dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`run-all: no *.test.mjs files in ${dir}`);
  process.exit(1);
}
// The suite is git-heavy and serial: lift the production git concurrency cap (2) for the children.
const env = { ...process.env, OPS_GIT_CONCURRENCY: process.env.OPS_GIT_CONCURRENCY ?? "8" };
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  stdio: "inherit",
  env,
});
process.exit(r.status ?? 1);
