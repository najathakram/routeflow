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
import { tmpdir as osTmpdir } from "node:os";
import { realpathSync as realpathForTmp } from "node:fs";

// realpath (B573): on macOS os.tmpdir() is under /var, a symlink to /private/var, while git and
// process.cwd() report the resolved path — fixture paths compared against either were never equal.
const tmpdir = () => realpathForTmp(osTmpdir());
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
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
  // GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_COMMON_DIR are set by git itself when it
  // invokes a hook from a linked worktree, and inherit straight through spawnSync by
  // default — a scratch repo's own `git add`/`git init` then resolves against the OUTER
  // repo's gitdir instead of `cwd`, failing with "fatal: this operation must be run in a
  // work tree". Scrub them the same way runScript() below already scrubs CI/GITHUB_REF*.
  const env = scrubbedGitEnv();
  const res = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], {
    cwd,
    encoding: "utf8",
    env,
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
const runScript = (scriptPath, args, cwd) => {
  const env = { ...scrubbedGitEnv(), CI: "", GITHUB_REF_NAME: "", GITHUB_REF: "" };
  // Same GIT_DIR/GIT_WORK_TREE leak as the git() helper above: validate-code-map.mjs
  // shells out to git itself, so it must not resolve against the outer repo.
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
};

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
  // Guard, not a formality: proves the scrubbing above actually took effect for
  // THIS process's git binary/version, rather than trusting the env-deletion
  // list is complete. A leaked GIT_DIR resolves --show-toplevel to the OUTER
  // repo's root, never inside `scratch` — catch that here, before any command
  // below can mutate the outer repo, instead of failing opaquely three steps on.
  {
    const toplevel = git(["rev-parse", "--show-toplevel"], scratch).stdout.trim();
    const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!norm(toplevel).startsWith(norm(scratch))) {
      throw new Error(
        `validate-code-map.stamp.self-test: makeRepo's scratch repo resolved to toplevel ` +
          `"${toplevel}", not inside "${scratch}" — GIT_* env leaked into git()`,
      );
    }
  }
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

  // ── REG-B420: an ambient GIT_DIR/GIT_WORK_TREE (exactly what git sets when
  // invoking a hook from a linked worktree) must never leak into this file's
  // OWN scratch-repo git calls. A "victim" repo stands in for the real outer
  // repo; process.env is polluted the same way a pre-push hook pollutes it;
  // a normal fixture op runs; the victim's branches/HEAD/config must be
  // byte-identical before and after. This is the actual 2026-09-14 incident,
  // reproduced: on the pre-fix file this FAILS (the victim gets a renamed
  // branch and a fixture commit, exactly as rf-mobile-lanes did); on the
  // fixed file it PASSES.
  {
    const victim = mkdtempSync(join(tmpdir(), "code-map-self-test-victim-"));
    git(["init"], victim);
    git(["config", "user.email", "victim@example.invalid"], victim);
    git(["config", "user.name", "victim"], victim);
    writeFileSync(join(victim, "seed.txt"), "victim seed\n");
    git(["add", "-A"], victim);
    git(["commit", "-m", "victim seed"], victim);
    git(["branch", "-M", "master"], victim);

    const before = {
      branches: git(["branch", "-a"], victim).stdout,
      head: git(["rev-parse", "HEAD"], victim).stdout,
      config: readFileSync(join(victim, ".git", "config"), "utf8"),
    };

    const savedDir = process.env.GIT_DIR;
    const savedWorkTree = process.env.GIT_WORK_TREE;
    // Real hook-set values are absolute paths to the OUTER repo's gitdir/worktree —
    // mirror that shape exactly rather than a plausible-looking stand-in.
    process.env.GIT_DIR = join(victim, ".git");
    process.env.GIT_WORK_TREE = victim;
    try {
      withRepo("feature/reg-b420", (repo) => {
        repo.commitFile("apps/api/src/thing.ts", "export const x = 1;\n", "reg-b420 fixture op");
      });
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
      if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = savedWorkTree;
    }

    const after = {
      branches: git(["branch", "-a"], victim).stdout,
      head: git(["rev-parse", "HEAD"], victim).stdout,
      config: readFileSync(join(victim, ".git", "config"), "utf8"),
    };
    check(
      "REG-B420: an ambient GIT_DIR/GIT_WORK_TREE never touches the victim's branches",
      after.branches,
      before.branches,
    );
    check("REG-B420: ...never touches the victim's HEAD", after.head, before.head);
    check("REG-B420: ...never touches the victim's config", after.config, before.config);
    cleanup(victim);
  }

  // ── CL: CHANGELOG entry count (#2229) ─────────────────────────────────────
  // Both live bullet styles count; the 30-entry cap fails at 31; nested bullets,
  // undated bold bullets and CHANGELOG-ARCHIVE.md are never counted. Each case only
  // rewrites the (uncommitted) changelog files, so no drift rule is involved.
  const oldStyle = (i) => `- **2026-08-${String((i % 28) + 1).padStart(2, "0")}** — old entry ${i}`;
  const newStyle = (i) =>
    `- **2026-09-${String((i % 28) + 1).padStart(2, "0")} — new entry ${i}.** body`;
  const changelogCase = (lines, { archive = null } = {}) => {
    let res;
    withRepo("feature/changelog-count", (repo) => {
      const mapDir = join(repo.scratch, ".claude", "code-map");
      writeFileSync(join(mapDir, "CHANGELOG.md"), `# Changelog\n\n${lines.join("\n")}\n`);
      if (archive) writeFileSync(join(mapDir, "CHANGELOG-ARCHIVE.md"), archive);
      res = runScript(repo.scriptCopy, [], repo.scratch);
    });
    return { status: res.status, out: res.stdout + res.stderr };
  };
  const range = (n, f, from = 0) => Array.from({ length: n }, (_, i) => f(from + i));

  {
    const r = changelogCase(range(30, newStyle));
    check("CL1: 30 current-style entries exit 0", r.status, 0);
    check("CL1: ...and are counted (30/30)", r.out.includes("30/30 entries"), true);
  }
  {
    const r = changelogCase(range(31, newStyle));
    check("CL2: 31 current-style entries exit 1", r.status, 1);
    check("CL2: ...naming CHANGELOG ENTRIES", r.out.includes("CHANGELOG ENTRIES:"), true);
    check("CL2: ...with the count 31", r.out.includes("has 31 dated entries"), true);
  }
  {
    const r = changelogCase(range(31, oldStyle));
    check("CL3: 31 old-style entries exit 1", r.status, 1);
  }
  {
    const r = changelogCase([...range(15, oldStyle), ...range(15, newStyle, 15)]);
    check("CL4: 15 old + 15 current = 30, exit 0", r.status, 0);
    check("CL4: ...counted 30/30", r.out.includes("30/30 entries"), true);
    const r2 = changelogCase([...range(16, oldStyle), ...range(15, newStyle, 16)]);
    check("CL4: 16 old + 15 current = 31, exit 1", r2.status, 1);
  }
  {
    const noise = [
      "- **Convention for new sessions:** add a bullet at the top.",
      "  - **2026-09-01 — a nested bullet** is not an entry",
      "-  **2026-09-02** double space is not an entry",
      "- 2026-09-03 plain text, no bold",
      "- **2026-09-0x — malformed date**",
    ];
    const r = changelogCase([...range(30, newStyle), ...noise]);
    check("CL5: undated/nested/malformed bullets are not counted (exit 0)", r.status, 0);
    check("CL5: ...still 30/30", r.out.includes("30/30 entries"), true);
  }
  {
    const archive = `# Code map changelog — archive\n\n${range(45, newStyle).join("\n")}\n`;
    const r = changelogCase(range(30, newStyle), { archive });
    check("CL6: CHANGELOG-ARCHIVE.md entries are not counted (exit 0)", r.status, 0);
    check("CL6: ...30/30, not 75", r.out.includes("30/30 entries"), true);
  }

  console.log(
    failures
      ? `\nvalidate-code-map.stamp.self-test: ${failures} FAILURE(S)`
      : "\nvalidate-code-map.stamp.self-test: all checks passed",
  );
  process.exit(failures ? 1 : 0);
};

main();
