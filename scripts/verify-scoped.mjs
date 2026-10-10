#!/usr/bin/env node
// verify-scoped.mjs — what a scoped push must run BEYOND the affected-workspace suites (see db-lane.mjs).
//   1. the DB specs db-lane.mjs names, through scripts/local-db-specs.mjs (a fresh rf_dbspec_* database), when n > 0;
//   2. ALWAYS, in apps/api: the size ratchet (repo-truth lane) and the cross-workspace guard specs
//      enum-parity / no-bare-cron / addon-gate-registry — an api-less scope skips them otherwise (#2719).
// Every step runs; the exit code is the first non-zero one. --dry-run prints the commands only.
//
// usage: node scripts/verify-scoped.mjs [--base origin/master] [--files a,b] [--diff file] [--dry-run]
//                                       [--root <dir>] [--jest <node-script>]   (--jest is a test seam)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanGitEnv } from "./lib/verify-scope.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const a = { pass: [], dryRun: false, root: path.resolve(here, ".."), jest: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === "--dry-run") a.dryRun = true;
  else if (k === "--root" || k === "--jest") {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`verify-scoped: ${k} needs a value`);
      process.exit(2);
    }
    if (k === "--root") a.root = path.resolve(v);
    else a.jest = v;
  } else if (["--base", "--files", "--diff"].includes(k)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`verify-scoped: ${k} needs a value`);
      process.exit(2);
    }
    a.pass.push(k, v);
  } else {
    console.error(`verify-scoped: unknown argument ${k}`);
    process.exit(2);
  }
}

const lane = spawnSync(
  process.execPath,
  [path.join(here, "db-lane.mjs"), "--json", "--root", a.root, ...a.pass],
  {
    encoding: "utf8",
    env: cleanGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (lane.status !== 0) {
  process.stderr.write(lane.stderr || "");
  console.error(`verify-scoped: db-lane failed (exit ${lane.status})`);
  process.exit(lane.status || 2);
}
const { specs } = JSON.parse(lane.stdout);

const apiDir = path.join(a.root, "apps", "api");
const jest = (args) =>
  a.jest
    ? { cmd: process.execPath, args: [a.jest, ...args], show: `jest ${args.join(" ")}` }
    : { cmd: "npx", args: ["jest", ...args], show: `npx jest ${args.join(" ")}` };
const steps = [];
if (specs.length) {
  const rel = specs.map((s) => s.replace(/^apps\/api\//, ""));
  steps.push({
    cwd: a.root,
    cmd: process.execPath,
    args: [
      path.join(a.root, "scripts", "local-db-specs.mjs"),
      "--",
      `npm run test:db -w apps/api -- ${rel.join(" ")}`,
    ],
    show: `node scripts/local-db-specs.mjs -- "npm run test:db -w apps/api -- ${rel.join(" ")}"`,
  });
}
steps.push({ cwd: apiDir, ...jest(["-c", "jest.repo-truth.config.js", "size-ratchet"]) });
steps.push({ cwd: apiDir, ...jest(["enum-parity", "no-bare-cron", "addon-gate-registry"]) });

let code = 0;
for (const s of steps) {
  console.log(`> ${s.show}`);
  if (a.dryRun) continue;
  const r = spawnSync(s.cmd, s.args, {
    cwd: s.cwd,
    stdio: "inherit",
    env: process.env,
    shell: s.cmd === "npx" && process.platform === "win32",
  });
  if (r.status !== 0 && code === 0) code = r.status ?? 1;
}
process.exit(code);
