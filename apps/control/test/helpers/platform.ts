/**
 * Platform switches for specs that lean on POSIX-only mechanisms (B988). The control system runs on
 * Linux (Railway) and macOS; a developer on Windows must still be able to run the whole suite
 * (the pre-push verify is full-scope when a hook or CI file changes). Rules for using this file:
 *
 *  - POSIX behaviour is never weakened: every assertion below still runs, unchanged, off Windows.
 *  - Skip a case on Windows only when Windows cannot express the mechanism at all (POSIX file modes,
 *    FIFOs and /dev nodes, a PATH-first extensionless `git` script), and say why at the call site.
 *  - Otherwise assert what Windows CAN guarantee, via the helpers below.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const IS_WIN = process.platform === "win32";

/** `it` off Windows, `it.skip` on it. Always give the reason in a comment at the call site. */
export const itPosix: jest.It = IS_WIN ? it.skip : it;

/**
 * Node can abort a Windows process with STATUS_STACK_BUFFER_OVERRUN (a libuv closing-handle
 * assertion) when `process.exit` runs while an undici socket is still closing; the refusal message
 * was already written by then. POSIX gets the exact exit code 1.
 */
export const WIN_NODE_ABORT = 0xc0000409;

/** The exit code of a process that refused to boot: exactly 1 on POSIX, 1 or the abort on Windows. */
export function expectRefusedExit(code: number | null, win: boolean = IS_WIN): void {
  if (win) expect([1, WIN_NODE_ABORT]).toContain(code);
  else expect(code).toBe(1);
}

/** A path with forward slashes (git, JSON and the fixture listings are `/`-separated everywhere). */
export const posixPath = (p: string): string => p.split(path.sep).join("/");

/**
 * Assert a file's or directory's POSIX permission bits (`mode & 0o777`). Windows has no such bits
 * (Node reports 0o666 / 0o777 whatever the ACL says), so there the most it can guarantee is that
 * the path exists and is writable by its owner.
 */
export function expectMode(p: string, expected: number, win: boolean = IS_WIN): void {
  const st = fs.statSync(p);
  if (win) expect(st.mode & 0o200).toBe(0o200);
  else expect(st.mode & 0o777).toBe(expected);
}

/**
 * `rm -rf` that survives Windows' habit of holding a just-exited child's cwd/handles for a moment
 * (EPERM / EBUSY / ENOTEMPTY): Node retries those codes with a linear back-off. No-op change on POSIX.
 */
export function rmTree(p: string): void {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * The real git a shim forwards to, found BEFORE the shim dir is put on PATH: `which git` on POSIX
 * (unchanged), the first `git.exe` on PATH on Windows (`which` there prints an MSYS path that a
 * Windows process cannot launch).
 */
export function realGitPath(): string {
  if (IS_WIN) return require("./win-git-shim").realGitWin() as string;
  return execFileSync("which", ["git"], { encoding: "utf8" }).trim();
}

/**
 * Windows starts a node or git process several times slower than POSIX (and a verify runs these specs
 * beside every other workspace's tests), so a budget that is generous on Linux/macOS starves there.
 * Every spec timeout and every bounded "nothing happened" wait goes through this; POSIX is x1.
 */
export const TIME_SCALE = IS_WIN ? 4 : 1;
export const scaled = (ms: number): number => ms * TIME_SCALE;
