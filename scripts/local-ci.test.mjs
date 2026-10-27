// node --test scripts/local-ci.test.mjs — contract tests for scripts/local-ci.mjs (no network, steps stubbed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  describeTree,
  parseWorkflowPaths,
  touchesDbLane,
  installIsStale,
  buildStepEnv,
  findLinks,
  removeAllLinks,
  linksInto,
  badWorkspaceLinks,
  relinkWorkspace,
  retargetLinks,
  planLocalCi,
  runSteps,
  statusPayload,
  resultDirName,
  worktreeDirName,
  assertMergeTestsHead,
  isOwnWorktreeDir,
  main,
} from "./local-ci.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = {
  mergeSha: "m".repeat(40),
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
  dir: "/w/local-ci-3700",
  from: "/r/main",
  lockdeps: "/out/lockdeps",
  installStale: false,
  dbLane: false,
  platform: "win32",
};
const names = (plan) => plan.map((s) => s.name);

test("parseArgs: --pr is required and numeric; flags parse", () => {
  assert.deepEqual(parseArgs(["--pr", "12"]).pr, 12);
  assert.equal(parseArgs(["--pr", "12", "--dry"]).dry, true);
  assert.equal(parseArgs(["--self-test"]).selfTest, true);
  assert.throws(() => parseArgs([]), /--pr/);
  assert.throws(() => parseArgs(["--pr", "x1"]), /--pr/);
  assert.throws(() => parseArgs(["--pr", "1", "--bogus"]), /unknown/);
});

test("plan mirrors ci.yml Verify order", () => {
  const n = names(planLocalCi(base)).filter((x) => !x.startsWith("worktree:"));
  assert.deepEqual(n, [
    "retarget-links",
    "lockdeps",
    "validate-lock-edges",
    "husky",
    "prisma-generate",
    "verify",
    "audit-critical",
    "audit-high-report",
  ]);
});

test("worktree is a detached checkout of the merge ref; links are retargeted before the build", () => {
  const plan = planLocalCi(base);
  const add = plan.find((s) => s.cmd?.[0] === "git" && s.cmd[1] === "worktree");
  assert.ok(add.cmd.includes("--detach"));
  assert.ok(!add.cmd.includes("-b"));
  assert.equal(add.cmd.at(-1), base.mergeSha);
  const n = names(plan);
  assert.ok(n.indexOf("retarget-links") > n.indexOf("worktree:1"));
  const build = plan.find((s) => s.cmd?.[0] === "npx" && s.heavy);
  assert.ok(n.indexOf("retarget-links") < plan.indexOf(build));
});

test("every step has a timeout", () => {
  for (const s of planLocalCi({ ...base, installStale: true, dbLane: true })) {
    assert.ok(s.timeoutMs > 0, `${s.name} has no timeout`);
  }
});

test("verify runs with the CI env inside the heavy slot", () => {
  const v = planLocalCi(base).find((s) => s.name === "verify");
  assert.equal(v.env.VERIFY_EXCLUDE, "@routeflow/control");
  assert.equal(v.env.JEST_MAX_WORKERS, "2");
  assert.equal(v.heavy, true);
  assert.deepEqual(v.cmd, ["npm", "run", "verify"]);
});

test("validate-lock-edges gets NODE_PATH from the lockdeps install", () => {
  const s = planLocalCi(base).find((x) => x.name === "validate-lock-edges");
  assert.match(s.env.NODE_PATH.replace(/\\/g, "/"), /out\/lockdeps\/node_modules$/);
});

test("npm ci runs only when the install is stale, always --ignore-scripts, then husky", () => {
  assert.ok(!names(planLocalCi(base)).includes("npm-ci"));
  const plan = planLocalCi({ ...base, installStale: true });
  const ci = plan.find((s) => s.name === "npm-ci");
  assert.ok(ci.cmd.includes("--ignore-scripts"));
  assert.ok(ci.heavy);
  const n = names(plan);
  assert.ok(n.indexOf("npm-ci") < n.indexOf("husky"));
  assert.ok(n.indexOf("husky") < n.indexOf("prisma-generate"));
});

