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

/**
 * HTTPS auth for git children, through git's env config (git >= 2.31): one extra header scoped to
 * `base`, plus `http.<base>.followRedirects=false` (URL-scoped, so a scoped `true` set in any other
 * config cannot beat it: env config is applied last). Nothing is written to .git/config, argv or a URL; the
 * entries live only in the child's environment.
 *
 * What is guaranteed: the header is only sent to the configured base, and git never follows a
 * redirect (a 302 is a failure, `returned error: 302`), so the token cannot reach another host
 * or host name. The URL scoping alone is NOT enough: curl drops the header on the redirected GET,
 * but git then switches its base URL to the redirect target and sends the following POST to it
 * WITH the header (proven against two local servers in test/git-auth-redirect.spec.ts).
 */
export function gitAuthEnv(token: string, base = "https://github.com/"): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${base}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_CONFIG_KEY_1: `http.${base}.followRedirects`,
    GIT_CONFIG_VALUE_1: "false",
  };
}

let authToken: string | null = null;
let authBase: string | undefined;
/** Set (or clear, with null) the token every git child authenticates with. */
export function setGitAuth(token: string | null, base?: string): void {
  authToken = token === null || token === "" ? null : token;
  authBase = base;
}

/**
 * The config entries appended after any GIT_CONFIG_COUNT entries the process env already has.
 *
 * ALWAYS the generic `http.followRedirects=false`, token or not: a GitHub rename alias or a repo
 * transfer answers 301/302, and git's default would follow it, so a CLI push could land in a
 * different repo without anyone noticing. With it, the redirect is a loud failure
 * (`returned error: 302`). When a token is set, the URL-scoped header + no-redirect pair from
 * `gitAuthEnv` goes first, then the generic entry. `opts.env` (applied after this) still wins.
 */
function authEntries(): Record<string, string> {
  const raw = process.env.GIT_CONFIG_COUNT;
  const n = raw !== undefined && /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
  const out: Record<string, string> = {};
  let i = n;
  if (authToken !== null) {
    const own = gitAuthEnv(authToken, authBase);
    out[`GIT_CONFIG_KEY_${i}`] = own.GIT_CONFIG_KEY_0;
    out[`GIT_CONFIG_VALUE_${i}`] = own.GIT_CONFIG_VALUE_0;
    i++;
    out[`GIT_CONFIG_KEY_${i}`] = own.GIT_CONFIG_KEY_1;
    out[`GIT_CONFIG_VALUE_${i}`] = own.GIT_CONFIG_VALUE_1;
    i++;
  }
  out[`GIT_CONFIG_KEY_${i}`] = "http.followRedirects";
  out[`GIT_CONFIG_VALUE_${i}`] = "false";
  i++;
  return { GIT_CONFIG_COUNT: String(i), ...out };
}

/**
 * The process environment minus every CONTROL_* variable (secrets never reach a git child), plus
 * the GIT_CONFIG_* entries of `authEntries` (always the no-redirect default; the HTTPS auth pair too
 * when `setGitAuth` was called), merged after the scrub.
 */
export function childEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CONTROL_")) out[k] = v;
  return { ...out, ...authEntries() };
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
      ...childEnv(),
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
