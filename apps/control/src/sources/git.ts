/** Thin git wrapper: argv arrays only, never a shell; timeouts on every call. */
import { spawnSync } from "node:child_process";
import type { BaseRelease, BaseTask } from "../domain/types";

/** Error carrying a CLI exit code (2 usage, 3 invalid, 4 denylist, 5 push/IO). */
export class CtlError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "CtlError";
    this.code = code;
  }
}

/** Everything the state-branch code needs from its caller. */
export interface Env {
  origin: string;
  cloneDir: string;
  stateBranch: string;
  archiveBranch: string;
  registers: { tasks: BaseTask[]; releases: BaseRelease[] };
  now(): string;
  /** Backoff hook; defaults to a real timer. */
  sleep?(ms: number): Promise<void>;
}

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export interface GitOpts {
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

/** Committer identity for every ctl commit (no dot TLD, so no denylist email hit). */
export const CTL_IDENTITY: readonly string[] = [
  "-c",
  "user.name=ctl",
  "-c",
  "user.email=ctl@localhost",
  "-c",
  "commit.gpgsign=false",
];

/** Every git call is capped; `CTL_GIT_TIMEOUT_MS` overrides it (tests, slow links). */
export const GIT_TIMEOUT_MS = 10_000;
/** Clone and fetch move real data, so they get their own, longer cap (`CTL_GIT_CLONE_TIMEOUT_MS`). */
export const GIT_CLONE_TIMEOUT_MS = 120_000;
const fromEnv = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
/** Cap for commit, push and every other local call. */
export const shortTimeoutMs = (): number => fromEnv("CTL_GIT_TIMEOUT_MS", GIT_TIMEOUT_MS);
/** Cap for clone and fetch. */
export const cloneTimeoutMs = (): number =>
  fromEnv("CTL_GIT_CLONE_TIMEOUT_MS", GIT_CLONE_TIMEOUT_MS);

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/;
/** Names Windows cannot create as files (with or without an extension), plus our own parking dir. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
/** `pending/rejected/` is where set-aside parked lines go; it must never be a lane. */
const RESERVED_LANES = new Set(["rejected"]);

/** A lane name (single segment) must match the house name regex. */
export function assertLaneName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("..")) {
    throw new CtlError(2, `bad lane name ${JSON.stringify(name)}`);
  }
  if (RESERVED_LANES.has(name) || WINDOWS_RESERVED.test(name.split(".")[0])) {
    throw new CtlError(2, `reserved lane name ${JSON.stringify(name)}`);
  }
  return name;
}

/** A branch name: each `/`-separated segment must match the house name regex. */
export function assertBranchName(name: string): string {
  const segs = typeof name === "string" ? name.split("/") : [];
  const ok =
    segs.length > 0 &&
    segs.every((s) => NAME_RE.test(s) && !s.includes("..") && !s.endsWith(".lock"));
  if (!ok) throw new CtlError(2, `bad branch name ${JSON.stringify(name)}`);
  return name;
}

/** An origin is passed after `--`, but still must not look like an option or contain NULs. */
export function assertOrigin(origin: string): string {
  if (
    typeof origin !== "string" ||
    origin === "" ||
    origin.startsWith("-") ||
    origin.includes("\0")
  ) {
    throw new CtlError(2, "bad origin");
  }
  return origin;
}

function run(cwd: string | undefined, args: string[], opts: GitOpts = {}): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: opts.input,
    timeout: opts.timeoutMs ?? shortTimeoutMs(),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL ?? "file:https:ssh",
      LC_ALL: "C",
      ...(opts.env ?? {}),
    },
  });
  if (r.error) {
    return { ok: false, out: r.stdout ?? "", err: String(r.error.message) };
  }
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Run git; throws CtlError(5) on failure or timeout (message = stderr). Returns stdout. */
export function git(cwd: string, args: string[], opts?: GitOpts): string {
  const r = run(cwd, args, opts);
  if (!r.ok) {
    throw new CtlError(5, `git ${args[0] ?? ""} failed: ${(r.err || r.out).trim()}`);
  }
  return r.out;
}

/** Run git; never throws. */
export function gitTry(cwd: string, args: string[], opts?: GitOpts): GitResult {
  return run(cwd, args, opts);
}

/** Like gitTry without a cwd (clone into a path given in args). */
export function gitAnywhere(args: string[], opts?: GitOpts): GitResult {
  return run(undefined, args, opts);
}
