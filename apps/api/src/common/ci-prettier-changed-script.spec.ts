import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #2413 / SA-422g — apps/api/src/billing/tenant-config-snapshot-admin.service.spec.ts reached
// master failing `prettier --check` because lint-staged only formats STAGED paths locally, and
// nothing in CI ran `prettier --check` at all. scripts/ci-prettier-changed.mjs closes that gap:
// diff the PR against its base, keep only the paths Prettier can format, and check exactly
// those. This spec drives the real script (spawned, not imported) against a disposable git
// repo — CI_PRETTIER_CWD redirects it there, the same isolation
// ci-freshness-guard-script.spec.ts uses for its fake-`gh` world, so nothing here touches this
// repo's own tree or history.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/ci-prettier-changed.mjs");
const REAL_PRETTIER_ROOT = path.resolve(__dirname, "../../../../");

// The ONE GIT_* scrub (scripts/lib/scrubbed-git-env.cjs); fixture-git-env-scrub.spec.ts fails a spec
// that runs a fixture `git init` without it (a private copy of the filter does not count). B420: git
// EXPORTS GIT_DIR/GIT_WORK_TREE/... into every child of a hook and verify runs this spec from inside
// pre-push, so an unscrubbed fixture `git` — or the script's own `git diff` — would operate on THIS
// checkout instead of the throwaway repo.
const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs") as {
  scrubbedGitEnv: () => NodeJS.ProcessEnv;
};

let dir: string;

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: scrubbedGitEnv() });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-prettier-changed-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  // Real prettier reads prettier.config.js by walking up from the file being checked, so
  // the fixture needs the repo's own config in scope. Copy it in rather than requiring one
  // to exist relative to the temp dir.
  fs.copyFileSync(
    path.join(REAL_PRETTIER_ROOT, "prettier.config.js"),
    path.join(repo, "prettier.config.js"),
  );
  // .prettierignore is honoured by prettier itself (cwd = the fixture), so the ignore cases below
  // run against the repo's REAL ignore file.
  fs.copyFileSync(
    path.join(REAL_PRETTIER_ROOT, ".prettierignore"),
    path.join(repo, ".prettierignore"),
  );
  return repo;
}

function runScript(repo: string, baseRef: string) {
  return spawnSync(process.execPath, [SCRIPT, baseRef], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...scrubbedGitEnv(),
      CI_PRETTIER_CWD: repo,
      GITHUB_BASE_REF: "",
    },
  });
}