test("installIsStale: package.json change without a lockfile change still counts (MEDIUM 7)", () => {
  assert.equal(
    installIsStale([
      { path: "package-lock.json", merge: "a", local: "a" },
      { path: "apps/api/package.json", merge: "b", local: "b" },
    ]),
    false,
  );
  assert.equal(
    installIsStale([
      { path: "package-lock.json", merge: "a", local: "a" },
      { path: "apps/api/package.json", merge: "b", local: "c" },
    ]),
    true,
  );
  assert.equal(
    installIsStale([{ path: "packages/x/package.json", merge: "b", local: null }]),
    true,
  );
});

test("db lane steps are added only when the diff touches the lane", () => {
  assert.ok(!names(planLocalCi(base)).includes("db-replay"));
  const plan = planLocalCi({ ...base, dbLane: true });
  assert.ok(names(plan).includes("lint-migrations"));
  const db = plan.find((s) => s.name === "db-replay");
  assert.match(db.cmd.join(" "), /local-db-specs\.mjs/);
  assert.ok(db.heavy === false, "local-db-specs takes its own slot");
  assert.equal(db.env.CI, "", "CI would bypass the heavy slot inside local-db-specs");
});

test("parseWorkflowPaths reads pull_request.paths and skips comments", () => {
  const y = [
    "on:",
    "  pull_request:",
    "    # note",
    "    paths:",
    '      - "apps/api/prisma/**"',
    "      # inline note",
    "      - apps/api/src/invoices/invoices.service.ts",
    "",
    "      - '.github/workflows/db-migrations.yml'",
    "  push:",
    "    paths:",
    "      - nope",
  ].join("\n");
  assert.deepEqual(parseWorkflowPaths(y), [
    "apps/api/prisma/**",
    "apps/api/src/invoices/invoices.service.ts",
    ".github/workflows/db-migrations.yml",
  ]);
});

test("touchesDbLane matches globs from the workflow, incl. ** and exact files", () => {
  const globs = [
    "apps/api/prisma/**",
    "apps/api/src/**/*.db.spec.ts",
    "apps/api/src/a/b.service.ts",
  ];
  assert.equal(touchesDbLane(["apps/api/prisma/schema/sales.prisma"], globs), true);
  assert.equal(touchesDbLane(["apps/api/src/x/y/z.db.spec.ts"], globs), true);
  assert.equal(touchesDbLane(["apps/api/src/a/b.service.ts"], globs), true);
  assert.equal(touchesDbLane(["apps/api/src/a/c.service.ts", "README.md"], globs), false);
});

test("DRIFT: every pull_request path in the real db-migrations.yml triggers the lane", () => {
  const yml = fs.readFileSync(path.join(HERE, "..", ".github/workflows/db-migrations.yml"), "utf8");
  const globs = parseWorkflowPaths(yml);
  assert.ok(globs.length >= 10, `parsed only ${globs.length} paths`);
  for (const g of globs) {
    const sample = g
      .replace(/\*\*\//g, "d/")
      .replace(/\*\*/g, "x/y")
      .replace(/\*/g, "x");
    assert.equal(touchesDbLane([sample], globs), true, `${g} (as ${sample}) does not trigger`);
  }
});

test("buildStepEnv: no tokens reach PR code; CI=true; step env wins (LOW 8)", () => {
  const env = buildStepEnv(
    {
      PATH: "/bin",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "y",
      NPM_TOKEN: "z",
      RAILWAY_TOKEN: "r",
      DB_PASSWORD: "p",
      HOME: "/h",
    },
    { env: { NODE_PATH: "/n" } },
    { RF_X: "1" },
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(env.CI, "true");
  assert.equal(env.NODE_PATH, "/n");
  assert.equal(env.RF_X, "1");
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "RAILWAY_TOKEN", "DB_PASSWORD"]) {
    assert.ok(!(k in env), `${k} leaked`);
  }
  assert.equal(buildStepEnv({}, { env: { CI: "" } }).CI, "");
});

