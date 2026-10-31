import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Git hooks must be impossible to lose. husky points `core.hooksPath` at `.husky/_`, a directory its `prepare` script
 * GENERATES; it used to be untracked, so any tree that skipped `prepare` (a new worktree, `npm ci --ignore-scripts`,
 * which the heavy slot requires) inherited the shared setting but had no directory, and git ran no hooks and said
 * nothing: a push with no verify, exit 0. B642 added a detector and a by-hand repair; it fired three times anyway
 * because someone has to remember to run it. Now `.husky/_` is TRACKED (mode 100755), so every checkout has it.
 * Re-running husky writes byte-identical files, so `prepare` and the tracked copy agree.
 *
 * This pins: every hook in `.husky` has its tracked, executable stub in `.husky/_` (and the `h` runner they source);
 * `prepare` still targets `.husky/_`; and a `core.hooksPath` that points anywhere untracked is a failure.
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

/** What is wrong with the hooks a fresh checkout of `repo` would get; [] when nothing. */
export function trackedHookProblems(repo: string): string[] {
  const problems: string[] = [];
  const hooks = fs
    .readdirSync(path.join(repo, ".husky"), { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("_"))
    .map((e) => e.name);
  const stubs = trackedUnder(repo, ".husky/_");
  for (const name of [...hooks, "h"]) {
    const file = `.husky/_/${name}`;
    const mode = stubs.get(file);
    if (mode === undefined)
      problems.push(`${file} is not tracked: a new worktree would have no ${name} hook`);
    else if (mode !== "100755")
      problems.push(`${file} is tracked as ${mode}, not 100755: git ignores a non-executable hook`);
  }
  return problems;
}

/** A hooksPath value is safe only when it names a directory inside the repo that holds a tracked pre-push stub. */
export function hooksPathProblem(repo: string, value: string): string | null {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith("~")) {
    return `core.hooksPath=${value} is outside the repository: no checkout carries it`;
  }
  const dir = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const mode = trackedUnder(repo, dir).get(`${dir}/pre-push`);
  return mode === "100755"
    ? null
    : `core.hooksPath=${value} points at ${dir}, which has no TRACKED, executable pre-push: a tree without it runs no hooks, silently`;
}

function makeRepo(opts: { trackStubs: boolean; mode?: string }): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-"));
  git(repo, ["init", "-q"]);
  fs.mkdirSync(path.join(repo, ".husky", "_"), { recursive: true });
  for (const name of ["pre-push", "pre-commit", "commit-msg"]) {
    fs.writeFileSync(path.join(repo, ".husky", name), "echo hook\n");
    fs.writeFileSync(path.join(repo, ".husky", "_", name), '. "$(dirname "$0")/h"\n');
  }
  fs.writeFileSync(path.join(repo, ".husky", "_", "h"), "exit 0\n");
  git(repo, ["add", ".husky/pre-push", ".husky/pre-commit", ".husky/commit-msg"]);
  if (opts.trackStubs) {
    git(repo, ["add", "-f", ".husky/_"]);
    git(repo, [
      "update-index",
      "--chmod=" + (opts.mode === "100644" ? "-x" : "+x"),
      "--",
      ...Array.from(trackedUnder(repo, ".husky/_").keys()),
    ]);
  }
  return repo;
}

describe("husky hooks are tracked (fixture repos)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const fixture = (o: { trackStubs: boolean; mode?: string }) => {
    const d = makeRepo(o);
    dirs.push(d);
    return d;
  };

  it("an untracked .husky/_ (the old state) is reported once per hook plus the runner", () => {
    const problems = trackedHookProblems(fixture({ trackStubs: false }));
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain(".husky/_/pre-push is not tracked");
    expect(problems.join("\n")).toContain(".husky/_/h is not tracked");
  });

  it("a tracked but non-executable stub is reported (git would ignore it)", () => {
    const problems = trackedHookProblems(fixture({ trackStubs: true, mode: "100644" }));
    expect(problems.join("\n")).toContain("not 100755");
  });

  it("tracked, executable stubs pass", () => {
    expect(trackedHookProblems(fixture({ trackStubs: true }))).toEqual([]);
  });

  it("hooksPath: relative to a tracked dir passes; to an untracked or absolute path fails", () => {
    const tracked = fixture({ trackStubs: true });
    const untracked = fixture({ trackStubs: false });
    expect(hooksPathProblem(tracked, ".husky/_")).toBeNull();
    expect(hooksPathProblem(untracked, ".husky/_")).toContain("no TRACKED, executable pre-push");
    // the hand-written hooks are tracked but not executable and have no shebang: git ignores or fails on them
    expect(hooksPathProblem(tracked, ".husky")).toContain("no TRACKED, executable pre-push");
    expect(hooksPathProblem(tracked, "C:/somewhere/hooks")).toContain("outside the repository");
    expect(hooksPathProblem(tracked, "/opt/hooks")).toContain("outside the repository");
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
