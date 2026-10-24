#!/usr/bin/env node
// Local mirror of GitHub CI's Verify job, run on the exact tree GitHub tests (refs/pull/N/merge).
//
//   node scripts/local-ci.mjs --pr N [--from <worktree>] [--no-status] [--keep] [--dry]
//   node scripts/local-ci.mjs --self-test
//
// WHY: Actions minutes are scarce and the PC is idle between lanes. This reproduces ci.yml's Verify
// job (and db-migrations.yml's replay when the diff touches the Prisma lane) in a clean detached
// worktree, then posts the verdict as the commit status `local-ci/verify` on the PR head sha.
//
// Steps, in ci.yml order (see .github/workflows/ci.yml `verify` job):
//   lockdeps (semver@6.3.1 into a side dir) -> validate-lock-edges (NODE_PATH=lockdeps)
//   -> [npm ci, only when package-lock.json differs from the cloned node_modules]
//   -> prisma generate -> npm run verify (VERIFY_EXCLUDE=@routeflow/control) -> ci-audit-critical
//   -> ci-audit high report (advisory, never fails the run).
// DB lane (only when the diff touches db-migrations.yml's paths): squawk lint, then
// scripts/local-db-specs.mjs (fresh rf_dbspec_* DB, migrate deploy) running drift + the DB specs.
//
// DIFFERENCES from CI that cannot be matched on Windows (reported, not hidden):
//   * Node: CI pins NODE_VERSION 24; this runs the host Node (see result.json `node`).
//   * node_modules is a clone of the main checkout, not `npm ci` from scratch (npm ci runs only
//     when the lockfile differs). CI is a cold ubuntu runner with no turbo cache; here the turbo
//     cache is whatever the clone carries (verify-turbo is told no cache via TURBO_FORCE=true).
//   * OS: win32 vs ubuntu-latest (path separators, symlinks, line endings) can matter.
//   * Heavy steps take the machine-wide heavy slot (RF_HEAVY_SLOTS, default 3 here) and jest runs
//     with JEST_MAX_WORKERS=2, so wall time differs from CI's 30-minute timeout budget.
//   * The DB lane uses the compose Postgres (local-db-specs), not postgres:16-alpine in the job.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverNodeModules,
  planWorktree,
} from "../.claude/skills/bug-swarm/scripts/worktree.mjs";
import { withHeavySlot } from "./lib/heavy-slot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_SLUG = "najathakram/routeflow";
export const STATUS_CONTEXT = "local-ci/verify";

/** Paths whose change runs .github/workflows/db-migrations.yml (prefixes, plus the .db.spec.ts glob). */
const DB_LANE_PREFIXES = [
  "apps/api/prisma/",
  "apps/api/src/prisma/",
  "apps/api/prisma.config.ts",
  "apps/api/scripts/schema-drift.mjs",
  "apps/api/scripts/lib/",
  "apps/api/jest.db.config.js",
  "apps/api/package.json",
  "apps/api/src/common/testing/",
  "apps/api/.squawk.toml",
  "scripts/lint-migrations.mjs",
  ".github/workflows/db-migrations.yml",
];

export function touchesDbLane(files) {
  return files.some(
    (f) =>
      DB_LANE_PREFIXES.some((p) => f.startsWith(p)) || /^apps\/api\/src\/.*\.db\.spec\.ts$/.test(f),
  );
}

export function parseArgs(argv) {
  const o = { pr: null, dry: false, selfTest: false, keep: false, noStatus: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") o.dry = true;
    else if (a === "--self-test") o.selfTest = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--no-status") o.noStatus = true;
    else if (a === "--from" && argv[i + 1] !== undefined) o.from = argv[++i];
    else if (a === "--pr" && argv[i + 1] !== undefined) {
      const v = argv[++i];
      if (!/^[0-9]+$/.test(v)) throw new Error(`--pr must be a number, got ${JSON.stringify(v)}`);
      o.pr = Number(v);
    } else throw new Error(`unknown or incomplete argument ${JSON.stringify(a)}`);
  }
  if (o.pr === null && !o.selfTest) throw new Error("--pr N is required");
  return o;
}

