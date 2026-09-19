#!/usr/bin/env node
/**
 * Self-test for the affected-scope pre-push (scripts/lib/verify-scope.mjs + verify-turbo.mjs).
 * Runs against the REAL workspace graph of this repo — not a hand-typed fixture — so a new
 * dependency edge or a renamed package is caught here, not by a false-green push.
 *
 * S1: a change under packages/pricing selects api + web + mobile (its dependents) + itself.
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
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import {
  changedFilesSince,
  cleanGitEnv,
  computeScope,
  decideScope,
  loadWorkspaces,
  shortName,
} from "./lib/verify-scope.mjs";

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
  "S1 packages/pricing change selects api + mobile + pricing + web",
  scopedNames(["packages/pricing/src/index.ts"]),
  ["api", "mobile", "pricing", "web"],
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
  ...cleanGitEnv(),
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
const dflt = decideScope(gitRoot, {}, { branch: "feat/x", files: someFiles });
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
  decideScope(gitRoot, { VERIFY_SCOPE: "full" }, { branch: "feat/x", files: someFiles }).mode,
  "scoped",
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
