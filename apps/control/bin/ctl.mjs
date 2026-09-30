#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist", "cli", "ctl.js");

function newestMtime(dir) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

if (!existsSync(dist) || statSync(dist).mtimeMs < newestMtime(join(root, "src"))) {
  const r = spawnSync("npx", ["tsc", "-p", join(root, "tsconfig.build.json")], {
    stdio: "inherit",
    cwd: root,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(dist).href);
await mod.main(process.argv.slice(2));
