#!/usr/bin/env node
/**
 * Self-test for the affected-scope pre-push (scripts/lib/verify-scope.mjs + verify-turbo.mjs).
 * Runs against the REAL workspace graph of this repo — not a hand-typed fixture — so a new
 * dependency edge or a renamed package is caught here, not by a false-green push.
 *
 * S1: a change under packages/pricing selects api + web + mobile + scanning (its dependents) + itself.
 * S2: a change confined to apps/api selects only api + the always-run pricing tripwire.
 * S3: a change under packages/ui selects web (its dependent) and not api/mobile.
 * S4: a docs-only / code-map-only diff selects only the pricing tripwire (repo-truth always runs).
 * S5: files that feed every workspace force FULL — root manifest, lockfile, turbo.json, a
 *     workspace manifest, the hooks, the CI workflows, the campaign ledger.
 * S4c/S8: root scripts/hooks select api; a cross-workspace move reports both paths.
 * S9: the S8 fixture is inert against a hijacking GIT_DIR (B420) — proven on a decoy repo.
 * S6: affected scope is the DEFAULT on a feature branch; FULL under FULL_VERIFY=1 (the only
 *     override) / CI / master / main / detached HEAD / an uncomputable diff.
 * S7: the hook wiring — no env var narrows the run, separate verified-tree markers, and
 *     package.json's verify chain goes through verify-turbo.mjs.
 * S10: the tmp-root containment check is portable (POSIX and Windows path shapes, via path.win32).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import {
  changedFilesSince,
  computeScope,
  decideScope,
  loadWorkspaces,
  shortName,
  staleWorkspaces,
  withStale,
} from "./lib/verify-scope.mjs";
// Pure builders only — never `main`, which is side-effecting. Safe to import: verify-turbo.mjs's
// direct-execution guard means importing it does NOT spawn turbo or call process.exit.
import {
  buildArgv,
  buildTurboFlags,
  chooseVerifyDefaults,
  excludedLine,
  jestPassthrough,
  jestWorkerBudget,
  LOW_MEM_THRESHOLD_BYTES,
  VERIFY_EXCLUDE_ALLOWED,
  parseVerifyExclude,
  planTurboCalls,
} from "./verify-turbo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = loadWorkspaces(ROOT);

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const scopedNames = (files) => {
  const s = computeScope(files, workspaces);
  return s.mode === "scoped" ? s.workspaces.map(shortName) : `FULL (${s.reason})`;
};

check(
  "S0 the real graph has the five workspaces the chain depends on",
  ["api", "mobile", "pricing", "web"].every((n) => workspaces.some((w) => shortName(w.name) === n)),
  true,
);

check(
  "S1 packages/pricing change selects api + mobile + pricing + scanning + web",
  scopedNames(["packages/pricing/src/index.ts"]),
  ["api", "mobile", "pricing", "scanning", "web"],
);
check(
  "S2 apps/api-only change selects api + the pricing tripwire",
  scopedNames(["apps/api/src/orders/orders.service.ts"]),
  ["api", "pricing"],
);
check(
  "S3 packages/ui change selects web (+ pricing tripwire)",
  scopedNames(["packages/ui/src/web/Button.tsx"]),
  ["pricing", "ui", "web"],
);
check(
  "S4 docs-only diff selects only the pricing tripwire",
  scopedNames(["CLAUDE.md", ".claude/code-map/INDEX.md"]),
  ["pricing"],
);
check(
  "S4b two apps changed selects both",
  scopedNames(["apps/web/lib/a.ts", "apps/mobile/lib/b.ts"]),
  ["mobile", "pricing", "web"],
);

for (const f of [
  "package.json",
  "package-lock.json",
  "turbo.json",
  "apps/web/package.json",
  "packages/types/package.json",
  ".husky/pre-push",
  ".github/workflows/ci.yml",
  ".claude/campaign/status/F01.jsonl",
]) {
  check(`S5 ${f} forces FULL`, computeScope([f, "apps/api/src/x.ts"], workspaces).mode, "full");
}

check(
  "S4c root scripts/ and .claude/hooks/ pull api in (its plain test lane runs their specs)",
  [scopedNames(["scripts/campaign-check.mjs"]), scopedNames([".claude/hooks/stop.mjs"])],
  [
    ["api", "pricing"],
    ["api", "pricing"],
  ],
);

// S8: a cross-workspace MOVE must report both paths (git's default rename detection would hide
// the source). Runs in a scratch repo under os.tmpdir() — and it must NEVER be able to touch the
// real one: this file runs inside the pre-push hook, which exports GIT_DIR/GIT_INDEX_FILE/
// GIT_WORK_TREE, and those override `cwd` (the B420 hijack: an earlier version of this block
// committed a fixture "base"/"move" onto the real branch and wrote core.bare + user "t" into the
// real .git/config). So: every git spawn below gets a GIT_*-free env, the fixture identity is
// passed as `-c` flags (no `git config` writes at all), and no write happens until
// `git rev-parse --show-toplevel` proves the repo git resolves IS the fixture dir.
/**
 * Is `p` strictly inside `root`? Portable: `path.relative` handles either separator and drive
 * letters, unlike a `startsWith(`${root}/`)` string test (POSIX-only — it threw on every Windows
 * push). `pathImpl` lets the S10 cases below exercise the win32 rules on any host.
 */
function isUnder(root, p, pathImpl = path) {
  const rel = pathImpl.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !pathImpl.isAbsolute(rel);
}