export function resultDirName(pr, headSha) {
  return `${pr}-${headSha.slice(0, 12)}`;
}

/**
 * The ordered plan (pure). Each step: { name, cwd, cmd, env?, heavy?, advisory?, when? }.
 * `when` marks a conditional step so `--dry` can show why it may be absent.
 */
export function planLocalCi({ mergeSha, dir, from, lockdeps, lockChanged, dbLane, platform }) {
  const wt = planWorktree({
    repo: from,
    dir,
    branch: "local-ci-unused",
    base: mergeSha,
    from,
    platform,
    nodeModules: discoverNodeModules(from),
  });
  const plan = [];
  let n = 0;
  for (const s of wt) {
    if (s.cmd[0] === "git" && s.cmd[1] === "fetch") continue; // main() fetches the PR refs itself
    if (s.cmd[0] === "npx" && s.cmd[1] === "prisma") continue; // re-added below in ci.yml order
    const cmd =
      s.cmd[0] === "git" && s.cmd[1] === "worktree"
        ? ["git", "worktree", "add", "--detach", dir, mergeSha]
        : s.cmd;
    plan.push({
      name: `worktree:${++n}`,
      cwd: s.cwd,
      cmd,
      heavy: cmd[0] === "npx", // the packages build
    });
  }
  const nm = (p) => path.join(lockdeps, "node_modules", p);
  plan.push(
    {
      name: "lockdeps",
      cwd: dir,
      cmd: [
        "npm",
        "install",
        "--prefix",
        lockdeps,
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "semver@6.3.1",
      ],
    },
    {
      name: "validate-lock-edges",
      cwd: dir,
      cmd: ["node", "scripts/validate-lock-edges.mjs"],
      env: { NODE_PATH: path.dirname(nm("x")) },
    },
  );
  if (lockChanged) {
    plan.push({
      name: "npm-ci",
      cwd: dir,
      cmd: ["npm", "ci", "--ignore-scripts", "--engine-strict=false"],
      heavy: true,
      when: "package-lock.json differs from the cloned node_modules",
    });
  }
  plan.push(
    // `npm ci --ignore-scripts` skips `prepare` (husky); verify's check-git-hooks needs .husky/_ to exist.
    { name: "husky", cwd: dir, cmd: ["npx", "husky"] },
    {
      name: "prisma-generate",
      cwd: path.join(dir, "apps/api"),
      cmd: ["npx", "prisma", "generate"],
    },
    {
      name: "verify",
      cwd: dir,
      cmd: ["npm", "run", "verify"],
      env: {
        VERIFY_EXCLUDE: "@routeflow/control",
        JEST_MAX_WORKERS: "2",
        VERIFY_CONCURRENCY: "1",
        TURBO_FORCE: "true",
      },
      heavy: true,
    },
    { name: "audit-critical", cwd: dir, cmd: ["node", "scripts/ci-audit-critical.mjs"] },
    {
      name: "audit-high-report",
      cwd: dir,
      cmd: ["node", "scripts/ci-audit-critical.mjs", "--level", "high", "--report-only"],
      advisory: true,
    },
  );
  if (dbLane) {
    plan.push(
      {
        name: "lint-migrations",
        cwd: dir,
        cmd: ["node", "scripts/lint-migrations.mjs", "--base", "origin/master"],
        when: "diff touches the Prisma / DB-lane paths",
      },
      {
        name: "db-replay",
        cwd: dir,
        cmd: [
          "node",
          "scripts/local-db-specs.mjs",
          "--",
          "npm run db:drift -w apps/api && npm run test:db -w apps/api",
        ],
        heavy: false, // local-db-specs takes the heavy slot itself
        when: "diff touches the Prisma / DB-lane paths",
      },
    );
  }
  return plan;
}