// ---- links: a copied node_modules must never let removal reach the main checkout (HIGH 1/2) ----

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lci-"));
  const main = path.join(root, "main");
  const wt = path.join(root, "rf-lci-1");
  fs.mkdirSync(path.join(main, "packages/pricing"), { recursive: true });
  fs.writeFileSync(path.join(main, "packages/pricing/keep.txt"), "tracked");
  fs.mkdirSync(path.join(wt, "packages/pricing"), { recursive: true });
  fs.mkdirSync(path.join(wt, "node_modules/@routeflow"), { recursive: true });
  fs.mkdirSync(path.join(wt, "apps/api/node_modules/deep"), { recursive: true });
  return { root, main, wt };
}

test("removeAllLinks removes nested junctions without touching their targets", () => {
  const { root, main, wt } = makeTree();
  fs.symlinkSync(
    path.join(main, "packages/pricing"),
    path.join(wt, "node_modules/@routeflow/pricing"),
    "junction",
  );
  fs.symlinkSync(
    path.join(main, "packages"),
    path.join(wt, "apps/api/node_modules/deep/pk"),
    "junction",
  );
  assert.equal(findLinks(wt).length, 2, "nested links are found");
  const left = removeAllLinks(wt);
  assert.deepEqual(left, []);
  assert.equal(fs.readFileSync(path.join(main, "packages/pricing/keep.txt"), "utf8"), "tracked");
  fs.rmSync(root, { recursive: true, force: true });
});

