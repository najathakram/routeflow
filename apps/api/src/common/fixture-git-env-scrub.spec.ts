/**
 * Tripwire — a script/spec that builds a THROWAWAY git repo must scrub git's repo-scoped env.
 *
 * WHY: git EXPORTS GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE … into every hook it runs (the pre-push
 * gate runs `npm run verify`), and every child inherits them. A fixture that runs `git init` /
 * `git config` in a temp dir with that env inherited does NOT touch the temp dir — it re-points at
 * the REAL repository: `git init` re-initialises it and `git config user.*` rewrites the shared
 * `.git/config` (core.bare=true, a fixture identity). That took the whole PC's git down once
 * (`.claude/hooks/stop.gates.spec.mjs`). `scripts/campaign/bugs.mjs`'s self-test already scrubs.
 *
 * Two guards:
 *  1. static — every source file that runs a fixture `git init` must CALL the shared helper
 *     (`scrubbedGitEnv()` from scripts/lib/check-git-hooks.mjs, or `gitEnv()`); merely mentioning
 *     GIT_DIR, or carrying a private copy of the filter, does not count;
 *  2. behavioral — `stop.gates.spec.mjs` run with GIT_DIR/GIT_WORK_TREE pointed at a throwaway
 *     "poison" repo must leave that repo untouched (never the real one).
 *
 * The helper has ONE definition, scripts/lib/scrubbed-git-env.cjs (re-exported by
 * scripts/lib/check-git-hooks.mjs for .mjs callers; required here because ts-jest compiles CJS).
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SELF = path.basename(__filename);
const SCAN_DIRS = [
  ".claude",
  "scripts",
  "apps/api/scripts",
  "apps/api/src",
  "apps/web",
  "apps/mobile",
  "packages",
];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "worktrees",
  ".git",
  ".turbo",
  ".expo",
  "coverage",
]);

// A fixture repo is created: `["init", ...]`, `git("init", "-q", ...)`, or the string form
// `execSync("git init ...")` / `exec("git init`.
const FIXTURE_INIT_RE =
  /\[\s*["']init["']\s*[,\]]|\(\s*["']init["']\s*,\s*["']-|exec(?:Sync)?\(\s*["'`]git\s+init\b/;
// The ONLY accepted scrub: a CALL to the shared helper (or plane-client's gitEnv()).
const SCRUB_RE = /\b(scrubbedGitEnv|gitEnv)\(/;

// Same single definition the .mjs scripts get through check-git-hooks.mjs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs") as {
  scrubbedGitEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.(mjs|cjs|js|ts)$/.test(entry.name) && entry.name !== SELF) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("fixture git repos scrub git's repo-scoped env", () => {
  it("every file that runs a fixture `git init` calls the shared GIT_* scrub", () => {
    const files = SCAN_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d)));
    const fixtureFiles = files.filter((f) => FIXTURE_INIT_RE.test(fs.readFileSync(f, "utf8")));
    // The scan must be looking at something, or an empty walk would pass vacuously.
    expect(files.length).toBeGreaterThan(0);
    expect(fixtureFiles.length).toBeGreaterThan(0);
    const offenders = fixtureFiles
      .filter((f) => !SCRUB_RE.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("stop.gates.spec.mjs never touches the repo GIT_DIR points at", () => {
    const poison = fs.mkdtempSync(path.join(os.tmpdir(), "poison-repo-"));
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: poison, encoding: "utf8", env: scrubbedGitEnv() });
    try {
      git(["init", "-q"]);
      git(["config", "user.name", "poison-sentinel"]);
      git(["config", "user.email", "poison@example.com"]);
      fs.writeFileSync(path.join(poison, "seed.txt"), "seed\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "seed"]);
      const configPath = path.join(poison, ".git", "config");
      const before = fs.readFileSync(configPath, "utf8");
      const headBefore = git(["rev-parse", "HEAD"]).stdout.trim();

      const res = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, ".claude/hooks/stop.gates.spec.mjs")],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 120_000,
          env: {
            ...scrubbedGitEnv(),
            GIT_DIR: path.join(poison, ".git"),
            GIT_WORK_TREE: poison,
          },
        },
      );

      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(git(["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore);
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(poison, { recursive: true, force: true });
    }
  }, 180_000);
});