/** Runs steps in order; stops at the first non-advisory failure (later non-advisory steps are skipped). */
export async function runSteps({ steps, exec, now = Date.now, log = () => {} }) {
  const t0 = now();
  const out = [];
  let failedStep = null;
  for (const step of steps) {
    if (failedStep && !step.advisory) {
      out.push({ name: step.name, status: "skipped", ms: 0, exit: null });
      continue;
    }
    const s0 = now();
    let r;
    try {
      r = await exec(step);
    } catch (e) {
      r = { status: 1, error: e };
    }
    const ok = r.status === 0;
    out.push({
      name: step.name,
      status: ok ? "pass" : "fail",
      ms: now() - s0,
      exit: r.status ?? null,
    });
    log(
      `local-ci: ${step.name} ${ok ? "ok" : `FAILED (exit ${r.status})`}${step.advisory && !ok ? " [advisory]" : ""}`,
    );
    if (!ok && !step.advisory) failedStep = step.name;
  }
  return { ok: failedStep === null, failedStep, durationMs: now() - t0, steps: out };
}

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

export function statusPayload({ ok, durationMs, failedStep }) {
  const d = fmtDuration(durationMs);
  const step = String(failedStep).slice(0, 60);
  const description = ok ? `passed in ${d}` : `failed at ${step} after ${d}`;
  return {
    context: STATUS_CONTEXT,
    state: ok ? "success" : "failure",
    description: description.slice(0, 140),
  };
}

// ---------------------------------------------------------------------------------------------
// Side-effecting orchestration (not exercised by the self-test; the dry run and a real run cover it)
// ---------------------------------------------------------------------------------------------

