/**
 * Runs the BUILT `ctl` CLI (node apps/control/bin/ctl.mjs) as a real child process against local
 * throwaway git worlds (helpers/temp-repo.ts). Never the network, never the real repo.
 *
 * ASSUMED interface (spec names no env for the state clone): CONTROL_STATE_ORIGIN = origin URL,
 * CONTROL_STATE_DIR = the state clone directory, CTL_LANE = lane. The process cwd is a small
 * "working repo" (one commit) so `sha` = short HEAD of the working repo is checkable.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { git } from "./temp-repo";
import type { World } from "./temp-repo";

export const CTL_BIN = path.resolve(__dirname, "..", "..", "bin", "ctl.mjs");

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface WorkRepo {
  dir: string;
  /** `git rev-parse --short HEAD` of the working repo. */
  shortSha: string;
}

export function makeWorkRepo(world: World, name = "work"): WorkRepo {
  const dir = path.join(world.root, `work-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--initial-branch=main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "working repo (synthetic)\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return { dir, shortSha: git(dir, ["rev-parse", "--short", "HEAD"]).trim() };
}

export interface SpawnOpts {
  /** Distinct clone dir per "machine". */
  machine?: string;
  lane?: string | null;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export function runCli(world: World, args: string[], opts: SpawnOpts = {}): Promise<CliResult> {
  const machine = opts.machine ?? "a";
  const cwd = opts.cwd ?? makeWorkRepo(world, `w-${machine}`).dir;
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    CONTROL_STATE_ORIGIN: world.originUrl,
    CONTROL_STATE_DIR: world.cloneDirOf(machine),
    ...opts.env,
  };
  delete env.CTL_LANE;
  if (opts.lane) env.CTL_LANE = opts.lane;
  if (opts.lane === undefined) env.CTL_LANE = "lane-u";
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CTL_BIN, ...args], { cwd, env: env as any });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 25_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e) });
    });
  });
}

export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
export const lineCount = (s: string): number => s.split("\n").filter((l) => l.length).length;
