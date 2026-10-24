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
  warnings: string[];
}

export interface LoadOpts {
  fixtureDir?: string;
  /** Master clone to read from with `git show`; needs a full 40-hex `sha`. */
  repoDir?: string;
  sha?: string;
  /** Injectable git runner (tests count spawns); defaults to execFileSync. */
  run?: (repoDir: string, args: string[]) => string;
}

/** Parse JSONL; malformed lines are skipped with a `label:line` warning. */
export function parseJsonl(text: string, label = "jsonl", warnings: string[] = []): Row[] {
  const out: Row[] = [];
  text.split("\n").forEach((l, i) => {
    if (l.trim() === "") return;
    try {
      out.push(JSON.parse(l) as Row);
    } catch {
      warnings.push(`${label}:${i + 1}: malformed JSON line skipped`);
    }
  });
  return out;
}

export function loadJsonl(file: string, warnings: string[] = []): Row[] {
  try {
    return parseJsonl(fs.readFileSync(file, "utf8"), file, warnings);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    warnings.push(`${file}: read failed: ${String(e)}`);
    return [];
  }
}

// Single-slot cache: only the latest (repoDir, sha) is kept, only successful loads.
let cache: { key: string; value: Registers } | null = null;

function lastPerId(rows: Row[]): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rows) if (typeof r.id === "string") m.set(r.id, r);
  return m;
}

function build(
  f: Row[],
  b: Row[],
  d: Row[],
  r: Row[],
  shards: Row[],
  warnings: string[],
): Registers {
  const tasks = [
    ...featuresAsTasks(f),
    ...bugsAsTasks(b, lastPerId(shards)),
    ...deferredAsTasks(d),
  ];
  return {
    tasks,
    releases: releasesFromRegister(r),
    registerTasks: registerTasks(tasks),
    warnings,
  };
}

const SHA = /^[0-9a-f]{40}$/;
const defaultRun = (repoDir: string, args: string[]): string =>
  execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

export function loadRegisters(opts: LoadOpts = {}): Registers {
  const fixtureDir = opts.fixtureDir ?? process.env.CONTROL_FIXTURE;
  const warnings: string[] = [];
  if (fixtureDir) {
    const d = path.join(fixtureDir, "registers");
    const sd = path.join(fixtureDir, "status");
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(sd)
        .filter((n) => n.endsWith(".jsonl"))
        .sort();
    } catch {
      /* no status dir */
    }
    const shards = names.flatMap((n) => loadJsonl(path.join(sd, n), warnings));
    return build(
      loadJsonl(path.join(d, "features.jsonl"), warnings),
      loadJsonl(path.join(d, "bugs.jsonl"), warnings),
      loadJsonl(path.join(d, "deferred.jsonl"), warnings),
      loadJsonl(path.join(d, "releases.jsonl"), warnings),
      shards,
      warnings,
    );
  }
  if (opts.repoDir && opts.sha) {
    const { repoDir, sha } = opts;
    if (!SHA.test(sha)) throw new Error("loadRegisters: sha must be a full 40-hex commit id");
    const key = `${repoDir}\0${sha}`;
    if (cache?.key === key) return cache.value;
    const gitOut = opts.run ?? defaultRun;
    let gitFailed = false;
    const show = (p: string): Row[] => {
      try {
        const text = gitOut(repoDir, ["show", "--end-of-options", `${sha}:${p}`]);
        return parseJsonl(text, p, warnings);
      } catch (e) {
        gitFailed = true;
        warnings.push(`git show ${p}: ${String(e).split("\n")[0]}`);
        return [];
      }
    };
    let shardFiles: string[] = [];
    try {
      shardFiles = gitOut(repoDir, [
        "ls-tree",
        "-r",
        "--name-only",
        "--end-of-options",
        sha,
        ".claude/campaign/status/",
      ])
        .split("\n")
        .filter((n) => n.endsWith(".jsonl"))
        .sort();
    } catch (e) {
      gitFailed = true;
      warnings.push(`git ls-tree status: ${String(e).split("\n")[0]}`);
    }
    const res = build(
      show(".claude/roadmap/features.jsonl"),
      show(".claude/campaign/bugs.jsonl"),
      show(".claude/roadmap/deferred.jsonl"),
      show(".claude/roadmap/releases.jsonl"),
      shardFiles.flatMap(show),
      warnings,
    );
    if (!gitFailed) cache = { key, value: res };
    return res;
  }
  return { tasks: [], releases: [], registerTasks: [], warnings: ["no register source"] };
}
