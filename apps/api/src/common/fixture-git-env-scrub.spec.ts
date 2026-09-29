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
 *  1. static — every tracked-source file that runs a fixture `git init` must carry a scrub
 *     (literal GIT_DIR, a `GIT_` prefix filter, or the shared `gitEnv()` helper);
 *  2. behavioral — `stop.gates.spec.mjs` run with GIT_DIR/GIT_WORK_TREE pointed at a throwaway
 *     "poison" repo must leave that repo untouched (never the real one).
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SELF = path.basename(__filename);
const SCAN_DIRS = [
  ".claude/hooks",
  ".claude/skills",
  "scripts",
  "apps/api/scripts",
  "apps/api/src",
];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "worktrees", ".git"]);

// A fixture repo is created: `["init", ...]` or `git("init", "-q", ...)`.
const FIXTURE_INIT_RE = /\[\s*["']init["']\s*[,\]]|\(\s*["']init["']\s*,\s*["']-/;
// Any accepted scrub form.
const SCRUB_RE = /GIT_DIR|\^GIT_|startsWith\(\s*["']GIT_["']\s*\)|\bgitEnv\b/;

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

const GIT_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of GIT_KEYS) delete env[k];
  return env;
}

describe("fixture git repos scrub git's repo-scoped env", () => {
  it("every file that runs a fixture `git init` carries a GIT_* scrub", () => {
    const offenders = SCAN_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d)))
      .filter((f) => {
        const src = fs.readFileSync(f, "utf8");
        return FIXTURE_INIT_RE.test(src) && !SCRUB_RE.test(src);
      })
      .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("stop.gates.spec.mjs never touches the repo GIT_DIR points at", () => {
    const poison = fs.mkdtempSync(path.join(os.tmpdir(), "poison-repo-"));
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: poison, encoding: "utf8", env: cleanEnv() });
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
            ...process.env,
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
