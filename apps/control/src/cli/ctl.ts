/**
 * `ctl` entry point: argument parsing, lane resolution, environment, exit codes (spec §7).
 *
 * Environment and defaults:
 *   --origin <url>        state remote for this call (beats everything below).
 *   CONTROL_STATE_ORIGIN  state remote (beats the config file). Resolution: flag, env, then the first
 *                         line of <config dir>/origin (`ctl origin set`), else NONE: no fallback to the
 *                         working repo's `origin`. The product repo is refused as a state remote.
 *   CONTROL_CONFIG_DIR    directory holding the `origin` file; default $XDG_CONFIG_HOME or ~/.config,
 *                         plus /routeflow-control.
 *   CONTROL_STATE_DIR     clone directory; default: <os cache dir>/routeflow-control/state-<hash of
 *                         origin> (macOS ~/Library/Caches, Windows %LOCALAPPDATA%, else
 *                         $XDG_CACHE_HOME or ~/.cache), so each machine keeps one clone per origin.
 *   CTL_LANE              lane; precedence --lane > CTL_LANE > <repo>/.claude/control/.lane.
 *   CONTROL_NOW           ISO UTC override of the single clock (tests).
 *   CONTROL_FIXTURE       read registers from a fixture dir instead of git.
 * Exit codes: 0 ok, 2 usage/unknown lane, 3 illegal, 4 denylist, 5 push exhausted / IO.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadRegisters } from "../sources/registers";
import type { Registers } from "../sources/registers";
import { CtlError, assertLaneName, gitTry } from "../sources/git";
import type { Env } from "../sources/git";
import { NO_STATE_REMOTE, resolveStateOrigin } from "../sources/origin";
import { COMMANDS, LANELESS } from "./commands";
import type { Args, Ctx } from "./commands";
import { controlFailure, oneLine } from "./format";

const VALUE_FLAGS = new Set([
  "lane",
  "reason",
  "phase",
  "note",
  "pr",
  "kind",
  "areas",
  "priority",
  "release",
  "effort",
  "importance",
  "impact",
  "location",
  "severity",
  "card",
  "since",
  "task",
  "roster",
  "emitter",
  "name",
  "machine",
  "origin",
]);
const BOOL_FLAGS = new Set(["json", "quiet", "hook", "dry-run", "inactive"]);

const USAGE = `usage: ctl <verb> [args]
  next [--lane X] [--json] [--quiet]   start | done [--pr n] | block --reason "..." | unblock
  set-next <task|none>   progress <task> --phase p   note "..."   propose "<title>" --kind k --areas a,b
  bug "<title>" --location l --severity s   pr-body <task>   show <id>   overlap | piggyback | waste
  handoff --card <path>   sync --since <sha>   task new "<title>" --kind k   adopt <tmpId>
  compact | validate | lane use <lane> | serve
  lane register <id> --name "<n>" --machine <m> --kind <k> [--inactive]
  init --roster <file> [--emitter <lane>] [--dry-run]   origin [set <url> | unset]`;

/** The single clock: seconds-resolution UTC, overridable for tests. */
const clock = (): string =>
  process.env.CONTROL_NOW ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function parseArgs(argv: string[]): Args {
  const flags: Args["flags"] = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(a);
    if (!m) {
      positional.push(a);
      continue;
    }
    const name = m[1];
    if (BOOL_FLAGS.has(name)) flags[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const v = m[2] ?? argv[++i];
      if (v === undefined || (m[2] === undefined && v.startsWith("--"))) {
        throw new CtlError(2, `--${name} needs a value`);
      }
      flags[name] = v;
    } else throw new CtlError(2, `unknown flag --${name}`);
  }
  return { verb: positional[0] ?? "", pos: positional.slice(1), flags };
}

