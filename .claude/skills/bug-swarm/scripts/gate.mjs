#!/usr/bin/env node
// Why: the /bug-swarm gate was a hand-typed shell chain that broke twice. Run 2026-10-23-bug-swarm-1:
// `(dashboard)` paths were unquoted and `origin/master..HEAD` drifted once master moved. Run
// 2026-10-23-bug-swarm-2: the same chain was re-typed. Steps here are argv arrays (never a shell
// string) and the diff range is always `git merge-base origin/master HEAD`..HEAD.
//
//   node gate.mjs [--needs-db] [--json out.json] [--dry-run]     (run from a worktree root)
//
// Pure core: planGate(...) -> steps[]; runGate(steps, { exec }) runs every step, never stops early.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PRETTIER_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".yml",
  ".yaml",
  ".html",
]);
const LINT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const JEST_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);

/** { base, files } for the whole branch: merge-base with origin/master, deleted files dropped. */
export function changedSince(git) {
  const base = git(["merge-base", "origin/master", "HEAD"]).trim();
  const out = git(["diff", "--name-only", "-z", "--diff-filter=d", `${base}..HEAD`]);
  return { base, files: out.split("\0").filter(Boolean) };
}

const workspaceOf = (f) => /^(apps|packages)\/[^/]+(?=\/)/.exec(f)?.[0] ?? null;

export function planGate({
  changedFiles,
  needsDb = false,
  base = "origin/master",
  root = process.cwd(),
  exists = existsSync,
}) {
  const steps = [];
  const add = (name, cwd, cmd) => steps.push({ name, cwd, cmd });
  add("packages-build", root, ["npx", "turbo", "run", "build", "--filter=./packages/*"]);
  add("signature-scan", root, ["node", ".claude/skills/bug-hunt/scripts/scan-signatures.mjs"]);
  add("commitlint", root, ["npx", "commitlint", "--from", base, "--to", "HEAD"]);

  const pretty = changedFiles.filter((f) => PRETTIER_EXT.has(path.extname(f)));
  if (pretty.length) add("prettier", root, ["npx", "prettier", "--check", ...pretty]);

  const byWs = new Map();
  for (const f of changedFiles) {
    const ws = workspaceOf(f);
    if (!ws) continue;
    if (!byWs.has(ws)) byWs.set(ws, []);
    byWs.get(ws).push(f);
  }
  for (const ws of [...byWs.keys()].sort()) {
    const rel = byWs.get(ws).map((f) => path.relative(ws, f));
    const cwd = path.join(root, ws);
    if (ws === "apps/api") add(`tsc:${ws}`, root, ["npm", "run", "check-types", "-w", "apps/api"]);
    else add(`tsc:${ws}`, cwd, ["npx", "tsc", "--noEmit"]);
    const lint = rel.filter((f) => LINT_EXT.has(path.extname(f)));
    // Packages lint via tsc (above); only apps carry an eslint flat config.
    if (ws.startsWith("apps/") && lint.length)
      add(`eslint:${ws}`, cwd, ["npx", "eslint", "--quiet", ...lint]);
    const tests = rel.filter((f) => JEST_EXT.has(path.extname(f)));
    if (tests.length)
      add(`jest:${ws}`, cwd, ["npx", "jest", "--passWithNoTests", "--findRelatedTests", ...tests]);
  }

  if (changedFiles.some((f) => f.startsWith("tools/ops-monitor/"))) {
    add("self-test:ops-monitor", root, ["node", "tools/ops-monitor/test/run-all.mjs"]);
  }
  const seen = new Set();
  for (const f of changedFiles) {
    const m = /^scripts\/([^/]+?)(?:\.self-test)?\.mjs$/.exec(f);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const test = `scripts/${m[1]}.self-test.mjs`;
    if (exists(path.join(root, test))) add(`self-test:scripts/${m[1]}`, root, ["node", test]);
  }

  add("size-ratchet", path.join(root, "apps/api"), [
    "npx",
    "jest",
    "-c",
    "jest.repo-truth.config.js",
    "size-ratchet",
  ]);
  if (needsDb) add("db-lane", root, ["npm", "run", "local:test:db"]);
  return steps;
}

function defaultExec(step) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd[0], step.cmd.slice(1), {
      cwd: step.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (e) => resolve({ status: 127, output: `${output}\n${e.message}` }));
    child.on("close", (code) => resolve({ status: code ?? 1, output }));
  });
}

export async function runGate(steps, { exec = defaultExec } = {}) {
  const results = [];
  for (const step of steps) {
    const t0 = Date.now();
    const { status, output } = await exec(step);
    results.push({
      name: step.name,
      ok: status === 0,
      exit: status,
      ms: Date.now() - t0,
      tail: String(output ?? "")
        .replace(/\n$/, "")
        .split("\n")
        .slice(-20)
        .join("\n"),
    });
  }
  return { ok: results.every((r) => r.ok), steps: results };
}

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export async function main(argv = process.argv.slice(2)) {
  const needsDb = argv.includes("--needs-db");
  const dryRun = argv.includes("--dry-run");
  const ji = argv.indexOf("--json");
  let jsonOut = ji === -1 ? null : argv[ji + 1];
  if (ji !== -1 && !jsonOut) {
    console.error("gate: --json needs a file path");
    return 2;
  }
  if (jsonOut) {
    jsonOut = path.resolve(jsonOut);
    argv = argv.map((a, i) => (i === ji + 1 ? jsonOut : a));
  }
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const { base, files } = changedSince(git);
  const steps = planGate({ changedFiles: files, needsDb, base, root });

  if (dryRun) {
    console.log(
      `gate plan: base ${base}, ${files.length} changed file(s), ${steps.length} step(s)`,
    );
    for (const s of steps) console.log(`- ${s.name}  (cwd ${s.cwd})  ${s.cmd.join(" ")}`);
    return 0;
  }

  if (process.env.RF_HEAVY_SLOT_HELD !== "1") {
    const branch = git(["branch", "--show-current"]).trim();
    const r = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/heavy-slot.mjs"),
        "run",
        "--label",
        "bug-swarm-gate",
        "--branch",
        branch,
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
        ...argv,
      ],
      { cwd: root, stdio: "inherit", env: { ...process.env, RF_HEAVY_SLOT_HELD: "1" } },
    );
    return r.status ?? 1;
  }

  const result = await runGate(steps);
  for (const s of result.steps)
    console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.ms} ms, exit ${s.exit})`);
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => (process.exitCode = c));
}
