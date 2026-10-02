import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// B897 — scripts/push-guard.mjs, the pre-push guard against pushing build/cache output or a heavy
// push. Origin: #2742 pushed a commit that added 2,401 `.jest-cache/` files (~38 MB, source maps
// carrying an absolute path) because `git add -A` on whole directories ran on a branch cut before
// `.jest-cache/` was in `.gitignore`. Every case drives the REAL script against a throwaway git
// repo, so the contract is the process's own exit status and stderr.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/push-guard.mjs");
const MIB = 1024 * 1024;

// B420: git EXPORTS repo-scoped variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...) into a hook,
// and verify runs this spec from inside pre-push, so a plain spawn here would operate on THAT repo
// (a hijacked GIT_DIR once wrote config into another repository). Every git call and the script's
// own env go through the ONE `scrubbedGitEnv()` (scripts/lib/scrubbed-git-env.cjs, which strips every
// GIT_* variable); fixture-git-env-scrub.spec.ts pins that each git spawn passes it.
const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs") as {
  scrubbedGitEnv: () => NodeJS.ProcessEnv;
};
const CLEAN_GIT_ENV: NodeJS.ProcessEnv = scrubbedGitEnv();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: scrubbedGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describe("push-guard.mjs contract (B897)", () => {
  let repo: string;
  let base: string;
  let n = 0;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "push-guard-"));
    git(repo, "init", "-q", "-b", "master");
    git(repo, "config", "user.email", "t@example.test");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "commit.gpgsign", "false");
    write("README.md", "base\n");
    base = commit("base");
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  function write(rel: string, content: string | Buffer) {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  /** A file of `bytes` distinct bytes (distinct content per call, so blobs never dedupe). */
  function blob(bytes: number): Buffer {
    n += 1;
    const buf = Buffer.alloc(bytes, n % 251);
    buf.write(`unique-${n}-${Math.random()}`);
    return buf;
  }

  function commit(msg: string): string {
    git(repo, "add", "-A", "-f");
    git(repo, "commit", "-q", "-m", msg);
    return git(repo, "rev-parse", "HEAD");
  }

  function guard(args: string[] = [], env: Record<string, string> = {}, input?: string) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf8",
      input,
      env: { ...CLEAN_GIT_ENV, PUSH_GUARD_OVERRIDE_REASON: "", ...env },
    });
  }

  const range = () => ["--base", base, "--head", "HEAD"];

  it("a clean push exits 0 and says so", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit("add a");
    const res = guard(range());
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/refus/i);
  });

  it("refuses a commit that adds .jest-cache files (the #2742 incident), naming the dir and the count", () => {
    for (let i = 0; i < 3; i++)
      write(`apps/mobile/.jest-cache/jest-transform-cache-x/${i}/f`, `c${i}`);
    commit("oops");
    const res = guard(range());
    expect(res.stderr).toContain(".jest-cache");
    expect(res.stderr).toMatch(/3 file\(s\)/);
    expect(res.status).toBe(1);
  });

  it.each([
    [".turbo/cache/x", ".turbo"],
    ["apps/web/.next/cache/y", ".next"],
    ["packages/pricing/dist/index.js", "dist"],
    ["apps/api/coverage/lcov.info", "coverage"],
    ["packages/x/node_modules/left-pad/index.js", "node_modules"],
  ])("refuses an added %s", (file, dir) => {
    write(file, "x");
    commit("add build output");
    const res = guard(range());
    expect(res.stderr).toContain(dir);
    expect(res.status).toBe(1);
  });

  it("matches whole path segments only: distance/, dist.md, coverage-notes.md and a .nextjs dir are fine", () => {
    write("docs/distance/a.md", "x");
    write("docs/dist.md", "x");
    write("docs/coverage-notes.md", "x");
    write("docs/.nextjs/a.md", "x");
    commit("innocent look-alikes");
    expect(guard(range()).status).toBe(0);
  });

  it("counts a file added in ANY commit of the range, even when a later commit deletes it (the bloat is in the pushed history)", () => {
    write("apps/web/.next/trace", "x");
    commit("add");
    fs.rmSync(path.join(repo, "apps/web/.next"), { recursive: true });
    commit("remove");
    const res = guard(range());
    expect(res.stderr).toContain(".next");
    expect(res.status).toBe(1);
  });

  it("does not refuse MODIFYING a file that already lived under such a dir at the base (only ADDS count)", () => {
    write("packages/legacy/dist/a.js", "one");
    base = commit("legacy dist already tracked");
    write("packages/legacy/dist/a.js", "two");
    commit("touch it");
    expect(guard(range()).status).toBe(0);
  });

  it("refuses a single file over the cap, naming it and its size", () => {
    write("packages/x/big.bin", blob(6 * MIB));
    commit("big");
    const res = guard(range());
    expect(res.stderr).toContain("packages/x/big.bin");
    expect(res.stderr).toMatch(/6\.0 MiB/);
    expect(res.status).toBe(1);
  });

  it("refuses several files that together pass the cap (3 x 2 MiB > 5 MiB)", () => {
    for (let i = 0; i < 3; i++) write(`assets/f${i}.bin`, blob(2 * MIB));
    commit("three");
    expect(guard(range()).status).toBe(1);
  });

  it("allows a push under the cap (4 MiB)", () => {
    write("packages/x/ok.bin", blob(4 * MIB));
    commit("ok");
    expect(guard(range()).status).toBe(0);
  });

  it.each([
    "apps/mobile/assets/icon-big.bin",
    "apps/web/public/brand/hero.bin",
    "apps/web/public/marketing/photo.bin",
    "apps/web/fonts/Geist.bin",
  ])(
    "does not count %s (the heavy-files policy's allow-listed asset dirs) toward the size cap",
    (file) => {
      write(file, blob(6 * MIB));
      commit("required build asset");
      expect(guard(range()).status).toBe(0);
    },
  );

  it("an override needs a non-blank reason; with one it lets the push through and writes an audit line, without one it still refuses", () => {
    write("apps/mobile/.jest-cache/a", "x");
    commit("cache");
    expect(guard(range(), { PUSH_GUARD_OVERRIDE_REASON: "   " }).status).toBe(1);
    const res = guard(range(), { PUSH_GUARD_OVERRIDE_REASON: "vendored fixture, reviewed" });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/override/i);
    const log = fs.readFileSync(path.join(repo, ".git", "push-guard.log"), "utf8");
    expect(log).toContain("vendored fixture, reviewed");
    expect(log).toContain(".jest-cache");
  });

  describe("hook mode (the pre-push stdin: <local ref> <local sha> <remote ref> <remote sha>)", () => {
    const ZERO = "0".repeat(40);

    it("a NEW branch is checked against the merge-base with origin/master", () => {
      git(repo, "update-ref", "refs/remotes/origin/master", base);
      write("apps/web/.next/x", "x");
      const head = commit("cache");
      const res = guard([], {}, `refs/heads/f ${head} refs/heads/f ${ZERO}\n`);
      expect(res.stderr).toContain(".next");
      expect(res.status).toBe(1);
    });

    it("an UPDATE is checked against the remote sha, so already-pushed commits are not re-judged", () => {
      write("apps/web/.next/x", "x");
      const pushed = commit("already on the remote");
      write("src/b.ts", "b");
      const head = commit("new");
      const res = guard([], {}, `refs/heads/f ${head} refs/heads/f ${pushed}\n`);
      expect(res.status).toBe(0);
    });

    it("merging master into the branch does not re-judge what master already carries (commits reachable from origin/master are excluded)", () => {
      git(repo, "switch", "-q", "-c", "feature");
      write("src/f.ts", "f");
      const pushed = commit("feature work");
      git(repo, "switch", "-q", "master");
      write("packages/legacy/dist/a.js", "landed on master with its own review");
      const masterHead = commit("master moves");
      git(repo, "update-ref", "refs/remotes/origin/master", masterHead);
      git(repo, "switch", "-q", "feature");
      git(repo, "merge", "-q", "--no-edit", "master");
      const head = git(repo, "rev-parse", "HEAD");
      const res = guard([], {}, `refs/heads/feature ${head} refs/heads/feature ${pushed}\n`);
      expect(res.status).toBe(0);
    });

    it("a STALE origin/master, and another lane's pushed branch merged in, do not trip the guard (everything under origin/* is excluded, not just master)", () => {
      // origin/master is stale (still at the base). Another lane pushed origin/laneB, which added
      // a dist file; this branch merged that lane's work, so its range now carries those commits.
      git(repo, "update-ref", "refs/remotes/origin/master", base);
      git(repo, "switch", "-q", "-c", "laneB");
      write("packages/other/dist/a.js", "the other lane's reviewed, already-pushed work");
      const laneHead = commit("laneB");
      git(repo, "update-ref", "refs/remotes/origin/laneB", laneHead);
      git(repo, "switch", "-q", "master");
      git(repo, "switch", "-q", "-c", "feature");
      write("src/f.ts", "f");
      const pushed = commit("feature work");
      git(repo, "merge", "-q", "--no-edit", "laneB");
      const head = git(repo, "rev-parse", "HEAD");
      const res = guard([], {}, `refs/heads/feature ${head} refs/heads/feature ${pushed}\n`);
      expect(res.status).toBe(0);
    });

    it("an override on a range the guard could not check logs the ACTUAL error (exit 2 without it, exit 0 with a reasoned override, both naming the cause)", () => {
      // No origin/master and a remote sha the repo does not have: nothing to resolve a base from.
      const head = git(repo, "rev-parse", "HEAD");
      const stdin = `refs/heads/f ${head} refs/heads/f ${"1".repeat(40)}\n`;
      const refused = guard([], {}, stdin);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("could not resolve a base");
      const res = guard(
        [],
        { PUSH_GUARD_OVERRIDE_REASON: "remote unreachable, reviewed by hand" },
        stdin,
      );
      expect(res.status).toBe(0);
      expect(res.stderr).toContain("could not resolve a base");
      const log = fs.readFileSync(path.join(repo, ".git", "push-guard.log"), "utf8");
      expect(log).toContain("remote unreachable, reviewed by hand");
      expect(log).toContain("could not resolve a base");
    });

    it("a branch deletion (local sha all zeros) is never blocked", () => {
      const res = guard([], {}, `(delete) ${ZERO} refs/heads/f ${base}\n`);
      expect(res.status).toBe(0);
    });

    it("no stdin refs and no --base: nothing to check, exit 0", () => {
      expect(guard([], {}, "").status).toBe(0);
    });
  });

  it("the fixture env comes from the shared scrub and carries no GIT_* variable", () => {
    expect(Object.keys(CLEAN_GIT_ENV).some((k) => k.startsWith("GIT_"))).toBe(false);
    expect(Object.keys(CLEAN_GIT_ENV).length).toBeGreaterThan(0);
  });

  it("the hook runs the guard before SKIP_VERIFY and verify, passing it the pre-push stdin", () => {
    const hook = fs.readFileSync(path.resolve(__dirname, "../../../../.husky/pre-push"), "utf8");
    const guardAt = hook.indexOf("scripts/push-guard.mjs");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(hook.indexOf('if [ "$SKIP_VERIFY" = "1" ]'));
    expect(guardAt).toBeLessThan(hook.indexOf("npm run verify || exit 1"));
    expect(hook).toMatch(/refs="\$\(cat\)"/);
  });
});
