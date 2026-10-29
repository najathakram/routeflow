// registry-fixture.mjs — the shared fixture of the register self-tests (B1-b1): a local bare repo (the
// "remote") plus clones, a check() that counts, a section() that survives a throw. Test-only: nothing
// in production imports this. fixture(prefix) returns one world per self-test process.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedGitEnv } from "./check-git-hooks.mjs";

export const PFX = "registry/campaign";
const GIT = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "core.autocrlf=false"];
const GIT_ID = [...GIT, "-c", "user.name=t", "-c", "user.email=t@t"];

export function git(cwd, ...args) {
  const r = spawnSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export const rowsOf = (text) => text.split("\n").filter(Boolean);
export const append = (file, text) => (root) => appendFileSync(join(root, file), text);
export const spawned = (args, e) =>
  new Promise((done) => {
    const p = spawn("node", args, { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => done({ code, out }));
  });

export function fixture(prefix) {
  let passes = 0;
  let failures = 0;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const bare = join(tmp, "remote.git");
  process.env.RF_REGISTRY_REMOTE = bare; // the origin check compares a clone's origin with this

  function check(name, got, want = true) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) passes++;
    else failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
  }
  async function section(title, body) {
    console.log(title);
    try {
      await body();
    } catch (e) {
      failures++;
      console.log(`  FAIL ${title} threw: ${String(e.message ?? e).slice(0, 160)}`);
    }
  }
  function world() {
    git(tmp, "init", "--bare", "--initial-branch=main", bare);
    const seed = join(tmp, "seed");
    git(tmp, "init", "--initial-branch=main", seed);
    mkdirSync(join(seed, PFX, "bugs"), { recursive: true });
    writeFileSync(join(seed, PFX, "bugs.jsonl"), "");
    writeFileSync(join(seed, PFX, "rows.txt"), "base\n");
    const body = ["Summary: one", "l1", "l2", "l3", "l4", "l5", "## History", "- a", ""].join("\n");
    writeFileSync(join(seed, PFX, "bugs", "B12.md"), body);
    writeFileSync(
      join(seed, ".gitignore"),
      `${PFX}/**/*.lock/\n.registry-write.lock/\n.campaign/\n`,
    );
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "seed");
    git(seed, "push", bare, "main");
  }
  // Another machine lands a commit on origin/main (via its own clone).
  const other = (dir, edit) => {
    git(dir, "fetch", "origin", "main");
    git(dir, "reset", "--hard", "origin/main");
    edit(join(dir, PFX));
    git(dir, "commit", "-a", "-m", "other");
    git(dir, "push", "origin", "HEAD:main");
  };
  return {
    tmp,
    bare,
    check,
    section,
    world,
    other,
    env: (extra = {}) => ({ ...scrubbedGitEnv(), ...extra }),
    showOrigin: (p) => git(bare, "show", `main:${PFX}/${p}`),
    clean: (dir) => git(dir, "status", "--porcelain", "--", PFX) === "",
    clone: (name) => {
      git(tmp, "-c", "core.autocrlf=false", "clone", "--branch", "main", bare, name);
      return join(tmp, name);
    },
    // Prints the summary, removes the fixture, exits 1 on a failure.
    finish: (name) => {
      rmSync(tmp, { recursive: true, force: true });
      console.log(`${name} self-test: ${passes} passed, ${failures} failed`);
      process.exit(failures ? 1 : 0);
    },
  };
}
