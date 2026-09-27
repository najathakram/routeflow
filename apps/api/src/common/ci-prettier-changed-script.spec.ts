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

let dir: string;

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
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
  return repo;
}

function runScript(repo: string, baseRef: string) {
  return spawnSync(process.execPath, [SCRIPT, baseRef], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
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
});
