#!/usr/bin/env node
/**
 * Self-test for the mappedSha DRIFT rule and the `--stamp` flag in
 * scripts/validate-code-map.mjs (owner ruling 2026-09-14, F1+F2 fix round):
 * `mappedSha` != HEAD alone is never an error; STALE = drift under
 * apps/**, packages/**, scripts/** since mappedSha with no corresponding
 * .claude/code-map/** change in the same range — a WARNING off master, an
 * ERROR on master — and mappedSha naming a commit that isn't HEAD and isn't
 * an ancestor of HEAD is an ERROR everywhere. `--stamp` writes only after
 * every structural check has passed.
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

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });

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
// safe because every `commitFile` call below stages ONLY the one file it's
// given, so this edit is never swept into a later commit and never shows up
// in a `git diff` range).
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

const main = () => {
  // ── A: drift under apps/**, no map update, off master -> WARN, exit 0 ───
  {
    const repo = makeRepo("feature/drift");
    repo.commitFile("apps/api/src/thing.ts", "export const x = 1;\n", "touch apps");
    const res = runScript(repo.scriptCopy, [], repo.scratch);
    check("A: drift off master exits 0", res.status, 0);
    check("A: drift off master WARNS as STALE", (res.stdout + res.stderr).includes("STALE:"), true);
    cleanup(repo.scratch);
  }

  // ── B: drift WITH a map update in the same range -> no staleness ────────
  {
    const repo = makeRepo("feature/map-touched");
    mkdirSync(join(repo.scratch, "apps", "api", "src"), { recursive: true });
    writeFileSync(join(repo.scratch, "apps", "api", "src", "thing.ts"), "export const x = 1;\n");
    writeFileSync(
      join(repo.scratch, ".claude", "code-map", "CHANGELOG.md"),
      "# Changelog\n- **2026-09-14** — touched thing.ts\n",
    );
    git(["add", "-A"], repo.scratch);
    git(["commit", "-m", "touch apps + map"], repo.scratch);
    const res = runScript(repo.scriptCopy, [], repo.scratch);
    check("B: drift with map update exits 0", res.status, 0);
    check(
      "B: drift with map update has NO staleness warning",
      (res.stdout + res.stderr).includes("STALE:"),
      false,
    );
    cleanup(repo.scratch);
  }

  // ── C: the SAME drift-with-no-map-update IS a hard failure on master ────
  {
    const repo = makeRepo("master");
    repo.commitFile("apps/api/src/thing.ts", "export const x = 1;\n", "touch apps");
    const res = runScript(repo.scriptCopy, [], repo.scratch);
    check("C: drift on master exits 1", res.status, 1);
    check(
      "C: failure names it a master-only error",
      (res.stdout + res.stderr).includes("branch is master"),
      true,
    );
    cleanup(repo.scratch);
  }

  // ── D: mappedSha not HEAD, not an ancestor of HEAD -> ERROR everywhere ───
  {
    const repo = makeRepo("feature/ancestor-violation");
    git(["checkout", "-b", "side"], repo.scratch);
    mkdirSync(join(repo.scratch, "apps"), { recursive: true });
    writeFileSync(join(repo.scratch, "apps", "side.ts"), "export const side = 1;\n");
    git(["add", "-A"], repo.scratch);
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
    cleanup(repo.scratch);
  }

  // ── E: --stamp sets mappedSha=HEAD + generatedAt, clears staleness ──────
  {
    const repo = makeRepo("feature/stamp");
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
    cleanup(repo.scratch);
  }

  // ── F: --stamp REFUSES to write when a structural check fails ───────────
  {
    const repo = makeRepo("feature/stamp-refuses");
    writeFileSync(join(repo.scratch, ".claude", "code-map", "INDEX.md"), "x".repeat(20_001));
    const before = readFileSync(repo.metaPath, "utf8");

    const stamp = runScript(repo.scriptCopy, ["--stamp"], repo.scratch);
    check("F: --stamp on a failing run exits 1", stamp.status, 1);
    check(
      "F: --stamp on a failing run leaves _meta.json untouched",
      readFileSync(repo.metaPath, "utf8"),
      before,
    );
    cleanup(repo.scratch);
  }

  console.log(
    failures
      ? `\nvalidate-code-map.stamp.self-test: ${failures} FAILURE(S)`
      : "\nvalidate-code-map.stamp.self-test: all checks passed",
  );
  process.exit(failures ? 1 : 0);
};

main();