function repoRoot(cwd: string): string {
  const r = gitTry(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.out.trim() !== "" ? r.out.trim() : cwd;
}

/** --lane > CTL_LANE > .claude/control/.lane; null when none is configured. */
export function resolveLane(args: Args, cwd: string): string | null {
  const f = args.flags.lane;
  if (typeof f === "string") {
    if (f.trim() === "") throw new CtlError(2, "--lane must not be empty");
    return assertLaneName(f);
  }
  const e = process.env.CTL_LANE;
  if (e !== undefined && e.trim() !== "") return assertLaneName(e.trim());
  try {
    const t = fs
      .readFileSync(path.join(repoRoot(cwd), ".claude", "control", ".lane"), "utf8")
      .trim();
    if (t !== "") return assertLaneName(t.split(/\s+/)[0]);
  } catch {
    /* no lane file */
  }
  return null;
}

function cacheRoot(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

function loadRegs(cwd: string): Registers {
  if (process.env.CONTROL_FIXTURE) return loadRegisters();
  for (const rev of ["origin/master", "HEAD"]) {
    const r = gitTry(cwd, ["rev-parse", "--verify", "--quiet", rev]);
    const sha = r.out.trim();
    if (r.ok && /^[0-9a-f]{40}$/.test(sha)) return loadRegisters({ repoDir: cwd, sha });
  }
  return loadRegisters({});
}

/** The state remote for this call (flag, env, file); NONE is exit 2 with the fix. */
function stateOrigin(args: Args): string {
  const flag = args.flags.origin;
  const r = resolveStateOrigin({ flag: typeof flag === "string" ? flag : undefined });
  if (r.origin === null) throw new CtlError(2, NO_STATE_REMOTE);
  return r.origin;
}

function buildEnv(origin: string, registers: Registers): Env {
  const cloneDir =
    process.env.CONTROL_STATE_DIR ||
    path.join(
      cacheRoot(),
      "routeflow-control",
      `state-${createHash("sha1").update(origin).digest("hex").slice(0, 10)}`,
    );
  return {
    origin,
    cloneDir,
    stateBranch: "ctl/state",
    archiveBranch: "ctl/archive",
    registers: { tasks: registers.tasks, releases: registers.releases },
    now: clock,
  };
}

export async function main(argv: string[]): Promise<void> {
  try {
    const args = parseArgs(argv);
    if (args.verb === "" || args.verb === "help" || !Object.hasOwn(COMMANDS, args.verb)) {
      if (args.verb !== "" && args.verb !== "help") {
        process.stderr.write(USAGE + "\n");
        throw new CtlError(2, `unknown verb ${args.verb}`);
      }
      process.stdout.write(USAGE + "\n");
      process.exitCode = args.verb === "" ? 2 : 0;
      return;
    }
    const cwd = process.cwd();
    const lane = resolveLane(args, cwd);
    if (lane === null && !LANELESS.has(args.verb)) {
      throw new CtlError(2, "no lane: pass --lane, set CTL_LANE, or run `ctl lane use <lane>`");
    }
    const sub = args.pos[0];
    if (
      args.verb === "serve" ||
      args.verb === "origin" ||
      (args.verb === "lane" && sub !== "use" && sub !== "register")
    ) {
      const ctx = { cwd, lane, args, out: (t: string) => void process.stdout.write(t) } as Ctx;
      await COMMANDS[args.verb](ctx);
      return;
    }
    // the origin is resolved (and the product repo refused) before any register or clone work
    const origin = stateOrigin(args);
    // init only needs the origin and the clock: no registers, no clone
    const registers: Registers =
      args.verb === "init"
        ? { tasks: [], releases: [], registerTasks: [], warnings: [] }
        : loadRegs(cwd);
    const ctx: Ctx = {
      cwd,
      lane,
      args,
      registers,
      env: buildEnv(origin, registers),
      out: (t) => void process.stdout.write(t),
    };
    await COMMANDS[args.verb](ctx);
  } catch (e) {
    const code = e instanceof CtlError ? e.code : 5;
    const msg = (e instanceof Error ? e.message : String(e)).replace(
      /:\/\/[^/@\s]+@/g,
      "://<redacted>@",
    );
    if (argv[0] === "next" && argv.includes("--hook")) return; // hook: print nothing, exit 0
    if (argv[0] === "next") {
      // `next` always exits 0 and prints exactly one line, even with --quiet
      process.stdout.write(
        msg === NO_STATE_REMOTE
          ? `control: ${NO_STATE_REMOTE}\n`
          : controlFailure(code === 3 ? 3 : 5, msg),
      );
      return;
    }
    // validate lists its errors (exit 3); everything else is one line
    // the "parked" notice goes first so oneLine can never cut it off a multi-line git error
    const parked = /;?\s*event parked in pending\/\s*$/.test(msg);
    const line = parked
      ? `event parked in pending/ (${oneLine(msg.replace(/;?\s*event parked in pending\/\s*$/, ""), 150)})`
      : code === 3
        ? msg
        : oneLine(msg);
    process.stderr.write(`ctl: ${line}\n`);
    process.exitCode = code;
  }
}