test("retargetLinks points main-checkout links at the worktree's own packages", () => {
  const { root, main, wt } = makeTree();
  fs.symlinkSync(
    path.join(main, "packages/pricing"),
    path.join(wt, "node_modules/@routeflow/pricing"),
    "junction",
  );
  assert.equal(linksInto(wt, main).length, 1);
  assert.equal(retargetLinks(wt, main), 1);
  assert.equal(linksInto(wt, main).length, 0, "no link leaves the worktree");
  const real = fs.realpathSync(path.join(wt, "node_modules/@routeflow/pricing"));
  assert.equal(
    real.toLowerCase(),
    fs.realpathSync(path.join(wt, "packages/pricing")).toLowerCase(),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- run + status ----

test("runSteps stops at the first failure; advisory steps still run", async () => {
  const calls = [];
  const r = await runSteps({
    steps: [
      { name: "a", cmd: ["x"] },
      { name: "b", cmd: ["x"], gate: true },
      { name: "c", cmd: ["x"] },
      { name: "adv", cmd: ["x"], advisory: true },
    ],
    exec: async (s) => {
      calls.push(s.name);
      return { status: s.name === "b" ? 1 : 0 };
    },
    now: () => 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, "b");
  assert.equal(r.infra, false, "a gate step failing is a real verdict");
  assert.deepEqual(calls, ["a", "b", "adv"]);
  assert.equal(r.steps.find((s) => s.name === "c").status, "skipped");
});

test("runSteps: a non-gate failure or a timeout is infrastructure, not a verdict (MEDIUM 6)", async () => {
  const setup = await runSteps({
    steps: [{ name: "lockdeps", cmd: ["x"] }],
    exec: async () => ({ status: 1 }),
    now: () => 0,
  });
  assert.equal(setup.infra, true);
  const slow = await runSteps({
    steps: [{ name: "verify", cmd: ["x"], gate: true }],
    exec: async () => ({ status: 124, timedOut: true }),
    now: () => 0,
  });
  assert.equal(slow.infra, true);
});

test("runSteps: a throwing exec is a failed step, a failing advisory step leaves the run green", async () => {
  const r = await runSteps({
    steps: [
      { name: "a", cmd: ["x"] },
      { name: "adv", cmd: ["x"], advisory: true },
    ],
    exec: async (s) => ({ status: s.name === "adv" ? 1 : 0 }),
    now: () => 0,
  });
  assert.equal(r.ok, true);
  const t = await runSteps({
    steps: [{ name: "a", cmd: ["x"] }],
    exec: async () => {
      throw new Error("boom");
    },
    now: () => 0,
  });
  assert.equal(t.ok, false);
});

test("statusPayload: success | failure (gate) | error (harness), within 140 chars", () => {
  const ok = statusPayload({ ok: true, durationMs: 754_000, failedStep: null });
  assert.equal(ok.context, "local-ci/verify");
  assert.equal(ok.state, "success");
  assert.match(ok.description, /12m34s/);
  const bad = statusPayload({ ok: false, durationMs: 61_000, failedStep: "x".repeat(300) });
  assert.equal(bad.state, "failure");
  assert.ok(bad.description.length <= 140);
  assert.match(bad.description, /1m01s/);
  const infra = statusPayload({ ok: false, durationMs: 1000, failedStep: "lockdeps", infra: true });
  assert.equal(infra.state, "error");
  assert.ok(infra.description.length <= 140);
});

test("resultDirName is <pr>-<short sha>", () => {
  assert.equal(resultDirName(3700, base.headSha), "3700-abcdef123456");
});

test("buildStepEnv keeps the local compose POSTGRES_* vars but still strips other secrets", () => {
  const env = buildStepEnv({
    POSTGRES_PASSWORD: "pass",
    POSTGRES_USER: "u",
    DB_PASSWORD: "p",
    FOO_TOKEN: "t",
  });
  assert.equal(env.POSTGRES_PASSWORD, "pass");
  assert.equal(env.POSTGRES_USER, "u");
  assert.ok(!("DB_PASSWORD" in env) && !("FOO_TOKEN" in env));
});

test("badWorkspaceLinks flags an @routeflow entry copied as a directory, or linking outside", () => {
  const { root, main, wt } = makeTree();
  const scope = path.join(wt, "node_modules/@routeflow");
  fs.symlinkSync(path.join(wt, "packages/pricing"), path.join(scope, "ok"), "junction");
  assert.deepEqual(badWorkspaceLinks(wt), []);
  fs.mkdirSync(path.join(scope, "inlined"));
  fs.symlinkSync(path.join(main, "packages/pricing"), path.join(scope, "outside"), "junction");
  assert.equal(badWorkspaceLinks(wt).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("relinkWorkspace turns an inlined @routeflow copy back into a junction into the worktree", () => {
  const { root, main, wt } = makeTree();
  fs.mkdirSync(path.join(main, "node_modules/@routeflow"), { recursive: true });
  fs.symlinkSync(
    path.join(main, "packages/pricing"),
    path.join(main, "node_modules/@routeflow/pricing"),
    "junction",
  );
  const inl = path.join(wt, "node_modules/@routeflow/pricing");
  fs.mkdirSync(inl);
  fs.writeFileSync(path.join(inl, "copy.txt"), "x");
  assert.equal(badWorkspaceLinks(wt).length, 1);
  assert.equal(relinkWorkspace(wt, main), 1);
  assert.deepEqual(badWorkspaceLinks(wt), []);
  assert.equal(fs.readFileSync(path.join(main, "packages/pricing/keep.txt"), "utf8"), "tracked");
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree mode: default is GitHub's merge ref; --head and --fresh are exclusive", () => {
  assert.equal(parseArgs(["--pr", "1"]).tree, "merge");
  assert.equal(parseArgs(["--pr", "1", "--head"]).tree, "head");
  assert.equal(parseArgs(["--pr", "1", "--fresh"]).tree, "fresh");
  assert.throws(() => parseArgs(["--pr", "1", "--head", "--fresh"]), /exclusive/);
});

test("describeTree flags a merge ref that lacks the master tip as stale", () => {
  const a = { mergeSha: "m", headSha: "h" };
  assert.deepEqual(describeTree({ ...a, mode: "merge", masterInMerge: true }), {
    sha: "m",
    label: "github-merge-ref",
    stale: false,
  });
  assert.equal(describeTree({ ...a, mode: "merge", masterInMerge: false }).stale, true);
  assert.equal(describeTree({ ...a, mode: "head" }).sha, "h");
  assert.equal(describeTree({ ...a, mode: "fresh" }).label, "fresh-merge");
});

test("assertMergeTestsHead: the tested merge commit's second parent must be the PR head (MUST 1)", () => {
  const head = "h".repeat(40);
  // GitHub's merge ref lagging a push: ^2 is an older head, so a green here would be stamped on the wrong sha
  assert.throws(
    () =>
      assertMergeTestsHead({
        mode: "merge",
        mergeSha: "m".repeat(40),
        headSha: head,
        secondParent: "o".repeat(40),
      }),
    /second parent/,
  );
  assert.throws(
    () =>
      assertMergeTestsHead({
        mode: "merge",
        mergeSha: "m".repeat(40),
        headSha: head,
        secondParent: null,
      }),
    /second parent/,
  );
  assert.doesNotThrow(() =>
    assertMergeTestsHead({
      mode: "merge",
      mergeSha: "m".repeat(40),
      headSha: head,
      secondParent: head,
    }),
  );
  assert.doesNotThrow(() =>
    assertMergeTestsHead({
      mode: "fresh",
      mergeSha: "m".repeat(40),
      headSha: head,
      secondParent: head,
    }),
  );
  assert.throws(
    () =>
      assertMergeTestsHead({
        mode: "fresh",
        mergeSha: "m".repeat(40),
        headSha: head,
        secondParent: "o".repeat(40),
      }),
    /second parent/,
  );
  // --head tests the head commit itself: no merge commit, nothing to compare
  assert.doesNotThrow(() =>
    assertMergeTestsHead({ mode: "head", mergeSha: head, headSha: head, secondParent: null }),
  );
});

test("worktreeDirName is unique per pr + head sha + pid (MUST 3)", () => {
  const a = worktreeDirName("/r", 3709, "abcdef1234567890abcdef", 111);
  assert.equal(path.basename(a), "rf-lci-3709-abcdef123456-111");
  assert.notEqual(a, worktreeDirName("/r", 3709, "abcdef1234567890abcdef", 222));
  assert.notEqual(a, worktreeDirName("/r", 3709, "fedcba1234567890abcdef", 111));
  assert.notEqual(a, worktreeDirName("/r", 3710, "abcdef1234567890abcdef", 111));
  assert.equal(path.dirname(a), path.resolve("/r", ".."));
});

test("local-ci does not set its own RF_HEAVY_SLOTS default; heavy-slot's applies (MUST 2)", async () => {
  const src = fs.readFileSync(path.join(HERE, "local-ci.mjs"), "utf8");
  assert.doesNotMatch(src, /process\.env\.RF_HEAVY_SLOTS\s*(\?\?|\|\||=)/);
  const { parseSlots, DEFAULT_SLOTS } = await import("./lib/heavy-slot.mjs");
  assert.equal(parseSlots(undefined), DEFAULT_SLOTS);
});

// ---------------------------------------------------------------------------------------------
// main()-level wiring (deps stubbed): each test goes red if the wiring it pins is reverted
// ---------------------------------------------------------------------------------------------

const HEAD = "a".repeat(40);
const MASTER = "b".repeat(40);
const MERGE = "c".repeat(40);
const DB_WORKFLOW = "on:\n  pull_request:\n    paths:\n      - apps/api/prisma/**\n";

/** Runs main() against a throwaway repo dir with every side effect stubbed; returns what it did. */
async function runMain({
  stale = false,
  leftover = false,
  args = ["--pr", "9999", "--no-status"],
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lci-main-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const dir = worktreeDirName(repo, 9999, HEAD, process.pid);
  const seen = { stepsRan: 0, removed: [], messages: [] };
  let ran = false;
  const realError = console.error;
  console.error = (m) => seen.messages.push(String(m));
  try {
    seen.code = await main(args, {
      git: (cwd, a) => {
        if (a[0] === "rev-parse" && a[1] === "--show-toplevel") return repo;
        if (a[0] === "rev-parse" && a[1] === "origin/master") return MASTER;
        if (a[0] === "rev-parse" && a[1] === "refs/local-ci/9999/head") return HEAD;
        if (a[0] === "rev-parse" && a[1] === "refs/local-ci/9999/merge") return MERGE;
        if (a[0] === "show") return DB_WORKFLOW;
        return "";
      },
      gitOrNull: (cwd, a) => (a[1] === `${MERGE}^2` ? HEAD : null),
      spawnSync: (cmd, a) => {
        if (cmd === "git" && a[0] === "merge-base") return { status: stale ? 1 : 0 };
        return { status: 0, stderr: "" };
      },
      installEntries: () => [],
      existsSync: (p) => (p === dir ? leftover || ran : fs.existsSync(p)),
      runSteps: async () => {
        seen.stepsRan++;
        ran = true;
        return { ok: true, failedStep: null, infra: false, durationMs: 1, steps: [] };
      },
      makeExec: () => async () => ({ status: 0 }),
      removeWorktree: (r, d) => {
        seen.removed.push(d);
        return true;
      },
    });
  } finally {
    console.error = realError;
    await new Promise((r) => setTimeout(r, 100)); // let the log stream finish opening/closing
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  seen.dir = dir;
  return seen;
}

test("main refuses a stale GitHub merge ref: exit 2, no step runs, no status (MUST 1)", async () => {
  const r = await runMain({ stale: true });
  assert.equal(r.code, 2);
  assert.equal(r.stepsRan, 0);
  assert.deepEqual(r.removed, []);
  assert.match(r.messages.join("\n"), /stale/);
  assert.match(r.messages.join("\n"), /--fresh/);
});

test("main on a fresh merge ref runs the steps and removes only the worktree it made (MUST 2)", async () => {
  const r = await runMain({ stale: false });
  assert.equal(r.code, 0);
  assert.equal(r.stepsRan, 1);
  assert.deepEqual(r.removed, [r.dir]);
});

test("main aborts on a leftover worktree dir and never removes it (MUST 2)", async () => {
  const r = await runMain({ leftover: true });
  assert.equal(r.code, 2);
  assert.equal(r.stepsRan, 0, "no step may run on top of another run's directory");
  assert.deepEqual(r.removed, [], "a directory this run did not create is never removed");
  assert.match(r.messages.join("\n"), /already exists/);
});

test("main --keep leaves the worktree it made (MUST 2)", async () => {
  const r = await runMain({ args: ["--pr", "9999", "--no-status", "--keep"] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.removed, []);
});

test("the recursive-delete fallback is gated on THIS run's own directory only (MUST 3)", () => {
  const repo = path.join(path.sep, "w", "repo");
  const own = worktreeDirName(repo, 3709, HEAD, process.pid);
  assert.equal(isOwnWorktreeDir(repo, own), true);
  // another run's pid, the old rf-lci-<pid> shape, a different parent and a prefix trick are all refused
  assert.equal(isOwnWorktreeDir(repo, worktreeDirName(repo, 3709, HEAD, process.pid + 1)), false);
  assert.equal(isOwnWorktreeDir(repo, path.join(repo, "..", `rf-lci-${process.pid}`)), false);
  assert.equal(isOwnWorktreeDir(repo, path.join(repo, "..", "x", path.basename(own))), false);
  assert.equal(isOwnWorktreeDir(repo, path.join(repo, "..", `${path.basename(own)}0`)), false);
});

test("removeWorktree source: removeAllLinks runs before any recursive delete (MUST 3)", () => {
  const src = fs.readFileSync(path.join(HERE, "local-ci.mjs"), "utf8");
  const body = src.slice(src.indexOf("export function removeWorktree"));
  assert.ok(body.indexOf("removeAllLinks(dir)") < body.indexOf("fs.rmSync(dir"));
  assert.match(body, /isOwnWorktreeDir\(repo, dir\)/);
});
