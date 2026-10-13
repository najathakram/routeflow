// proc.mjs — shared child-process helpers for read-only status scripts.
//
// Extracted from .claude/skills/fleet-lead/scripts/fleet-status.mjs so fleet-status and
// scripts/lead-status.mjs share one implementation. `makeProc(cwd)` binds every call to a repo
// root; each helper still accepts per-call `opts` (which win over the defaults).
//
//   run(cmd, args, opts)           -> stdout string, throws on failure
//   tryRun(cmd, args, opts)        -> { ok: true, out } | { ok: false, error, code }
//   tryRunAsync(cmd, args, opts)   -> same shape, non-blocking
//
// `code` is the process exit status when there is one (git merge-base --is-ancestor uses 1 for
// "no" and 128 for "bad object"); it is undefined when the binary could not be spawned.

import { execFileSync, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

function failure(err, exitCode) {
  const stderr = err.stderr ? String(err.stderr).trim().split("\n")[0] : err.message;
  return {
    ok: false,
    error: stderr || String(err.message || err),
    code: typeof exitCode === "number" ? exitCode : undefined,
  };
}

export function makeProc(cwd = process.cwd()) {
  function run(cmd, cmdArgs, opts = {}) {
    return execFileSync(cmd, cmdArgs, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 32,
      ...opts,
    });
  }

  function tryRun(cmd, cmdArgs, opts = {}) {
    try {
      return { ok: true, out: run(cmd, cmdArgs, opts) };
    } catch (err) {
      return failure(err, err.status);
    }
  }

  async function tryRunAsync(cmd, cmdArgs, opts = {}) {
    try {
      const { stdout } = await execFile(cmd, cmdArgs, {
        cwd,
        maxBuffer: 1024 * 1024 * 32,
        ...opts,
      });
      return { ok: true, out: stdout };
    } catch (err) {
      return failure(err, err.code);
    }
  }

  return { run, tryRun, tryRunAsync };
}