const fixtureEnv = () => ({
  ...scrubbedGitEnv(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});
const IDENT = ["-c", "user.name=verify-scope-fixture", "-c", "user.email=fixture@invalid"];

function runMoveFixture() {
  const tmpRoot = realpathSync(tmpdir());
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "verify-scope-")));
  const run = (...args) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", env: fixtureEnv() });
  const out = { moved: null, unresolvable: undefined, guard: null };
  try {
    if (!isUnder(tmpRoot, dir)) throw new Error(`fixture ${dir} is not under ${tmpRoot}`);
    run("init", "-q", "-b", "master");
    const top = realpathSync(run("rev-parse", "--show-toplevel").stdout.trim());
    out.guard = top === dir;
    if (!out.guard) return out; // git resolved somewhere else — write NOTHING
    mkdirSync(join(dir, "apps/web/lib"), { recursive: true });
    mkdirSync(join(dir, "apps/mobile/lib"), { recursive: true });
    writeFileSync(join(dir, "apps/web/lib/x.ts"), "export const x = 1;\n".repeat(20));
    run("add", "-A");
    run(...IDENT, "commit", "-q", "-m", "base");
    run("update-ref", "refs/remotes/origin/master", "HEAD");
    run("checkout", "-q", "-b", "feat/move");
    run("mv", "apps/web/lib/x.ts", "apps/mobile/lib/x.ts");
    run(...IDENT, "commit", "-q", "-am", "move");
    out.moved = changedFilesSince(dir)?.sort();
    out.unresolvable = changedFilesSince(dir, "origin/does-not-exist");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const r = runMoveFixture();
  check(
    "S8 the fixture repo git resolves is the fixture dir (guard before any write)",
    r.guard,
    true,
  );
  check("S8 a web->mobile move reports both the old and the new path", r.moved, [
    "apps/mobile/lib/x.ts",
    "apps/web/lib/x.ts",
  ]);
  check(
    "S8b changedFilesSince is null (=> FULL) when origin/master is unresolvable",
    r.unresolvable,
    null,
  );
}

