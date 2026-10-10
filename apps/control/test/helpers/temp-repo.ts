/**
 * Throwaway git worlds for the WP3 specs: a bare "origin" plus seed/clone directories, all under
 * os.tmpdir(), all LOCAL (file:// URLs), never the network and never the real repo. Every git call
 * is `execFileSync("git", [...args])` (no shell). Call `world.cleanup()` in `afterEach`.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rmTree } from "./platform";

export const STATE_BRANCH = "ctl/state";
export const ARCHIVE_BRANCH = "ctl/archive";
export const NOW = "2026-01-12T10:00:00Z";

/**
 * Every helper that runs git or the CLI starts from this: git speaks only `file` and cannot run
 * ssh, so a spec (or a regressed guard under test) can never reach a real host. Callers that need
 * http (the 127.0.0.1 redirect specs) override it explicitly.
 */
export const OFFLINE_GIT_ENV = { GIT_ALLOW_PROTOCOL: "file", GIT_SSH_COMMAND: "false" } as const;

const GIT_ENV = {
  ...process.env,
  ...OFFLINE_GIT_ENV,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: ["test", "example.invalid"].join("@"),
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: ["test", "example.invalid"].join("@"),
};

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" });
}

export interface World {
  root: string;
  /** file:// URL of the bare origin. */
  originUrl: string;
  originDir: string;
  /** Commit `files` (path -> text) as a fresh orphan `branch` on the origin. */
  seedBranch(branch: string, files: Record<string, string>): void;
  /** Env object for the code under test; `name` picks a distinct clone dir ("machine"). */
  env(name: string, extra?: Record<string, unknown>): Record<string, any>;
  cloneDirOf(name: string): string;
  /** `git show <branch>:<file>` on the origin ("" when absent). */
  remoteFile(file: string, branch?: string): string;
  remoteLines(lane: string, branch?: string): any[];
  remoteHead(branch?: string): string;
  remoteHas(branch: string): boolean;
  /** Fresh `--depth=1 --single-branch` clone of `branch`; returns its dir. */
  shallowClone(branch: string, name: string): string;
  cleanup(): void;
}

export function makeWorld(): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-wp3-"));
  const originDir = path.join(root, "origin.git");
  fs.mkdirSync(originDir);
  git(originDir, ["init", "-q", "--bare", "--initial-branch=main"]);
  const originUrl = `file://${originDir}`;
  const cloneDirOf = (name: string) => path.join(root, `clone-${name}`);

  const world: World = {
    root,
    originUrl,
    originDir,
    seedBranch(branch, files) {
      const dir = fs.mkdtempSync(path.join(root, "seed-"));
      git(dir, ["init", "-q", "--initial-branch", branch]);
      for (const [rel, text] of Object.entries(files)) {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
      }
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "seed"]);
      git(dir, ["push", "-q", originUrl, `HEAD:refs/heads/${branch}`]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    env(name, extra = {}) {
      return {
        origin: originUrl,
        cloneDir: cloneDirOf(name),
        stateBranch: STATE_BRANCH,
        archiveBranch: ARCHIVE_BRANCH,
        registers: { tasks: [], releases: [] },
        now: () => NOW,
        sleep: async () => undefined,
        ...extra,
      };
    },
    cloneDirOf,
    remoteFile(file, branch = STATE_BRANCH) {
      try {
        return git(originDir, ["show", `${branch}:${file}`]);
      } catch {
        return "";
      }
    },
    remoteLines(lane, branch = STATE_BRANCH) {
      return world
        .remoteFile(`events/${lane}.jsonl`, branch)
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
    remoteHead(branch = STATE_BRANCH) {
      return git(originDir, ["rev-parse", branch]).trim();
    },
    remoteHas(branch) {
      try {
        git(originDir, ["rev-parse", "--verify", "-q", branch]);
        return true;
      } catch {
        return false;
      }
    },
    shallowClone(branch, name) {
      const dir = cloneDirOf(name);
      git(root, [
        "clone",
        "-q",
        "--depth=1",
        "--single-branch",
        "--branch",
        branch,
        originUrl,
        dir,
      ]);
      return dir;
    },
    cleanup() {
      rmTree(root);
    },
  };
  return world;
}

/** JSON line helper. */
export const jl = (o: unknown): string => JSON.stringify(o) + "\n";

/** Small valid state: lead registers lane-u / lane-v, creates RF-1; lane-u has `n` notes. */
export function baseState(n = 4): Record<string, string> {
  const lead = [
    {
      seq: 1,
      ts: "2026-01-09T08:00:00Z",
      lane: "lead",
      type: "lane.registered",
      by: "agent",
      laneId: "lead",
      name: "Lead",
      machine: "mac",
      kind: "lead",
      active: true,
    },
    {
      seq: 2,
      ts: "2026-01-09T08:00:01Z",
      lane: "lead",
      type: "lane.registered",
      by: "agent",
      laneId: "lane-u",
      name: "Lane U",
      machine: "mac",
      kind: "feature",
      active: true,
    },
    {
      seq: 3,
      ts: "2026-01-09T08:00:02Z",
      lane: "lead",
      type: "lane.registered",
      by: "agent",
      laneId: "lane-v",
      name: "Lane V",
      machine: "mac",
      kind: "feature",
      active: true,
    },
    {
      seq: 4,
      ts: "2026-01-09T08:10:00Z",
      lane: "lead",
      type: "task.created",
      by: "agent",
      id: "RF-1",
      title: "acme: sample task",
      kind: "feature",
    },
  ];
  const u = Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    ts: `2026-01-10T09:0${i}:00Z`,
    lane: "lane-u",
    type: "lane.note",
    by: "agent",
    note: `seed ${i + 1}`,
  }));
  return {
    "events/lead.jsonl": lead.map(jl).join(""),
    "events/lane-u.jsonl": u.map(jl).join(""),
    "README.md": "state branch (synthetic test seed)\n",
  };
}
