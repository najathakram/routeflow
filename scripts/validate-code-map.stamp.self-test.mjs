#!/usr/bin/env node
/**
 * Self-test for the mappedSha DRIFT rule and the `--stamp` flag in
 * scripts/validate-code-map.mjs (owner ruling 2026-09-14, F1+F2 fix round;
 * shallow-clone UNVERIFIABLE case added in the CI-failure fix round):
 * `mappedSha` != HEAD alone is never an error; STALE = drift under
 * apps/**, packages/**, scripts/** since mappedSha with no corresponding
 * .claude/code-map/** change in the same range — a WARNING off master, an
 * ERROR on master — mappedSha naming a commit that isn't HEAD and isn't an
 * ancestor of HEAD is an ERROR everywhere, and mappedSha's commit object
 * being absent locally (a shallow CI checkout) is UNVERIFIABLE — a WARNING,
 * never an error, on master or off. `--stamp` writes only after every
 * structural check has passed.
 *
 * Every case below runs inside a genuinely separate throwaway git repo
 * (never a checkout of this one, and never against this repo's real
 * `.claude/code-map/`) — the sandboxing this file's old T3 already used,
 * now used for every case so no case depends on which branch this session
 * happens to be on (the old T1/T2 ran on the real repo and asserted
 * `branch !== "master"`, which made `npm run verify` permanently red on
 * master — the bug this rewrite fixes). `validate-code-map.mjs` is copied
 * into each scratch repo's own `scripts/` because it resolves
 * `.claude/code-map/` relative to its OWN file location, not `cwd`.
 *
 * `git` here always passes `-c commit.gpgsign=false -c core.hooksPath=` so
 * a machine-level signing requirement or a repo-level hooksPath can't make a
 * scratch-repo commit fail or run an unrelated hook, and always checks its
 * own exit status (throws loudly on failure instead of leaving a case to
 * fail opaquely on a downstream assertion). Cases that need a commit to
 * touch specific files (B, D) stage exactly those files rather than
 * `git add -A`, so an incidental uncommitted `_meta.json` edit sitting in
 * the working tree from `makeRepo` never rides along and confounds what the
 * case is actually proving.
 *
 * Same standalone-script convention as its siblings: `  ok`/`  FAIL` lines,
 * `process.exit(failures ? 1 : 0)`.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "validate-code-map.mjs");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

// Always disables commit signing and any repo/global hooksPath, and always
// checks its own exit status — a scratch-repo git command that fails (e.g.
// a missing `user.email` on a machine with none configured globally) must
// blow up loudly here, not surface as a confusing assertion failure three
// steps later.
const git = (args, cwd) => {
  const res = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(
      `validate-code-map.stamp.self-test: "git ${args.join(" ")}" failed (exit ${res.status}) ` +
        `in ${cwd}:\n${res.stderr || res.stdout}`,
    );
  }
  return res;
};

// CI/GITHUB_REF* are cleared on every spawn: the script's master-detection
// falls back to them for a detached-HEAD CI checkout, and if this self-test
// itself happens to run in a CI job on master, an inherited GITHUB_REF_NAME
// would leak into every scratch repo's child process and misclassify an
// off-master scratch branch as master. The scratch repo's own branch name
// (set explicitly per case below) is the only thing that should decide it.
const runScript = (scriptPath, args, cwd) =>
  spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "", GITHUB_REF_NAME: "", GITHUB_REF: "" },
  });

// Builds a fresh throwaway repo with a minimal code map + a copy of the
// script under test, seeds one commit, renames the branch to `branch`, and
// points mappedSha at that seed commit (an uncommitted `_meta.json` edit —
// safe because every case below stages ONLY the file(s) it names when it
// commits, so this edit is never swept into a later commit unless a case
// explicitly does so, and never shows up in a `git diff` range on its own).
function makeRepo(branch) {
  const scratch = mkdtempSync(join(tmpdir(), "code-map-self-test-"));
  const mapDir = join(scratch, ".claude", "code-map");
  const scriptsDir = join(scratch, "scripts");
  mkdirSync(mapDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(mapDir, "INDEX.md"), "# Code Map\n");
  writeFileSync(join(mapDir, "CHANGELOG.md"), "# Changelog\n");
  const metaPath = join(mapDir, "_meta.json");
  const writeMeta = (fields) => writeFileSync(metaPath, `${JSON.stringify(fields, null, 2)}\n`);
  writeMeta({ mappedSha: "0".repeat(40), generatedAt: "2026-01-01T00:00:00.000Z" });
  const scriptCopy = join(scriptsDir, "validate-code-map.mjs");
  cpSync(SCRIPT, scriptCopy);

  git(["init"], scratch);
  git(["config", "user.email", "self-test@example.invalid"], scratch);
  git(["config", "user.name", "self-test"], scratch);
  git(["add", "-A"], scratch);
  git(["commit", "-m", "seed"], scratch);
  git(["branch", "-M", branch], scratch);
  const seedSha = git(["rev-parse", "HEAD"], scratch).stdout.trim();

  writeMeta({ mappedSha: seedSha, generatedAt: "2026-01-01T00:00:00.000Z" });

  const commitFile = (relPath, content, message) => {
    const full = join(scratch, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    git(["add", relPath], scratch);
    git(["commit", "-m", message], scratch);
    return git(["rev-parse", "HEAD"], scratch).stdout.trim();
  };

  return { scratch, scriptCopy, metaPath, writeMeta, commitFile, seedSha };
}

const cleanup = (scratch) => rmSync(scratch, { recursive: true, force: true });

// Runs `fn(repo)` against a fresh repo on `branch` and guarantees cleanup
// even if an assertion inside `fn` throws.
function withRepo(branch, fn) {
  const repo = makeRepo(branch);
  try {
    fn(repo);
  } finally {
    cleanup(repo.scratch);
  }
}

const main = () => {
  // ── A: drift under apps/**, no map update, off master -> WARN, exit 0 ───
  withRepo("feature/drift", (repo) => {
    repo.commitFile("apps/api/src/thing.ts", "export const x = 1;\n", "touch apps");
    const res = runScript(repo.scriptCopy, [], repo.scratch);
    check("A: drift off master exits 0", res.status, 0);
    check("A: drift off master WARNS as STALE", (res.stdout + res.stderr).includes("STALE:"), true);
  });

  // ── B: drift WITH a map update in the same range -> no staleness ────────
  // Stages exactly the apps file + CHANGELOG.md — not `add -A` — so the
  // uncommitted `_meta.json` edit `makeRepo` leaves in the working tree
  // (pointing mappedSha at the seed commit) never rides along into this
  // commit. If it did, `.claude/code-map/_meta.json` changing would satisfy
  // `mapTouched` all by itself and this case would pass for the wrong
  // reason — it must pass because CHANGELOG.md changed, not _meta.json.
  withRepo("feature/map-touched", (repo) => {
    mkdirSync(join(repo.scratch, "apps", "api", "src"), { recursive: true });
    writeFileSync(join(repo.scratch, "apps", "api", "src", "thing.ts"), "export const x = 1;\n");
    writeFileSync(
      join(repo.scratch, ".claude", "code-map", "CHANGELOG.md"),
      "# Changelog\n- **2026-09-14** — touched thing.ts\n",
    );
    git(["add", "apps/api/src/thing.ts", ".claude/code-map/CHANGELOG.md"], repo.scratch);
    git(["commit", "-m", "touch apps + map"], repo.scratch);
    const res = runScript(repo.scriptCopy, [], repo.scratch);
    check("B: drift with map update exits 0", res.status, 0);
    check(
      "B: drift with map update has NO staleness warning",
      (res.stdout + res.stderr).includes("STALE:"),
      false,
    );
  });

  // ── C: the SAME drift-with-no-map-update IS a hard failure on master ────
  withRepo("master", (repo) => {
    repo.commitFile("apps/api/src/thing.ts", "export const x = 1;\n", "touch apps");
    const res = runScript(repo.scriptCopy, [], repo.scratch);
    check("C: drift on master exits 1", res.status, 1);
    check(
      "C: failure names it a master-only error",
      (res.stdout + res.stderr).includes("branch is master"),
      true,
    );
  });

  // ── D: mappedSha not HEAD, not an ancestor of HEAD -> ERROR everywhere ───
  // The "side" commit stages exactly `apps/side.ts` — not `add -A` — for
  // the same reason as case B: the working tree's uncommitted `_meta.json`
  // must not ride along into a committed diff here either.
  withRepo("feature/ancestor-violation", (repo) => {
    git(["checkout", "-b", "side"], repo.scratch);
    mkdirSync(join(repo.scratch, "apps"), { recursive: true });
    writeFileSync(join(repo.scratch, "apps", "side.ts"), "export const side = 1;\n");
    git(["add", "apps/side.ts"], repo.scratch);
    git(["commit", "-m", "side commit"], repo.scratch);
    const sideSha = git(["rev-parse", "HEAD"], repo.scratch).stdout.trim();
    git(["checkout", "feature/ancestor-violation"], repo.scratch);
    repo.writeMeta({ mappedSha: sideSha, generatedAt: "2026-01-01T00:00:00.000Z" });

    const res = runScript(repo.scriptCopy, [], repo.scratch);
    check("D: non-ancestor mappedSha exits 1", res.status, 1);
    check(
      "D: failure names it a not-an-ancestor problem",
      (res.stdout + res.stderr).includes("MAPPED SHA NOT ANCESTOR"),
      true,
    );
  });

  // ── E: --stamp sets mappedSha=HEAD + generatedAt, clears staleness ──────
  withRepo("feature/stamp", (repo) => {
    const head = repo.commitFile("apps/api/src/thing.ts", "export const x = 1;\n", "touch apps");
    const before = JSON.parse(readFileSync(repo.metaPath, "utf8"));

    const stamp = runScript(repo.scriptCopy, ["--stamp"], repo.scratch);
    check("E: --stamp exits 0", stamp.status, 0);
    const after = JSON.parse(readFileSync(repo.metaPath, "utf8"));
    check("E: --stamp sets mappedSha to HEAD", after.mappedSha, head);
    check(
      "E: --stamp sets a fresh generatedAt",
      typeof after.generatedAt === "string" && after.generatedAt !== before.generatedAt,
      true,
    );

    const clean = runScript(repo.scriptCopy, [], repo.scratch);
    check(
      "E: plain run right after --stamp has no STALE warning",
      (clean.stdout + clean.stderr).includes("STALE:"),
      false,
    );
  });

  // ── F: --stamp REFUSES to write when a structural check fails ───────────
  withRepo("feature/stamp-refuses", (repo) => {
    writeFileSync(join(repo.scratch, ".claude", "code-map", "INDEX.md"), "x".repeat(20_001));
    const before = readFileSync(repo.metaPath, "utf8");

    const stamp = runScript(repo.scriptCopy, ["--stamp"], repo.scratch);
    check("F: --stamp on a failing run exits 1", stamp.status, 1);
    check(
      "F: --stamp on a failing run leaves _meta.json untouched",
      readFileSync(repo.metaPath, "utf8"),
      before,
    );
  });

  // ── G: mappedSha's commit object absent from a shallow clone ────────────
  // -> UNVERIFIABLE warning, exit 0 — never an error, even on master. A real
  // `git clone --depth 1` reproduces the exact CI failure mode (a fetched
  // history that simply does not contain mappedSha's commit object), so
  // `git merge-base --is-ancestor` cannot be asked the question at all.
  withRepo("master", (origin) => {
    origin.commitFile("apps/api/src/thing.ts", "export const x = 1;\n", "touch apps");
    // Pin mappedSha to the seed commit and COMMIT that pointer, so the
    // shallow clone's checked-out _meta.json (taken from HEAD) carries a
    // mappedSha the clone's single fetched commit cannot contain.
    origin.writeMeta({ mappedSha: origin.seedSha, generatedAt: "2026-01-01T00:00:00.000Z" });
    git(["add", ".claude/code-map/_meta.json"], origin.scratch);
    git(["commit", "-m", "pin mappedSha to seed"], origin.scratch);

    const shallow = mkdtempSync(join(tmpdir(), "code-map-self-test-shallow-"));
    try {
      // `--no-local` forces the real shallow-fetch protocol even for a
      // local-path source — plain `git clone --depth 1 <local-path>` uses
      // git's local-transport hardlink optimization, which silently
      // ignores `--depth` and copies every object anyway (no missing
      // object, so nothing here would reproduce the CI bug at all).
      git(["clone", "--no-local", "--depth", "1", origin.scratch, shallow], tmpdir());
      const scriptCopy = join(shallow, "scripts", "validate-code-map.mjs");
      const res = runScript(scriptCopy, [], shallow);
      check("G: shallow clone with unfetched mappedSha exits 0", res.status, 0);
      check(
        "G: shallow clone WARNS unverifiable, not STALE/error",
        (res.stdout + res.stderr).includes("unverifiable"),
        true,
      );
      check(
        "G: shallow clone never reports MAPPED SHA NOT ANCESTOR",
        (res.stdout + res.stderr).includes("MAPPED SHA NOT ANCESTOR"),
        false,
      );
    } finally {
      cleanup(shallow);
    }
  });

  console.log(
    failures
      ? `\nvalidate-code-map.stamp.self-test: ${failures} FAILURE(S)`
      : "\nvalidate-code-map.stamp.self-test: all checks passed",
  );
  process.exit(failures ? 1 : 0);
};

main();