// S9: inertness. With GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE exported (as in a pre-push hook)
// and pointing at a DECOY repo, the fixture run must leave the decoy untouched — no commits, no
// refs, no core.bare, no identity in its config. (A decoy, not the real repo: if the scrub ever
// regressed, this check must fail without damaging anything that matters.)
{
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), "verify-scope-decoy-")));
  const g = (...args) =>
    spawnSync("git", args, { cwd: decoy, encoding: "utf8", env: fixtureEnv() }).stdout.trim();
  const saved = {};
  const hijack = {
    GIT_DIR: join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(decoy, ".git", "index"),
  };
  try {
    g("init", "-q", "-b", "master");
    const before = readFileSync(join(decoy, ".git", "config"), "utf8");
    for (const [k, v] of Object.entries(hijack)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const r = runMoveFixture();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    check("S9 the fixture still ran correctly under a hijacking GIT_DIR", r.moved, [
      "apps/mobile/lib/x.ts",
      "apps/web/lib/x.ts",
    ]);
    check("S9 decoy repo has no commits", g("rev-list", "--all", "--count"), "0");
    check("S9 decoy repo has no refs", g("for-each-ref"), "");
    check(
      "S9 decoy .git/config is byte-identical (no core.bare, no fixture identity)",
      readFileSync(join(decoy, ".git", "config"), "utf8"),
      before,
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(decoy, { recursive: true, force: true });
  }
}

const gitRoot = ROOT;
const someFiles = ["apps/web/lib/a.ts"];
check(
  "S6a FULL_VERIFY=1 is the only override -> full",
  decideScope(gitRoot, { FULL_VERIFY: "1" }, { branch: "feat/x", files: someFiles }).reason,
  "FULL_VERIFY=1",
);
check(
  "S6b CI -> full",
  decideScope(gitRoot, { CI: "true" }, { branch: "feat/x", files: someFiles }).reason,
  "CI",
);
for (const b of ["master", "main", "HEAD"]) {
  check(
    `S6c branch ${b} -> full`,
    decideScope(gitRoot, {}, { branch: b, files: someFiles }).mode,
    "full",
  );
}
const dflt = decideScope(gitRoot, {}, { branch: "feat/x", files: someFiles, stale: [] });
check(
  "S6d a feature branch with no env at all is SCOPED (the default)",
  [dflt.mode, dflt.workspaces?.map(shortName)],
  ["scoped", ["pricing", "web"]],
);
check(
  "S6e an uncomputable diff (files=null) -> full",
  decideScope(gitRoot, {}, { branch: "feat/x", files: null }).mode,
  "full",
);
check(
  "S6f a legacy VERIFY_SCOPE variable changes nothing (there is no ambient switch)",
  decideScope(gitRoot, { VERIFY_SCOPE: "full" }, { branch: "feat/x", files: someFiles, stale: [] })
    .mode,
  "scoped",
);

// ---- SP: stale campaign reports pull their workspace into an AFFECTED-scope run ----------------
// campaign-check refuses a missing/partial/stale report; a scoped push that never touched (say)
// apps/api would be refused for an api.json it had no reason to regenerate. The workspace is added
// so its tests run and rewrite the report — enforcement itself is untouched.
const webOnly = ["apps/web/lib/a.ts"];
const spStale = decideScope(
  gitRoot,
  {},
  { branch: "feat/x", files: webOnly, stale: ["@routeflow/api"] },
);
check(
  "SP1 a STALE api report is pulled into a web-only scoped run",
  [spStale.mode, spStale.workspaces.map(shortName), spStale.stale],
  ["scoped", ["api", "pricing", "web"], ["@routeflow/api"]],
);
const spFresh = decideScope(gitRoot, {}, { branch: "feat/x", files: webOnly, stale: [] });
check(
  "SP2 a FRESH api report is NOT pulled in (same diff, nothing stale)",
  [spFresh.workspaces.map(shortName), spFresh.stale],
  [["pricing", "web"], []],
);
const spInScope = decideScope(
  gitRoot,
  {},
  { branch: "feat/x", files: ["apps/api/src/a.ts"], stale: ["@routeflow/api"] },
);
check(
  "SP3 a stale workspace the diff already reaches is not duplicated or reported as pulled in",
  [spInScope.workspaces.map(shortName), spInScope.stale],
  [["api", "pricing"], []],
);
check(
  "SP4 stale reports never change a FULL decision",
  decideScope(
    gitRoot,
    { FULL_VERIFY: "1" },
    { branch: "feat/x", files: webOnly, stale: ["@routeflow/api"] },
  ),
  { mode: "full", reason: "FULL_VERIFY=1" },
);
check(
  "SP5 staleWorkspaces FAILS OPEN when campaign-check cannot answer (no script -> [])",
  staleWorkspaces(join(ROOT, "apps"), workspaces),
  [],
);
check(
  "SP6 withStale ignores a non-scoped decision and an empty/garbage list",
  [
    withStale({ mode: "full", reason: "x" }, ["@routeflow/api"]).mode,
    withStale({ mode: "scoped", workspaces: ["a"], changed: [] }, [null, ""]).stale,
  ],
  ["full", []],
);

const hook = readFileSync(join(ROOT, ".husky", "pre-push"), "utf8");
check("S7a the pre-push hook exports no scope variable", hook.includes("VERIFY_SCOPE"), false);
check(
  "S7b pre-push keeps a distinct verified-tree marker for scoped passes",
  hook.includes('tree_key="$tree:affected"'),
  true,
);
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
check(
  "S7c verify runs the turbo step through verify-turbo.mjs",
  pkg.scripts.verify.includes("node scripts/verify-turbo.mjs"),
  true,
);
check(
  "S7d verify no longer calls turbo directly for the test step",
  pkg.scripts.verify.includes("turbo run check-types lint test"),
  false,
);

// SP7/SP8: the two pins the stale-report addition depends on.
// SP7: `--print-stale` prints turbo PACKAGE names and decideScope keeps only names the workspace
// graph knows — a drift to short names ("api") would silently no-op the whole feature.
check(
  "SP7 the workspace graph carries the exact package names campaign-check --print-stale prints",
  ["@routeflow/api", "@routeflow/mobile", "@routeflow/pricing", "@routeflow/web"].every((n) =>
    workspaces.some((w) => w.name === n),
  ),
  true,
);
// SP8: adding a stale workspace to the filter regenerates its report only on a turbo cache MISS —
// on a HIT turbo replays without running jest. The `--freshness-only` pre-step forces a real run on
// a HIT, so it MUST come before verify-turbo in the verify chain; nothing else enforces the order.
{
  const chain = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.verify;
  const fresh = chain.indexOf("--freshness-only");
  const scoped = chain.indexOf("verify-turbo.mjs");
  check(
    "SP8 verify runs campaign-check --freshness-only BEFORE verify-turbo (forces a real run on a cache HIT)",
    fresh !== -1 && scoped !== -1 && fresh < scoped,
    true,
  );
}

// ---- WC: the JEST_MAX_WORKERS / VERIFY_CONCURRENCY worker/concurrency caps (2026-09-22 incident:
// an unbounded verify hit the Mac mini's memory kill line; `JEST_MAX_WORKERS` was told to lanes
// as the fix tonight before anything actually read it). Imports the pure builders — never `main`,
// which is side-effecting (spawns real processes, calls process.exit); the direct-execution guard
// at the bottom of verify-turbo.mjs is what makes this import safe at all. ------------------------
check(
  "WC1 buildTurboFlags(unset) is BYTE-IDENTICAL to the original hardcoded default",
  buildTurboFlags(""),
  ["--concurrency=2", "--continue=dependencies-successful"],
);
check(
  "WC2 buildTurboFlags narrows --concurrency when VERIFY_CONCURRENCY is set",
  buildTurboFlags("1"),
  ["--concurrency=1", "--continue=dependencies-successful"],
);
check(
  "WC3-SP-CONTINUE --continue=dependencies-successful is present at every concurrency value " +
    "(the property the full-tree-kill recovery note in verify-turbo.mjs's header depends on — " +
    "see that comment for why a live kill-mid-run respawn test was rejected in favour of this " +
    "static pin)",
  ["", "1", "2", "8"].every((c) =>
    buildTurboFlags(c).includes("--continue=dependencies-successful"),
  ),
  true,
);
check("WC4 jestPassthrough(unset) is [] — no passthrough at all", jestPassthrough(""), []);
check("WC5 jestPassthrough(set) forwards --maxWorkers, `--` first", jestPassthrough("4"), [
  "--",
  "--maxWorkers=4",
]);
check(
  "WC6 buildArgv with no passthrough (the default path) never emits a bare trailing '--'",
  buildArgv(["test"], buildTurboFlags("")),
  ["turbo", "run", "test", "--concurrency=2", "--continue=dependencies-successful"],
);
check(
  "WC7 buildArgv with a passthrough puts '--' + the jest flag AFTER every turbo flag",
  buildArgv(["test", "--filter=@routeflow/api"], buildTurboFlags("3"), jestPassthrough("4")),
  [
    "turbo",
    "run",
    "test",
    "--filter=@routeflow/api",
    "--concurrency=3",
    "--continue=dependencies-successful",
    "--",
    "--maxWorkers=4",
  ],
);
check(
  "WC8 the default (both env vars unset) end-to-end argv is IDENTICAL to the pre-fix hardcoded " +
    "invocation — this is the 'CI is bit-for-bit unchanged' claim, checked, not stated",
  buildArgv(["check-types", "lint", "test"], buildTurboFlags(""), jestPassthrough("")),
  [
    "turbo",
    "run",
    "check-types",
    "lint",
    "test",
    "--concurrency=2",
    "--continue=dependencies-successful",
  ],
);

// ---- WC9-15: chooseVerifyDefaults (B772) — a bare `git push` on the 16 GB Mac mini couldn't
// reach the 2026-09-22 memory-pressure incident line without the inline VERIFY_CONCURRENCY=1
// JEST_MAX_WORKERS=2 throttle, which lanes forgot twice in one night. Below 24 GB, default both
// when unset; an explicit env value always wins per variable independently; a >=24 GB host
// (CI, the PC) is byte-identical to today (both "", no message) when unset. --------------------
const GB = 1024 ** 3;
const MINI_MEM = 16 * GB;
const PC_MEM = 32 * GB;

check(
  "WC9 below 24 GB with no env set: both default, and the explanatory message names the host size",
  chooseVerifyDefaults({ totalMemBytes: MINI_MEM, env: {} }),
  {
    verifyConcurrency: "1",
    jestMaxWorkers: "2",
    message: "verify: low-memory host (16 GB) → concurrency 1, jest workers 2",
  },
);
check(
  "WC10 below 24 GB with VERIFY_CONCURRENCY explicitly set: it wins, jest workers still defaults",
  chooseVerifyDefaults({ totalMemBytes: MINI_MEM, env: { VERIFY_CONCURRENCY: "3" } }),
  {
    verifyConcurrency: "3",
    jestMaxWorkers: "2",
    message: "verify: low-memory host (16 GB) → concurrency 3, jest workers 2",
  },
);
check(
  "WC11 below 24 GB with JEST_MAX_WORKERS explicitly set: it wins, concurrency still defaults",
  chooseVerifyDefaults({ totalMemBytes: MINI_MEM, env: { JEST_MAX_WORKERS: "4" } }),
  {
    verifyConcurrency: "1",
    jestMaxWorkers: "4",
    message: "verify: low-memory host (16 GB) → concurrency 1, jest workers 4",
  },
);
check(
  "WC12 below 24 GB with BOTH explicitly set: nothing defaulted, no message printed",
  chooseVerifyDefaults({
    totalMemBytes: MINI_MEM,
    env: { VERIFY_CONCURRENCY: "3", JEST_MAX_WORKERS: "4" },
  }),
  { verifyConcurrency: "3", jestMaxWorkers: "4", message: null },
);
check(
  "WC12b a SET-BUT-EMPTY VERIFY_CONCURRENCY is an explicit opt-out (checked by presence, " +
    '`"X" in env`, never truthiness) — stays empty, never silently defaulted; the unset ' +
    "JEST_MAX_WORKERS still defaults",
  chooseVerifyDefaults({ totalMemBytes: MINI_MEM, env: { VERIFY_CONCURRENCY: "" } }),
  {
    verifyConcurrency: "",
    jestMaxWorkers: "2",
    message: "verify: low-memory host (16 GB) → concurrency , jest workers 2",
  },
);
check(
  "WC13 at/above 24 GB with no env set (the PC: 14 cpus, 32 GB): concurrency stays unset and jest " +
    "gets the worker budget max(2, floor(cpus*0.75/2)) = 5 per task, with one explanatory line " +
    "(replaces the pre-budget 'nothing is defaulted' expectation — lead ruling 2026-10-10)",
  chooseVerifyDefaults({ totalMemBytes: PC_MEM, env: {}, cpus: 14 }),
  {
    verifyConcurrency: "",
    jestMaxWorkers: "5",
    message: "verify: worker budget → jest workers 5 per task (cpus 14, concurrency 2)",
  },
);
check(
  "WC13b exactly the 24 GB threshold is treated as high-memory (< not <=): a 4-cpu host floors at 2 workers",
  chooseVerifyDefaults({ totalMemBytes: LOW_MEM_THRESHOLD_BYTES, env: {}, cpus: 4 }),
  {
    verifyConcurrency: "",
    jestMaxWorkers: "2",
    message: "verify: worker budget → jest workers 2 per task (cpus 4, concurrency 2)",
  },
);
check(
  "WC13b2 an unknown cpu count (omitted / 0 / NaN) budgets nothing — byte-identical to the old high-memory path",
  [undefined, 0, Number.NaN].map((cpus) =>
    chooseVerifyDefaults({ totalMemBytes: PC_MEM, env: {}, cpus }),
  ),
  Array(3).fill({ verifyConcurrency: "", jestMaxWorkers: "", message: null }),
);
check(
  "WC13b3 jestWorkerBudget: max(2, floor(cpus*0.75/concurrency)) across cpu counts and concurrency",
  [
    [14, 2],
    [4, 2],
    [16, 2],
    [14, 1],
    [32, 3],
    [1, 2],
  ].map(([cpus, concurrency]) => jestWorkerBudget({ cpus, concurrency })),
  [5, 2, 6, 10, 8, 2],
);
check(
  "WC13b4 the budget divides by the RESOLVED VERIFY_CONCURRENCY (3 -> floor(14*0.75/3) = 3); an " +
    "unparsable value falls back to 2",
  [
    chooseVerifyDefaults({ totalMemBytes: PC_MEM, env: { VERIFY_CONCURRENCY: "3" }, cpus: 14 }),
    chooseVerifyDefaults({ totalMemBytes: PC_MEM, env: { VERIFY_CONCURRENCY: "x" }, cpus: 14 })
      .jestMaxWorkers,
  ],
  [
    {
      verifyConcurrency: "3",
      jestMaxWorkers: "3",
      message: "verify: worker budget → jest workers 3 per task (cpus 14, concurrency 3)",
    },
    "5",
  ],
);
check(
  "WC13b5 an explicit JEST_MAX_WORKERS always wins on a roomy host (presence check, so a " +
    "set-but-empty value is an opt-out too): nothing is budgeted, no message",
  [
    chooseVerifyDefaults({ totalMemBytes: PC_MEM, env: { JEST_MAX_WORKERS: "9" }, cpus: 14 }),
    chooseVerifyDefaults({ totalMemBytes: PC_MEM, env: { JEST_MAX_WORKERS: "" }, cpus: 14 }),
  ],
  [
    { verifyConcurrency: "", jestMaxWorkers: "9", message: null },
    { verifyConcurrency: "", jestMaxWorkers: "", message: null },
  ],
);
check(
  "WC13b6 CI never gets the budget and a low-memory host keeps its 1/2 rule, whatever the cpu count",
  [
    chooseVerifyDefaults({ totalMemBytes: PC_MEM, env: { CI: "true" }, cpus: 14 }),
    chooseVerifyDefaults({ totalMemBytes: MINI_MEM, env: {}, cpus: 14 }),
  ],
  [
    { verifyConcurrency: "", jestMaxWorkers: "", message: null },
    {
      verifyConcurrency: "1",
      jestMaxWorkers: "2",
      message: "verify: low-memory host (16 GB) → concurrency 1, jest workers 2",
    },
  ],
);
check(
  "WC13b7 end-to-end on the PC: the budget feeds jestPassthrough exactly like an explicit inline cap",
  (() => {
    const { verifyConcurrency, jestMaxWorkers } = chooseVerifyDefaults({
      totalMemBytes: PC_MEM,
      env: {},
      cpus: 14,
    });
    return buildArgv(["test"], buildTurboFlags(verifyConcurrency), jestPassthrough(jestMaxWorkers));
  })(),
  [
    "turbo",
    "run",
    "test",
    "--concurrency=2",
    "--continue=dependencies-successful",
    "--",
    "--maxWorkers=5",
  ],
);
check(
  "WC13c CI is EXCLUDED from the low-memory default regardless of its own host memory — " +
    "GitHub's ubuntu-latest is ~16 GB public / ~7 GB private, both under the threshold, so " +
    "without this CI would silently get concurrency 1 / --maxWorkers=2 and break the " +
    "'bit-for-bit unchanged' promise",
  chooseVerifyDefaults({ totalMemBytes: MINI_MEM, env: { CI: "true" } }),
  { verifyConcurrency: "", jestMaxWorkers: "", message: null },
);
check(
  "WC13d CI does not block an explicit override — a CI job that DOES set the vars is still honoured",
  chooseVerifyDefaults({
    totalMemBytes: MINI_MEM,
    env: { CI: "true", VERIFY_CONCURRENCY: "2", JEST_MAX_WORKERS: "3" },
  }),
  { verifyConcurrency: "2", jestMaxWorkers: "3", message: null },
);
check(
  "WC14 at/above 24 GB with env explicitly set: explicit values pass through untouched, no message",
  chooseVerifyDefaults({
    totalMemBytes: PC_MEM,
    env: { VERIFY_CONCURRENCY: "8", JEST_MAX_WORKERS: "8" },
  }),
  { verifyConcurrency: "8", jestMaxWorkers: "8", message: null },
);
check(
  "WC15 end-to-end: the low-mem defaults feed buildTurboFlags/jestPassthrough exactly like an " +
    "explicit inline throttle would — buildTurboFlags/jestPassthrough themselves take no new " +
    "branch for this",
  (() => {
    const { verifyConcurrency, jestMaxWorkers } = chooseVerifyDefaults({
      totalMemBytes: MINI_MEM,
      env: {},
    });
    return buildArgv(["test"], buildTurboFlags(verifyConcurrency), jestPassthrough(jestMaxWorkers));
  })(),
  [
    "turbo",
    "run",
    "test",
    "--concurrency=1",
    "--continue=dependencies-successful",
    "--",
    "--maxWorkers=2",
  ],
);

// VX: VERIFY_EXCLUDE — workspaces CI verifies in their OWN job (apps/control, lead ruling
// 2026-10-01), taken out of the shared Verify's turbo scope. Pure builders first, then the real
// `main()` against a stub `npx` so the env var is proven to reach the argv end to end.
const CONTROL = "@routeflow/control";
const KNOWN = workspaces.map((w) => w.name);
check(
  "VX0 the real graph has @routeflow/control (the name ci.yml's VERIFY_EXCLUDE uses)",
  KNOWN.includes(CONTROL),
  true,
);

// parseVerifyExclude: comma list, trimmed, de-duplicated, empties dropped. ONLY the allow-list
// (exactly @routeflow/control) is accepted: anything else is refused LOUDLY, so a later ci.yml edit
// can never silently exclude api/web (lead ruling 2026-10-01).
const thrown = (f) => {
  try {
    f();
    return null;
  } catch (e) {
    return String(e && e.message);
  }
};
check("VX1a the allow-list is EXACTLY @routeflow/control", [...VERIFY_EXCLUDE_ALLOWED], [CONTROL]);
check(
  "VX1 unset / empty / whitespace / only commas parse to []",
  [
    parseVerifyExclude(undefined, KNOWN),
    parseVerifyExclude("", KNOWN),
    parseVerifyExclude("   ", KNOWN),
    parseVerifyExclude(" , ,,", KNOWN),
  ],
  [[], [], [], []],
);
check(
  "VX2 a non-string (null / number / object) parses to []",
  [parseVerifyExclude(null, KNOWN), parseVerifyExclude(5, KNOWN), parseVerifyExclude({}, KNOWN)],
  [[], [], []],
);
check(
  "VX3 one name, and the same name with surrounding whitespace, parse to that name",
  [parseVerifyExclude(CONTROL, KNOWN), parseVerifyExclude(`  ${CONTROL}\t`, KNOWN)],
  [[CONTROL], [CONTROL]],
);
check(
  "VX4 duplicates collapse and empties between names are dropped",
  parseVerifyExclude(` ${CONTROL} ,, ${CONTROL}, `, KNOWN),
  [CONTROL],
);
const REFUSED = [
  "@routeflow/api",
  "@routeflow/web",
  "@routeflow/mobile",
  "@routeflow/pricing",
  "@routeflow/nope",
  "@routeflow/control-x",
  "@routeflow/Control",
  "@ROUTEFLOW/control",
  "control",
  "!@routeflow/control",
  "--force",
  "--filter=!@routeflow/api",
  "@routeflow/*",
  "*",
  "a b",
  "$(x)",
  ";ls",
  `${CONTROL}\n--force`,
  `${CONTROL} @routeflow/web`,
];
for (const bad of REFUSED) {
  const msg = thrown(() => parseVerifyExclude(bad, KNOWN));
  check(
    `VX5 ${JSON.stringify(bad)} is refused loudly, naming the allow-list`,
    [typeof msg === "string", /may only name @routeflow\/control/.test(msg ?? "")],
    [true, true],
  );
}
check(
  "VX6 a refused name next to the allowed one still refuses (no partial exclusion), with or without " +
    "a known list",
  [
    typeof thrown(() => parseVerifyExclude(`${CONTROL},@routeflow/api`, KNOWN)),
    typeof thrown(() => parseVerifyExclude(`@routeflow/api,${CONTROL}`, undefined)),
    typeof thrown(() => parseVerifyExclude(`--help,${CONTROL}`, undefined)),
  ],
  ["string", "string", "string"],
);
check(
  "VX6b the refusal message shows the offending name JSON-quoted and truncated (no raw control chars)",
  [
    /"\\u0007|\\u0007/.test(thrown(() => parseVerifyExclude("x\u0007y", KNOWN)) ?? ""),
    (thrown(() => parseVerifyExclude("z".repeat(500), KNOWN)) ?? "").length < 400,
  ],
  [true, true],
);
check(
  "VX6c an allow-listed name that is absent from the graph is dropped (nothing to exclude)",
  parseVerifyExclude(CONTROL, ["@routeflow/api"]),
  [],
);

const FLAGS = buildTurboFlags("");
const run = (plan, passthrough = []) =>
  plan.calls.map((c) =>
    buildArgv(c.args, FLAGS, c.jest ? passthrough : []).filter((a) => a !== "turbo" && a !== "run"),
  );
const FULL = { mode: "full", reason: "CI" };
const NEG = `--filter=!${CONTROL}`;

// FULL scope: nothing excluded is byte-identical to the pre-change argv.
check(
  "VX7 FULL, nothing excluded, unsplit: the ONE bundled call, byte-identical to before",
  run(planTurboCalls({ scope: FULL, excluded: [], splitJest: false })),
  [
    [
      "check-types",
      "lint",
      "test",
      "test:repo-truth",
      "--concurrency=2",
      "--continue=dependencies-successful",
    ],
  ],
);
check(
  "VX8 FULL, nothing excluded, split (JEST_MAX_WORKERS): ct+lint, then jest tasks with the passthrough",
  run(planTurboCalls({ scope: FULL, excluded: [], splitJest: true }), ["--", "--maxWorkers=2"]),
  [
    ["check-types", "lint", "--concurrency=2", "--continue=dependencies-successful"],
    [
      "test",
      "test:repo-truth",
      "--concurrency=2",
      "--continue=dependencies-successful",
      "--",
      "--maxWorkers=2",
    ],
  ],
);
check(
  "VX9 FULL unsplit: the negative filter rides on the one bundled call",
  run(planTurboCalls({ scope: FULL, excluded: [CONTROL], splitJest: false })),
  [
    [
      "check-types",
      "lint",
      "test",
      "test:repo-truth",
      NEG,
      "--concurrency=2",
      "--continue=dependencies-successful",
    ],
  ],
);
check(
  "VX10 FULL split: the negative filter rides on BOTH calls, and --maxWorkers only on the jest one",
  run(planTurboCalls({ scope: FULL, excluded: [CONTROL], splitJest: true }), [
    "--",
    "--maxWorkers=2",
  ]),
  [
    ["check-types", "lint", NEG, "--concurrency=2", "--continue=dependencies-successful"],
    [
      "test",
      "test:repo-truth",
      NEG,
      "--concurrency=2",
      "--continue=dependencies-successful",
      "--",
      "--maxWorkers=2",
    ],
  ],
);
check(
  "VX11 FULL with two exclusions: one negative filter each, in the given order, no positive filter",
  planTurboCalls({ scope: FULL, excluded: [CONTROL, "@routeflow/web"], splitJest: false }).calls[0]
    .args,
  ["check-types", "lint", "test", "test:repo-truth", NEG, "--filter=!@routeflow/web"],
);

// AFFECTED scope.
const AFF = (workspacesList) => ({ mode: "scoped", workspaces: workspacesList, changed: [] });
const A = ["@routeflow/api", "@routeflow/pricing"];
check(
  "VX12 AFFECTED, nothing excluded, unsplit: the old two calls (positive filters + api repo-truth)",
  run(planTurboCalls({ scope: AFF(A), excluded: [], splitJest: false })),
  [
    [
      "check-types",
      "lint",
      "test",
      "--filter=@routeflow/api",
      "--filter=@routeflow/pricing",
      "--concurrency=2",
      "--continue=dependencies-successful",
    ],
    [
      "test:repo-truth",
      "--filter=@routeflow/api",
      "--concurrency=2",
      "--continue=dependencies-successful",
    ],
  ],
);
check(
  "VX13 AFFECTED, nothing excluded, split: the old three calls, passthrough on the two jest ones",
  run(planTurboCalls({ scope: AFF(A), excluded: [], splitJest: true }), ["--", "--maxWorkers=2"]),
  [
    [
      "check-types",
      "lint",
      "--filter=@routeflow/api",
      "--filter=@routeflow/pricing",
      "--concurrency=2",
      "--continue=dependencies-successful",
    ],
    [
      "test",
      "--filter=@routeflow/api",
      "--filter=@routeflow/pricing",
      "--concurrency=2",
      "--continue=dependencies-successful",
      "--",
      "--maxWorkers=2",
    ],
    [
      "test:repo-truth",
      "--filter=@routeflow/api",
      "--concurrency=2",
      "--continue=dependencies-successful",
      "--",
      "--maxWorkers=2",
    ],
  ],
);
check(
  "VX14 AFFECTED: an excluded workspace is dropped from the positive filters (both paths); others stay",
  [
    planTurboCalls({
      scope: AFF([...A, CONTROL]),
      excluded: [CONTROL],
      splitJest: false,
    }).calls.map((c) => c.args),
    planTurboCalls({ scope: AFF([...A, CONTROL]), excluded: [CONTROL], splitJest: true }).calls.map(
      (c) => c.args,
    ),
  ],
  [
    [
      ["check-types", "lint", "test", "--filter=@routeflow/api", "--filter=@routeflow/pricing"],
      ["test:repo-truth", "--filter=@routeflow/api"],
    ],
    [
      ["check-types", "lint", "--filter=@routeflow/api", "--filter=@routeflow/pricing"],
      ["test", "--filter=@routeflow/api", "--filter=@routeflow/pricing"],
      ["test:repo-truth", "--filter=@routeflow/api"],
    ],
  ],
);
check(
  "VX15 AFFECTED: no negative filter is ever added (they would WIDEN a positive-filtered run)",
  planTurboCalls({ scope: AFF([...A, CONTROL]), excluded: [CONTROL], splitJest: false })
    .calls.flatMap((c) => c.args)
    .some((a) => a.startsWith("--filter=!")),
  false,
);
check(
  "VX16 AFFECTED: nothing left after the exclusion (and api repo-truth excluded too) = no calls + a note",
  (() => {
    const plan = planTurboCalls({
      scope: AFF([CONTROL]),
      excluded: [CONTROL, "@routeflow/api"],
      splitJest: false,
    });
    return [plan.calls, /nothing left to verify/i.test(plan.note ?? "")];
  })(),
  [[], true],
);
check(
  "VX17 AFFECTED: only the control workspace in scope, control excluded: no workspace call, " +
    "but the always-run api repo-truth tripwire still runs",
  planTurboCalls({ scope: AFF([CONTROL]), excluded: [CONTROL], splitJest: false }).calls.map(
    (c) => c.args,
  ),
  [["test:repo-truth", "--filter=@routeflow/api"]],
);
check(
  "VX18 excludedLine: silent when nothing is excluded, one explanatory line otherwise",
  [excludedLine([]), excludedLine([CONTROL]), excludedLine([CONTROL, "@routeflow/web"])],
  [
    null,
    "EXCLUDED FROM THIS RUN (separate CI job): @routeflow/control",
    "EXCLUDED FROM THIS RUN (separate CI job): @routeflow/control, @routeflow/web",
  ],
);

// End to end: the REAL main() with a stub `npx` first on PATH that records its argv. CI=1 makes
// the scope FULL without touching git; JEST_MAX_WORKERS selects the split path. POSIX only (the
// stub is a shell script; Windows' npx is a .cmd and `shell: true`).
if (process.platform !== "win32") {
  const stubDir = mkdtempSync(join(tmpdir(), "verify-turbo-stub-"));
  try {
    const log = join(stubDir, "calls.log");
    const counter = join(stubDir, "count");
    // The stub records its argv, then exits with the Nth status of STUB_EXIT_SEQ ("0,3,5": call 1
    // exits 0, call 2 exits 3, call 3 exits 5; calls past the list, or no list, exit 0).
    writeFileSync(
      join(stubDir, "npx"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${log}"`,
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        "n=$((n + 1))",
        `echo "$n" > "${counter}"`,
        "IFS=,",
        "set -- $STUB_EXIT_SEQ",
        'eval "code=\\${$n:-0}"',
        'exit "$code"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // `opts.script` / `opts.cwd` aim the real main() at a fixture repo (the AFFECTED cases below);
    // `opts.ci === false` leaves CI unset so decideScope reads the fixture's git diff.
    const runMain = (extraEnv, opts = {}) => {
      writeFileSync(log, "");
      writeFileSync(counter, "0");
      const env = {
        ...scrubbedGitEnv(),
        PATH: `${stubDir}:${process.env.PATH}`,
        // The AFFECTED cases below run without CI and so really take the heavy-job slot: keep it in
        // a throwaway dir, never the host's real ~/.routeflow/heavy-slot.
        RF_HEAVY_SLOT_DIR: join(stubDir, "slot"),
        CI: "1",
        ...extraEnv,
      };
      delete env.FULL_VERIFY;
      if (opts.ci === false) delete env.CI;
      if (!("JEST_MAX_WORKERS" in extraEnv)) delete env.JEST_MAX_WORKERS;
      if (!("VERIFY_EXCLUDE" in extraEnv)) delete env.VERIFY_EXCLUDE;
      if (!("STUB_EXIT_SEQ" in extraEnv)) delete env.STUB_EXIT_SEQ;
      const r = spawnSync(
        process.execPath,
        [opts.script ?? join(ROOT, "scripts", "verify-turbo.mjs")],
        {
          cwd: opts.cwd ?? ROOT,
          encoding: "utf8",
          env,
        },
      );
      return {
        status: r.status,
        out: r.stdout,
        err: r.stderr,
        calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
      };
    };
    const off = runMain({});
    check(
      "VX19 main(): VERIFY_EXCLUDE unset = one turbo call, no negative filter, no banner",
      [off.status, off.calls, /EXCLUDED FROM THIS RUN/.test(off.out)],
      [
        0,
        [
          "turbo run check-types lint test test:repo-truth --concurrency=2 --continue=dependencies-successful",
        ],
        false,
      ],
    );
    const on = runMain({ VERIFY_EXCLUDE: ` ${CONTROL} ` });
    check(
      "VX20 main(): VERIFY_EXCLUDE reaches the FULL argv and prints the one-line banner",
      [
        on.status,
        on.calls,
        on.out.split("\n").filter((l) => l.startsWith("EXCLUDED FROM THIS RUN")),
      ],
      [
        0,
        [
          `turbo run check-types lint test test:repo-truth ${NEG} --concurrency=2 --continue=dependencies-successful`,
        ],
        ["EXCLUDED FROM THIS RUN (separate CI job): @routeflow/control"],
      ],
    );
    const split = runMain({ VERIFY_EXCLUDE: CONTROL, JEST_MAX_WORKERS: "2" });
    check(
      "VX21 main(): on the split (JEST_MAX_WORKERS) path BOTH calls carry the negative filter",
      [split.status, split.calls],
      [
        0,
        [
          `turbo run check-types lint ${NEG} --concurrency=2 --continue=dependencies-successful`,
          `turbo run test test:repo-truth ${NEG} --concurrency=2 --continue=dependencies-successful -- --maxWorkers=2`,
        ],
      ],
    );
    for (const bad of [
      "nope,--help",
      "@routeflow/api",
      `${CONTROL},@routeflow/web`,
      "@routeflow/*",
    ]) {
      const junk = runMain({ VERIFY_EXCLUDE: bad });
      check(
        `VX22 main(): VERIFY_EXCLUDE=${JSON.stringify(bad)} is refused loudly: exit 1, the allow-list message on stderr, NO turbo call, no banner`,
        [
          junk.status,
          /VERIFY_EXCLUDE may only name @routeflow\/control/.test(junk.err),
          junk.calls,
          /EXCLUDED FROM THIS RUN/.test(junk.out),
        ],
        [1, true, [], false],
      );
    }

    // VX23-26: the exit status is the FIRST non-zero one AND every planned call still runs. The stub
    // above used to exit 0 always, so "exit with the last non-zero status" and "stop after the
    // first failure" both survived this file.
    const fullUnsplit = runMain({ STUB_EXIT_SEQ: "7" });
    check(
      "VX23 main() FULL unsplit: the single call's non-zero status is the exit status",
      [fullUnsplit.status, fullUnsplit.calls.length],
      [7, 1],
    );
    const fullSplit = runMain({ STUB_EXIT_SEQ: "3,5", JEST_MAX_WORKERS: "2" });
    check(
      "VX24 main() FULL split: first non-zero (3, not the last 5) wins and both calls ran",
      [fullSplit.status, fullSplit.calls.length],
      [3, 2],
    );

    // AFFECTED needs a real scoped decision, so main() runs from a scratch repo that holds a copy of
    // the script and its lib, a feature branch one apps/api file ahead of origin/master, and no
    // campaign-check (staleWorkspaces fails open to []). Same B420 discipline as runMoveFixture:
    // GIT_*-free env, identity as -c flags, and nothing is written before the toplevel is proven.
    const fixDir = realpathSync(mkdtempSync(join(tmpdir(), "verify-affected-")));
    try {
      const fgit = (...args) =>
        spawnSync("git", [...IDENT, ...args], { cwd: fixDir, encoding: "utf8", env: fixtureEnv() });
      const init = fgit("init", "-q", "-b", "master");
      const top = fgit("rev-parse", "--show-toplevel").stdout.trim();
      if (init.status !== 0 || realpathSync(top) !== fixDir) {
        check("VX25 fixture repo resolves to the scratch dir (refusing to write)", top, fixDir);
      } else {
        const put = (rel, text) => {
          mkdirSync(dirname(join(fixDir, rel)), { recursive: true });
          writeFileSync(join(fixDir, rel), text);
        };
        for (const f of ["verify-turbo.mjs"]) {
          put(`scripts/${f}`, readFileSync(join(ROOT, "scripts", f), "utf8"));
        }
        for (const f of [
          "verify-scope.mjs",
          "check-git-hooks.mjs",
          "scrubbed-git-env.cjs",
          "heavy-slot.mjs",
        ]) {
          put(`scripts/lib/${f}`, readFileSync(join(ROOT, "scripts", "lib", f), "utf8"));
        }
        for (const [dir, name] of [
          ["apps/api", "@routeflow/api"],
          ["apps/control", "@routeflow/control"],
          ["packages/pricing", "@routeflow/pricing"],
        ]) {
          put(`${dir}/package.json`, JSON.stringify({ name }));
        }
        fgit("add", "-A");
        fgit("commit", "-q", "-m", "base");
        fgit("update-ref", "refs/remotes/origin/master", "HEAD");
        fgit("checkout", "-q", "-b", "feat/x");
        put("apps/api/src/x.ts", "export const x = 1;\n");
        fgit("add", "-A");
        fgit("commit", "-q", "-m", "change");
        const aff = (extraEnv) =>
          runMain(extraEnv, {
            ci: false,
            cwd: fixDir,
            script: join(fixDir, "scripts", "verify-turbo.mjs"),
          });
        const affUnsplit = aff({ STUB_EXIT_SEQ: "3,5", JEST_MAX_WORKERS: "" });
        check(
          "VX25 main() AFFECTED unsplit: the scope is really AFFECTED, 2 calls ran, first non-zero (3) wins",
          [/AFFECTED SCOPE/.test(affUnsplit.out), affUnsplit.calls.length, affUnsplit.status],
          [true, 2, 3],
        );
        const affSplit = aff({ STUB_EXIT_SEQ: "0,3,5", JEST_MAX_WORKERS: "2" });
        check(
          "VX26 main() AFFECTED split: all 3 calls ran, first non-zero (3, not the last 5) wins",
          [/AFFECTED SCOPE/.test(affSplit.out), affSplit.calls.length, affSplit.status],
          [true, 3, 3],
        );
      }
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

// HS: every heavy local entry point takes the machine-wide slot INSIDE the script (so root
// package.json, which busts every turbo cache when edited, never changes). A future heavy entry point
// that skips it is caught here: each must import withHeavySlot from the shared lib and call it.
{
  const scripts = ["verify-turbo.mjs", "local-env.mjs", "local-db-specs.mjs"];
  const pins = scripts.map((name) => {
    const src = readFileSync(join(ROOT, "scripts", name), "utf8");
    const imp = /import\s*\{[^}]*\bwithHeavySlot\b[^}]*\}\s*from\s*"\.\/lib\/heavy-slot\.mjs"/.test(
      src,
    );
    // a call, not just the import: drop every import statement, then look for `withHeavySlot(`
    const call = /\bwithHeavySlot\(/.test(
      src.replace(/import\s*\{[^}]*\}\s*from\s*"[^"]*";?/g, ""),
    );
    return [name, imp, call];
  });
  check(
    "HS1 verify-turbo.mjs, local-env.mjs and local-db-specs.mjs each import withHeavySlot from " +
      "./lib/heavy-slot.mjs and call it",
    pins,
    scripts.map((name) => [name, true, true]),
  );
  check(
    "HS2 the lib exists where those imports point",
    readFileSync(join(ROOT, "scripts", "lib", "heavy-slot.mjs"), "utf8").includes(
      "export async function withHeavySlot",
    ),
    true,
  );
}

// S10: portable containment — the POSIX-only startsWith(`${root}/`) threw on every Windows push.
const W = path.win32;
const winTmp = "C:\\Users\\dev\\AppData\\Local\\Temp";
check(
  "S10a win32: a backslash path inside the tmp root is under it",
  isUnder(winTmp, `${winTmp}\\verify-scope-abc123`, W),
  true,
);
check("S10b win32: the root itself is not 'under' itself", isUnder(winTmp, winTmp, W), false);
check(
  "S10c win32: a sibling sharing the prefix (Temp2) is NOT under Temp",
  isUnder(winTmp, "C:\\Users\\dev\\AppData\\Local\\Temp2\\x", W),
  false,
);
check("S10d win32: another drive is not under it", isUnder(winTmp, "D:\\Temp\\x", W), false);
check(
  "S10e win32: a .. escape is not under it",
  isUnder(winTmp, `${winTmp}\\..\\elsewhere`, W),
  false,
);
check(
  "S10f posix: inside / itself / sibling prefix",
  [
    isUnder("/tmp", "/tmp/verify-scope-abc", path.posix),
    isUnder("/tmp", "/tmp", path.posix),
    isUnder("/tmp", "/tmp2/x", path.posix),
  ],
  [true, false, false],
);
process.exit(failures ? 1 : 0);
