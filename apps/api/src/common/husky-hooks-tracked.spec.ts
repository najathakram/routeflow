import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Git hooks must be impossible to lose. husky points `core.hooksPath` at `.husky/_`, a directory its `prepare` script
 * GENERATES; it used to be untracked, so any tree that skipped `prepare` (a new worktree, `npm ci --ignore-scripts`,
 * which the heavy slot requires) inherited the shared setting but had no directory, and git ran no hooks and said
 * nothing: a push with no verify, exit 0. B642 added a detector and a by-hand repair; it fired three times anyway
 * because someone has to remember to run it. Now `.husky/_` is TRACKED, so every checkout has it. Re-running husky
 * writes byte-identical files AT THE SAME MODES (stubs 100755; `h`, `husky.sh` and `.gitignore` 100644), so `prepare`
 * leaves the tree clean: a mode husky would flip shows as a dirty tree and aborts a switch to an older branch.
 *
 * This pins: every hook in `.husky` has its tracked, executable stub in `.husky/_` and the three helpers are tracked
 * at husky's own mode; `prepare` still targets `.husky/_`; and `core.hooksPath` is either a relative path with tracked
 * hooks or an absolute path (deliberate on the Macs) that holds a runnable pre-push; anything else is a failure.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scrubbedGitEnv } = require(path.join(REPO_ROOT, "scripts", "lib", "scrubbed-git-env.cjs"));

function git(cwd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: scrubbedGitEnv() });
  return { status: r.status ?? -1, out: (r.stdout ?? "").trim() };
}

/** Tracked files under `dir` as { path, mode }, from the index (what a fresh checkout receives). */
function trackedUnder(repo: string, dir: string): Map<string, string> {
  const out = git(repo, ["ls-files", "-s", "--", dir]).out;
  const m = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [meta, file] = line.split("\t");
    m.set(file, meta.split(" ")[0]);
  }
  return m;
}

/**
 * The files husky writes beside the hook stubs, with the mode husky 9.1.7 gives them on every POSIX `prepare`. They are
 * sourced or read, never executed, so they stay 100644: tracking them at 100755 would make `prepare` flip them and leave
 * the tree dirty (a checkout of an older branch then aborts).
 */
const HELPERS = ["h", "husky.sh", ".gitignore"];

/** What is wrong with the hooks a fresh checkout of `repo` would get; [] when nothing. */
export function trackedHookProblems(repo: string): string[] {
  const problems: string[] = [];
  const hooks = fs
    .readdirSync(path.join(repo, ".husky"), { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("_"))
    .map((e) => e.name);
  const stubs = trackedUnder(repo, ".husky/_");
  for (const [names, want, why] of [
    [hooks, "100755", "git ignores a non-executable hook"],
    [HELPERS, "100644", "husky rewrites it as 100644 on every prepare, leaving the tree dirty"],
  ] as const) {
    for (const name of names) {
      const file = `.husky/_/${name}`;
      const mode = stubs.get(file);
      if (mode === undefined)
        problems.push(`${file} is not tracked: a new worktree would have no ${name} hook`);
      else if (mode !== want) problems.push(`${file} is tracked as ${mode}, not ${want}: ${why}`);
    }
  }
  return problems;
}

/**
 * A hooksPath value is safe when it names a directory inside the repo that holds a tracked, executable pre-push stub,
 * or an ABSOLUTE path (the Macs set one deliberately, so trees on older branches keep working hooks) that holds a
 * runnable pre-push right now. Relative stays the default.
 */
export function hooksPathProblem(repo: string, value: string): string | null {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith("~")) {
    const dir = value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
    const prePush = path.join(dir, "pre-push");
    const runnable =
      fs.existsSync(prePush) &&
      fs.statSync(prePush).isFile() &&
      (process.platform === "win32" || (fs.statSync(prePush).mode & 0o111) !== 0);
    return runnable
      ? null
      : `core.hooksPath=${value} is absolute but holds no runnable pre-push: git runs no hooks, silently`;
  }
  const dir = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const mode = trackedUnder(repo, dir).get(`${dir}/pre-push`);
  return mode === "100755"
    ? null
    : `core.hooksPath=${value} points at ${dir}, which has no TRACKED, executable pre-push: a tree without it runs no hooks, silently`;
}