const q = (a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeExec({ logStream, env }) {
  return async (step) => {
    logStream.write(`\n$ (cd ${step.cwd}) ${step.cmd.map(q).join(" ")}\n`);
    if (step.cmd[0] === "cp") {
      // `cp -R` is not on a plain Windows PATH; copy natively (same result: a real clone, no junction).
      const [src, dst] = step.cmd.slice(-2);
      fs.cpSync(src, dst, { recursive: true });
      return { status: 0 };
    }
    const win = process.platform === "win32";
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(
          step.cmd[0],
          step.cmd.slice(1).map((a) => (win ? q(a) : a)),
          {
            cwd: step.cwd,
            env: { ...process.env, ...env, ...(step.env ?? {}), CI: "" },
            shell: win,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const tee = (chunk) => {
          logStream.write(chunk);
          process.stdout.write(chunk);
        };
        child.stdout.on("data", tee);
        child.stderr.on("data", tee);
        child.on("error", (error) => resolve({ status: 1, error }));
        child.on("exit", (status) => resolve({ status: status ?? 1 }));
      });
    if (!step.heavy) return run();
    return withHeavySlot({ label: `local-ci-${env.LOCAL_CI_PR}`, branch: "local-ci" }, async () => {
      const r = await run();
      return Object.assign(r, { valueOf: () => r.status });
    });
  };
}

function removeWorktree(repo, dir, log) {
  // Junctions first (a worktree remove deletes THROUGH a junction into its target), never --force.
  for (const rel of discoverNodeModules(dir)) {
    const p = path.join(dir, rel, "node_modules");
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.rmdirSync(p);
    } catch {
      /* gone */
    }
  }
  const r = spawnSync("git", ["worktree", "remove", dir], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    log(`local-ci: worktree left in place (${r.stderr.trim()}); remove ${dir} by hand`);
  } else if (fs.existsSync(dir) && /^rf-lci-[0-9]+$/.test(path.basename(dir))) {
    // git leaves ignored files (the cloned node_modules) behind; the links are already gone, so this is safe.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(
      `local-ci: ${e.message}\nusage: node scripts/local-ci.mjs --pr N [--from W] [--no-status] [--keep] [--dry] | --self-test`,
    );
    return 2;
  }
  if (o.selfTest) {
    return (
      spawnSync(process.execPath, ["--test", path.join(HERE, "local-ci.test.mjs")], {
        stdio: "inherit",
      }).status ?? 1
    );
  }
  const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const from = path.resolve(o.from ?? repo);
  const dir = path.resolve(repo, "..", `rf-lci-${o.pr}`);
  const log = (m) => console.error(m);

  if (o.dry) {
    const plan = planLocalCi({
      mergeSha: "<refs/pull/N/merge sha>",
      dir,
      from,
      lockdeps: path.join("local-assets", "local-ci", `${o.pr}-<sha>`, "lockdeps"),
      lockChanged: true,
      dbLane: true,
      platform: process.platform,
    });
    console.log(`local-ci plan for PR #${o.pr} (node ${process.version}, CI pins 24):`);
    for (const s of plan) {
      const tags = [
        s.heavy ? "heavy-slot" : null,
        s.advisory ? "advisory" : null,
        s.when ? `if ${s.when}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`  ${s.name.padEnd(20)} ${s.cmd.map(q).join(" ")}${tags ? `   [${tags}]` : ""}`);
    }
    console.log(
      `  then: gh api repos/${REPO_SLUG}/statuses/<head sha> (context ${STATUS_CONTEXT}), remove worktree`,
    );
    return 0;
  }

  // Fetch the exact tree GitHub CI tests, plus the base.
  git(repo, [
    "fetch",
    "origin",
    "master",
    `+refs/pull/${o.pr}/merge:refs/local-ci/${o.pr}/merge`,
    `+refs/pull/${o.pr}/head:refs/local-ci/${o.pr}/head`,
  ]);
  const mergeSha = git(repo, ["rev-parse", `refs/local-ci/${o.pr}/merge`]);
  const headSha = git(repo, ["rev-parse", `refs/local-ci/${o.pr}/head`]);
  const files = git(repo, ["diff", "--name-only", "origin/master", mergeSha])
    .split("\n")
    .filter(Boolean);
  const lockChanged =
    git(from, ["hash-object", "package-lock.json"]) !==
    git(repo, ["rev-parse", `${mergeSha}:package-lock.json`]);
  const outDir = path.join(repo, "local-assets", "local-ci", resultDirName(o.pr, headSha));
  fs.mkdirSync(outDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(outDir, "local-ci.log"));
  const plan = planLocalCi({
    mergeSha,
    dir,
    from,
    lockdeps: path.join(outDir, "lockdeps"),
    lockChanged,
    dbLane: touchesDbLane(files),
    platform: process.platform,
  });
  const env = { RF_HEAVY_SLOTS: process.env.RF_HEAVY_SLOTS ?? "3", LOCAL_CI_PR: String(o.pr) };
  const result = await runSteps({ steps: plan, exec: makeExec({ logStream, env }), log });
  const payload = statusPayload(result);
  fs.writeFileSync(
    path.join(outDir, "result.json"),
    JSON.stringify(
      {
        pr: o.pr,
        headSha,
        mergeSha,
        node: process.version,
        ciNode: "24",
        platform: process.platform,
        dbLane: touchesDbLane(files),
        lockChanged,
        ...result,
        status: payload,
      },
      null,
      2,
    ),
  );
  logStream.end();
  if (!o.noStatus) {
    const r = spawnSync(
      "gh",
      [
        "api",
        `repos/${REPO_SLUG}/statuses/${headSha}`,
        "-f",
        `state=${payload.state}`,
        "-f",
        `context=${payload.context}`,
        "-f",
        `description=${payload.description}`,
      ],
      { encoding: "utf8" },
    );
    log(
      r.status === 0
        ? `local-ci: posted ${payload.context} ${payload.state} on ${headSha.slice(0, 9)}`
        : `local-ci: status post FAILED: ${r.stderr.trim()}`,
    );
  }
  if (!o.keep) removeWorktree(repo, dir, log);
  log(`local-ci: PR #${o.pr} ${payload.state} - ${payload.description}; results in ${outDir}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
