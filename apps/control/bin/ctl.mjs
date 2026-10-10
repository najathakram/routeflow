#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist", "cli", "ctl.js");
// Stamp written after a successful build: incremental tsc leaves unchanged outputs untouched,
// so the output mtime alone would look stale forever.
const stamp = join(root, "dist", ".ctl-build-stamp");

function newestMtime(dir) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

const stale =
  !existsSync(dist) ||
  !existsSync(stamp) ||
  statSync(stamp).mtimeMs < newestMtime(join(root, "src"));
const hook = process.argv.slice(2).includes("--hook");

// SessionStart hook: never build, never print; a missing or stale build is a silent no-op.
if (hook && stale) process.exit(0);

if (stale) {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], {
    stdio: ["inherit", 2, "inherit"], // tsc stdout -> stderr: stdout stays the CLI's own
    cwd: root,
  });
  if (r.error) console.error(r.error);
  if (r.status !== 0) process.exit(r.status ?? 1);
  writeFileSync(stamp, String(Date.now()));
}

const mod = await import(pathToFileURL(dist).href);
await mod.main(process.argv.slice(2));
