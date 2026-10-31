import { spawn } from "node:child_process";

export interface IdleRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** The child is ended after this long WITHOUT any stdout/stderr output. */
  idleMs: number;
  /** Safety ceiling on total time (default 30 min): a child that prints forever must not hang the suite. */
  maxMs?: number;
}

export interface IdleRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Why the child was ended by us: no output for `idleMs`, or the `maxMs` ceiling; null when it ended itself. */
  timedOut: "idle" | "max" | null;
  elapsedMs: number;
}

/** The default ceiling on total time; a wrapper's Jest test timeout must sit above it. */
export const IDLE_RUN_MAX_MS = 30 * 60_000;

/**
 * Run a child to completion, ending it only when it stops producing output.
 *
 * The self-test wrappers (`*-self-test-script.spec.ts`) used a fixed wall-clock `spawnSync` timeout. A child that is
 * slow because the machine is busy (a full verify holds it) still prints as it goes, so a total-time budget fails a
 * healthy child exactly when load is highest. An idle window fails only a child that is stuck.
 */
export function runWithIdleTimeout(
  cmd: string,
  args: string[],
  opts: IdleRunOptions,
): Promise<IdleRunResult> {
  const { idleMs, maxMs = IDLE_RUN_MAX_MS } = opts;
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    return Promise.reject(
      new Error(`runWithIdleTimeout: idleMs must be a positive number, got ${idleMs}`),
    );
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut: IdleRunResult["timedOut"] = null;
    let idleTimer: NodeJS.Timeout;
    const end = (why: "idle" | "max") => {
      timedOut ??= why;
      child.kill("SIGTERM");
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => end("idle"), idleMs);
    };
    const maxTimer = setTimeout(() => end("max"), maxMs);
    armIdle();
    child.stdout.on("data", (d) => {
      stdout += d;
      armIdle();
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      armIdle();
    });
    const done = (status: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      resolve({ status, signal, stdout, stderr, timedOut, elapsedMs: Date.now() - started });
    };
    child.on("error", (e) => {
      stderr += String(e);
      done(null, null);
    });
    child.on("close", done);
  });
}
