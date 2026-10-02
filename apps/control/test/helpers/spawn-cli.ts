/**
 * Runs the BUILT `ctl` CLI (node apps/control/bin/ctl.mjs) as a real child process against local
 * throwaway git worlds (helpers/temp-repo.ts). Never the network, never the real repo.
 *
 * ASSUMED interface (spec names no env for the state clone): CONTROL_STATE_ORIGIN = origin URL,
 * CONTROL_STATE_DIR = the state clone directory, CTL_LANE = lane. The process cwd is a small
 * "working repo" (one commit) so `sha` = short HEAD of the working repo is checkable.
 */
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { scaled } from "./platform";
import { OFFLINE_GIT_ENV, git } from "./temp-repo";
import type { World } from "./temp-repo";

const APP_ROOT = path.resolve(__dirname, "..", "..");
export const CTL_BIN = path.resolve(APP_ROOT, "bin", "ctl.mjs");
const OWN_DIST_CTL = path.join(APP_ROOT, "dist", "cli", "ctl.js");
const STAMP = path.join(APP_ROOT, "dist", ".ctl-build-stamp");
const BUILD_LOCK = path.join(os.tmpdir(), "routeflow-ctl-test-build.lock");

function newestMtime(dir: string): number {
  let newest = 0;
  if (!fs.existsSync(dir)) return newest;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

/** The once-per-run build (test/global-setup.ts) when jest published one, else `dist/`. */
const sharedCtl = (): string | null => {
  const dir = process.env.CONTROL_TEST_DIST;
  const ctl = dir ? path.join(dir, "cli", "ctl.js") : null;
  return ctl !== null && fs.existsSync(ctl) ? ctl : null;
};
/** The compiled CLI entry a spawned `ctl` runs. */
export const distCtl = (): string => sharedCtl() ?? OWN_DIST_CTL;

const fresh = (): boolean =>
  fs.existsSync(OWN_DIST_CTL) &&
  fs.existsSync(STAMP) &&
  fs.statSync(STAMP).mtimeMs >= newestMtime(path.join(APP_ROOT, "src"));

let built: Promise<void> | null = null;

/**
 * Nothing to build under jest's globalSetup (the shared build exists). Otherwise build `dist/` once
 * per jest run (module promise) and once across workers (tmpdir lock dir).
 */
function ensureBuilt(): Promise<void> {
  if (sharedCtl() !== null) return Promise.resolve();
  built ??= (async () => {
    const deadline = Date.now() + 240_000;
    while (!fresh()) {
      try {
        fs.mkdirSync(BUILD_LOCK);
      } catch {
        try {
          if (Date.now() - fs.statSync(BUILD_LOCK).mtimeMs > 180_000) fs.rmdirSync(BUILD_LOCK);
        } catch {
          /* holder just finished */
        }
        if (Date.now() > deadline) throw new Error("timed out waiting for the ctl build");
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      try {
        if (!fresh()) {
          const tsc = require.resolve("typescript/bin/tsc");
          execFileSync(process.execPath, [tsc, "-p", path.join(APP_ROOT, "tsconfig.build.json")], {
            cwd: APP_ROOT,
            stdio: "pipe",
          });
          fs.writeFileSync(STAMP, String(Date.now()));
        }
      } finally {
        fs.rmdirSync(BUILD_LOCK);
      }
    }
  })();
  return built;
}

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
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
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

/**
 * The environment of a spawned `ctl`. Offline by default (`OFFLINE_GIT_ENV`: file-only transport,
 * ssh disabled), even over an ambient value, so a regressed state-origin refusal can never reach a
 * real host; a caller overrides either through `opts.env` (as the 127.0.0.1 redirect specs do).
 */
export function cliChildEnv(
  world: World,
  opts: SpawnOpts = {},
): Record<string, string | undefined> {
  const machine = opts.machine ?? "a";
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...OFFLINE_GIT_ENV,
    GIT_TERMINAL_PROMPT: "0",
    CONTROL_STATE_ORIGIN: world.originUrl,
    CONTROL_STATE_DIR: world.cloneDirOf(machine),
    ...opts.env,
  };
  delete env.CTL_LANE;
  if (opts.lane) env.CTL_LANE = opts.lane;
  if (opts.lane === undefined) env.CTL_LANE = "lane-u";
  return env;
}

export async function runCli(
  world: World,
  args: string[],
  opts: SpawnOpts = {},
): Promise<CliResult> {
  const machine = opts.machine ?? "a";
  const cwd = opts.cwd ?? makeWorkRepo(world, `w-${machine}`).dir;
  const env = cliChildEnv(world, opts);
  await ensureBuilt();
  return new Promise((resolve) => {
    // run dist directly: bin/ctl.mjs could trigger its own rebuild mid-run
    const child = spawn(
      process.execPath,
      ["-e", "require(process.env.CTL_DIST).main(process.argv.slice(1))", "--", ...args],
      { cwd, env: { ...env, CTL_DIST: distCtl() } as any },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? scaled(25_000));
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