beforeAll(() => {
  dir = initRepo();

  // No node_modules/prettier needed in the fixture: the script resolves the prettier BINARY
  // from its own repoRoot() (this checkout's real install), never from CI_PRETTIER_CWD — only
  // `git diff` and prettier's cwd (for prettier.config.js discovery) run inside `dir`.

  // master: one clean, formatted file.
  fs.writeFileSync(path.join(dir, "clean.js"), 'module.exports = "ok";\n');
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "base"], dir);
  git(["branch", "-q", "-m", "master"], dir);
  git(["update-ref", "refs/remotes/origin/master", "refs/heads/master"], dir);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ci-prettier-changed.mjs contract", () => {
  it("no changed files vs base -> exits 0, nothing to check", () => {
    const r = runScript(dir, "origin/master");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/none Prettier-formattable|all 0 changed/);
  });

  it("a changed, ALREADY-formatted file -> exits 0", () => {
    const branch = path.join(dir); // same worktree; use a feature commit on top of master
    fs.writeFileSync(path.join(dir, "added-clean.ts"), "export const x = 1;\n");
    git(["add", "-A"], branch);
    git(["commit", "-q", "-m", "feat: add clean file"], branch);

    const r = runScript(dir, "origin/master");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/added-clean\.ts/);
    expect(r.stdout).toMatch(/Prettier-clean/);
  });

  it("a changed, UNFORMATTED file -> exits 1 and names the file (the #2413 repro)", () => {
    // A line that violates printWidth: 100 with a trivial single-quote/semicolon violation
    // too, so this fails for the same class of reason the real incident did.
    fs.writeFileSync(
      path.join(dir, "added-dirty.ts"),
      `export const veryLongName = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5, zeta: 6 }\n`,
    );
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "feat: add dirty file"], dir);

    const r = runScript(dir, "origin/master");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/added-dirty\.ts/);
    expect(r.stdout + r.stderr).toMatch(/failed `prettier --check`/);

    // Clean up so later tests in this file diff a clean tree again.
    git(["rm", "-q", "added-dirty.ts"], dir);
    git(["commit", "-q", "-m", "revert dirty file"], dir);
  });

  it("a changed file with an unsupported extension -> skipped, exits 0", () => {
    // Isolate from the earlier cases' commits (added-clean.ts is still on HEAD after the
    // dirty-file revert) — move the baseline up to HEAD first so this case's diff vs
    // origin/master contains ONLY the .png this test is about, not every prior test's file.
    git(["update-ref", "refs/remotes/origin/master", "HEAD"], dir);
    fs.writeFileSync(path.join(dir, "added.png"), "not-really-a-png-but-irrelevant");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "feat: add a non-prettier file"], dir);

    const r = runScript(dir, "origin/master");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/none Prettier-formattable/);
  });

  it("an unresolvable base ref -> exits 2, fails closed rather than silently skipping", () => {
    const r = runScript(dir, "origin/does-not-exist");
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/could not diff/);
  });

  it("a type lint-staged never formats (.html/.scss/.mdx/.mts/.jsonc) is NOT checked, even unformatted", () => {
    // .lintstagedrc.json is the contract: only ts,tsx,js,jsx,mjs,cjs,json,md,yaml,yml,css are
    // formatted at commit time, so CI must not red a PR over anything else (e.g. a regenerated
    // apps/control golden index.html).
    git(["update-ref", "refs/remotes/origin/master", "HEAD"], dir);
    const ugly = "<div   class='a'  >x</div>\n";
    for (const name of ["page.html", "x.scss", "x.mdx", "x.mts", "x.cts", "x.jsonc"]) {
      fs.writeFileSync(path.join(dir, name), ugly);
    }
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "feat: unformatted files of types lint-staged skips"], dir);

    const r = runScript(dir, "origin/master");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/none Prettier-formattable/);
  });

  it("a type lint-staged DOES format (.css) is still checked and fails when unformatted", () => {
    git(["update-ref", "refs/remotes/origin/master", "HEAD"], dir);
    fs.writeFileSync(path.join(dir, "dirty.css"), "a{color:red}\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "feat: dirty css"], dir);

    const r = runScript(dir, "origin/master");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/dirty\.css/);

    git(["rm", "-q", "dirty.css"], dir);
    git(["commit", "-q", "-m", "revert dirty css"], dir);
  });

  it("paths .prettierignore covers (docs/history archives, control golden) are skipped, exit 0", () => {
    git(["update-ref", "refs/remotes/origin/master", "HEAD"], dir);
    fs.mkdirSync(path.join(dir, "docs", "history", "archive"), { recursive: true });
    // unparsable YAML: prettier exits 2 on it unless the ignore file keeps it out
    fs.writeFileSync(
      path.join(dir, "docs", "history", "archive", "findings.yaml"),
      "a: [unclosed\n",
    );
    fs.mkdirSync(path.join(dir, "apps", "control", "test", "fixtures", "acme", "golden"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, "apps", "control", "test", "fixtures", "acme", "golden", "index.html"),
      "<div   class='a'  >x</div>\n",
    );
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "docs: archived and golden files"], dir);

    const r = runScript(dir, "origin/master");
    expect(r.status).toBe(0);
  });

  it("the checked extensions are derived from .lintstagedrc.json, not a second list", () => {
    const rc = JSON.parse(
      fs.readFileSync(path.join(REAL_PRETTIER_ROOT, ".lintstagedrc.json"), "utf8"),
    ) as Record<string, unknown>;
    const globs = Object.keys(rc).join(" ");
    // pin the .md/.css/.yaml shapes the cases above rely on, and the types they rely on being absent
    expect(globs).toMatch(/\bmd\b/);
    expect(globs).toMatch(/\bcss\b/);
    for (const absent of ["html", "scss", "mdx", "mts", "cts", "jsonc"]) {
      expect(globs).not.toMatch(new RegExp(`[{,.]${absent}[},]`));
    }
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain(".lintstagedrc.json");
    expect(src).not.toMatch(/new Set\(\[\s*"\.js"/);
  });
});
