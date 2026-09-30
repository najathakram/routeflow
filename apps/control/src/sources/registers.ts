/** Register loader: fixture dir or `git show <sha>:<path>`. Read-only; no network. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  bugsAsTasks,
  deferredAsTasks,
  featuresAsTasks,
  registerTasks,
  releasesFromRegister,
} from "../domain/adapters";
import type { AdaptedTask, RegisterTask, Row } from "../domain/adapters";
import type { BaseRelease } from "../domain/types";

export interface Registers {
  tasks: AdaptedTask[];
  releases: BaseRelease[];
  registerTasks: RegisterTask[];
}

export interface LoadOpts {
  fixtureDir?: string;
  /** Master clone to read from with `git show`; needs `sha`. */
  repoDir?: string;
  sha?: string;
}

export function parseJsonl(text: string): Row[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Row);
}

export function loadJsonl(file: string): Row[] {
  try {
    return parseJsonl(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw e;
  }
}

const cache = new Map<string, Registers>();

function build(f: Row[], b: Row[], d: Row[], r: Row[]): Registers {
  const tasks = [...featuresAsTasks(f), ...bugsAsTasks(b), ...deferredAsTasks(d)];
  return { tasks, releases: releasesFromRegister(r), registerTasks: registerTasks(tasks) };
}

function gitJsonl(repoDir: string, sha: string, p: string): Row[] {
  try {
    const out = execFileSync("git", ["-C", repoDir, "show", `${sha}:${p}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseJsonl(out);
  } catch {
    return [];
  }
}

export function loadRegisters(opts: LoadOpts = {}): Registers {
  const fixtureDir = opts.fixtureDir ?? process.env.CONTROL_FIXTURE;
  if (fixtureDir) {
    const d = path.join(fixtureDir, "registers");
    return build(
      loadJsonl(path.join(d, "features.jsonl")),
      loadJsonl(path.join(d, "bugs.jsonl")),
      loadJsonl(path.join(d, "deferred.jsonl")),
      loadJsonl(path.join(d, "releases.jsonl")),
    );
  }
  if (opts.repoDir && opts.sha) {
    const key = `${opts.repoDir}\0${opts.sha}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const g = (p: string) => gitJsonl(opts.repoDir!, opts.sha!, p);
    const res = build(
      g(".claude/roadmap/features.jsonl"),
      g(".claude/campaign/bugs.jsonl"),
      g(".claude/roadmap/deferred.jsonl"),
      g(".claude/roadmap/releases.jsonl"),
    );
    cache.set(key, res);
    return res;
  }
  return { tasks: [], releases: [], registerTasks: [] };
}