function makeRepo(opts: { trackStubs: boolean; mode?: string; helperMode?: string }): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-"));
  git(repo, ["init", "-q"]);
  fs.mkdirSync(path.join(repo, ".husky", "_"), { recursive: true });
  const hooks = ["pre-push", "pre-commit", "commit-msg"];
  for (const name of hooks) {
    fs.writeFileSync(path.join(repo, ".husky", name), "echo hook\n");
    fs.writeFileSync(path.join(repo, ".husky", "_", name), '. "$(dirname "$0")/h"\n');
  }
  for (const name of HELPERS) fs.writeFileSync(path.join(repo, ".husky", "_", name), "exit 0\n");
  git(repo, ["add", ".husky/pre-push", ".husky/pre-commit", ".husky/commit-msg"]);
  if (opts.trackStubs) {
    git(repo, ["add", "-f", ".husky/_"]);
    const chmod = (flag: string, names: string[]) =>
      git(repo, ["update-index", flag, "--", ...names.map((n) => `.husky/_/${n}`)]);
    chmod(opts.mode === "100644" ? "--chmod=-x" : "--chmod=+x", hooks);
    chmod(opts.helperMode === "100755" ? "--chmod=+x" : "--chmod=-x", HELPERS);
  }
  return repo;
}

describe("husky hooks are tracked (fixture repos)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const fixture = (o: { trackStubs: boolean; mode?: string; helperMode?: string }) => {
    const d = makeRepo(o);
    dirs.push(d);
    return d;
  };

  it("an untracked .husky/_ (the old state) is reported once per hook plus each helper", () => {
    const problems = trackedHookProblems(fixture({ trackStubs: false }));
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).toContain(".husky/_/pre-push is not tracked");
    expect(problems.join("\n")).toContain(".husky/_/h is not tracked");
  });

  it("a tracked but non-executable stub is reported (git would ignore it)", () => {
    const problems = trackedHookProblems(fixture({ trackStubs: true, mode: "100644" }));
    expect(problems.join("\n")).toContain("not 100755");
  });

  it("a helper tracked executable is reported: husky rewrites it 100644 and the tree goes dirty", () => {
    const problems = trackedHookProblems(fixture({ trackStubs: true, helperMode: "100755" }));
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain(".husky/_/h is tracked as 100755, not 100644");
  });

  it("tracked hooks at 100755 and helpers at 100644 pass", () => {
    expect(trackedHookProblems(fixture({ trackStubs: true }))).toEqual([]);
  });

  it("hooksPath: relative to a tracked dir passes; an untracked or hook-less one fails", () => {
    const tracked = fixture({ trackStubs: true });
    const untracked = fixture({ trackStubs: false });
    expect(hooksPathProblem(tracked, ".husky/_")).toBeNull();
    expect(hooksPathProblem(untracked, ".husky/_")).toContain("no TRACKED, executable pre-push");
    // the hand-written hooks are tracked but not executable and have no shebang: git ignores or fails on them
    expect(hooksPathProblem(tracked, ".husky")).toContain("no TRACKED, executable pre-push");
  });

  it("hooksPath: an absolute path is accepted only while it holds a runnable pre-push", () => {
    const withHooks = fixture({ trackStubs: false });
    const dir = path.join(withHooks, ".husky", "_");
    fs.chmodSync(path.join(dir, "pre-push"), 0o755);
    expect(hooksPathProblem(withHooks, dir)).toBeNull(); // the Macs' deliberate absolute value
    expect(hooksPathProblem(withHooks, path.join(withHooks, "nowhere"))).toContain(
      "holds no runnable pre-push",
    );
    if (process.platform !== "win32") {
      fs.chmodSync(path.join(dir, "pre-push"), 0o644);
      expect(hooksPathProblem(withHooks, dir)).toContain("holds no runnable pre-push");
    }
  });
});

describe("the real repo's hooks", () => {
  it("every .husky hook has a tracked, executable stub in .husky/_ (and the runner h)", () => {
    expect(trackedHookProblems(REPO_ROOT)).toEqual([]);
  });

  it("`prepare` still runs plain `husky`, whose target is the tracked .husky/_", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.prepare).toBe("husky");
  });

  it("this checkout's core.hooksPath (when set) points at a tracked directory", () => {
    const set = git(REPO_ROOT, ["config", "--get", "core.hooksPath"]);
    if (set.status !== 0) return; // unset: CI before `prepare`, nothing to judge
    expect(hooksPathProblem(REPO_ROOT, set.out)).toBeNull();
  });
});
