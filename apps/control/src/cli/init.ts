/**
 * `ctl init --roster <file>` (create the orphan `ctl/state` branch on the state remote) and
 * `ctl origin set|show|unset` (B938). Also the lane-field rules shared with `ctl lane register`.
 * Nothing here writes anywhere except the resolved origin (init) and the origin config file
 * (origin set|unset); init works in a private temp dir that is always removed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EMITTERS, LANE_ID_RE, LANE_KINDS } from "../domain/schema";
import { validateEvents } from "../domain/validate";
import type { LaneKind } from "../domain/types";
import { denylistHit } from "../sources/denylist";
import {
  CTL_IDENTITY,
  CtlError,
  assertLaneName,
  assertOrigin,
  cloneTimeoutMs,
  git,
  gitAnywhere,
  gitTry,
} from "../sources/git";
import {
  assertEnvOrigin,
  redactUrl,
  removeOriginFile,
  resolveStateOrigin,
  writeOriginFile,
} from "../sources/origin";
import { changeLine, oneLine } from "./format";
import type { Args, Command, Ctx } from "./commands";

/** Every ordinary event line is capped at 240 bytes (the 1,024 B library cap is for lead verbs). */
export const LINE_MAX = 240;
const ROSTER_MAX_ENTRIES = 60;
const ROSTER_MAX_BYTES = 64 * 1024;
const NAME_MAX = 60;
/** C0 and C1 control characters (tab, newline and NUL included). */
const hasControlChar = (v: string): boolean =>
  Array.from(v).some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n < 0x20 || (n >= 0x7f && n <= 0x9f);
  });
/**
 * Bidi controls, zero-width characters and other invisible format characters: they let a name read
 * differently from what it is (U+200B-U+200F, U+202A-U+202E, U+2060-U+2064, U+2066-U+2069, U+FEFF).
 */
const hasFormatChar = (v: string): boolean =>
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/.test(v);
const README =
  "State branch of the control dashboard. Written only by `ctl`. Never edit by hand, never merge.\n";
const ROSTER_FIELDS = ["id", "name", "machine", "kind", "active"];

/** The lane kinds that may emit `lane.registered` (lead, coordinator, owner). */
export const LEAD_LIKE_KINDS: readonly LaneKind[] = LANE_KINDS.filter((k) =>
  EMITTERS["lane.registered"].includes(k),
);

export interface LaneFields {
  id: string;
  name: string;
  machine: string;
  kind: LaneKind;
  active: boolean;
}

/**
 * One lane's registration fields, validated; `label(field)` names the field in the message
 * (`roster[2].name`, `lane register name`). Values are never echoed. Exit 2 on any violation.
 */
export function checkLaneFields(
  raw: { id: unknown; name: unknown; machine: unknown; kind: unknown; active?: unknown },
  label: (field: string) => string,
): LaneFields {
  const bad = (field: string, why: string): never => {
    throw new CtlError(2, `${label(field)}: ${why}`);
  };
  const text = (field: "name" | "machine", max?: number): string => {
    const v = raw[field];
    if (typeof v !== "string" || v.trim() === "") return bad(field, "must be a non-empty string");
    if (hasControlChar(v)) return bad(field, "must not contain control characters");
    if (hasFormatChar(v)) {
      return bad(field, "must not contain bidi, zero-width or other invisible format characters");
    }
    if (max !== undefined && Array.from(v).length > max) {
      return bad(field, `must be at most ${max} characters`);
    }
    return v;
  };
  if (typeof raw.id !== "string") bad("id", "must be a string");
  const id = raw.id as string;
  if (!LANE_ID_RE.test(id)) bad("id", "bad lane name (2-24 characters of a-z, 0-9 and -)");
  try {
    assertLaneName(id);
  } catch {
    bad("id", "reserved lane name");
  }
  const name = text("name", NAME_MAX);
  const machine = text("machine");
  const kind = raw.kind;
  if (typeof kind !== "string" || !(LANE_KINDS as readonly string[]).includes(kind)) {
    bad("kind", `must be one of ${LANE_KINDS.join("|")}`);
  }
  const active = raw.active === undefined ? true : raw.active;
  if (typeof active !== "boolean") bad("active", "must be a boolean");
  return { id, name, machine, kind: kind as LaneKind, active: active as boolean };
}

/**
 * Read the roster as a regular file, never more than ROSTER_MAX_BYTES (+1 to detect overflow).
 * `stat` size is not trusted (a device such as /dev/zero reports 0): the type is checked on the
 * opened descriptor, the open is non-blocking (a FIFO with no writer would hang a plain open) and
 * the read stops at the cap.
 */
function readRosterText(file: string): string {
  let fd: number | undefined;
  try {
    if (!fs.statSync(file).isFile()) throw new CtlError(2, "roster: not a regular file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) throw new CtlError(2, "roster: not a regular file");
    const buf = Buffer.alloc(ROSTER_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n > ROSTER_MAX_BYTES) throw new CtlError(2, "roster: file too large");
    return buf.subarray(0, n).toString("utf8");
  } catch (e) {
    if (e instanceof CtlError) throw e;
    throw new CtlError(2, "roster: cannot read file");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readRoster(file: string): LaneFields[] {
  const text = readRosterText(file);
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new CtlError(2, "roster: not valid JSON");
  }
  if (!Array.isArray(data)) throw new CtlError(2, "roster: must be a JSON array");
  if (data.length < 1 || data.length > ROSTER_MAX_ENTRIES) {
    throw new CtlError(2, `roster: needs 1 to ${ROSTER_MAX_ENTRIES} entries (got ${data.length})`);
  }
  const seen = new Set<string>();
  return (data as unknown[]).map((entry, i) => {
    const at = `roster[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CtlError(2, `${at}: must be an object`);
    }
    const o = entry as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!ROSTER_FIELDS.includes(k)) {
        throw new CtlError(2, `${at}: unknown field ${JSON.stringify(k.slice(0, 30))}`);
      }
    }
    const lane = checkLaneFields(o as Parameters<typeof checkLaneFields>[0], (f) => `${at}.${f}`);
    if (seen.has(lane.id)) throw new CtlError(2, `${at}.id: duplicate lane id`);
    seen.add(lane.id);
    return lane;
  });
}

function pickEmitter(roster: LaneFields[], wanted: string | undefined): LaneFields {
  const leadLike = `lead-like (${LEAD_LIKE_KINDS.join(", ")})`;
  if (wanted === undefined) {
    const first = roster.find((l) => LEAD_LIKE_KINDS.includes(l.kind));
    if (first) return first;
    throw new CtlError(2, `init: no ${leadLike} lane in the roster; add one or pass --emitter`);
  }
  assertLaneName(wanted);
  const lane = roster.find((l) => l.id === wanted);
  if (!lane) throw new CtlError(2, `init: emitter ${wanted} is not in the roster`);
  if (!LEAD_LIKE_KINDS.includes(lane.kind)) {
    throw new CtlError(2, `init: emitter ${wanted} (${lane.kind}) is not ${leadLike}`);
  }
  return lane;
}

const flagOf = (args: Args, name: string): string | undefined => {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
};

/** `ctl init --roster <file> [--emitter <lane>] [--dry-run]`. */
function runInit(ctx: Ctx): void {
  const rosterFile = flagOf(ctx.args, "roster");
  if (rosterFile === undefined || rosterFile === "") {
    throw new CtlError(2, "init: --roster is required");
  }
  if (ctx.args.pos.length > 0) throw new CtlError(2, "init: unexpected argument");
  const roster = readRoster(rosterFile);
  const emitter = pickEmitter(roster, flagOf(ctx.args, "emitter"));
  const ts = ctx.env.now();

  // every line is checked (size, then denylist) before any file or network is touched
  const lines = roster.map((l, i) => {
    const line = JSON.stringify({
      seq: i + 1,
      ts,
      lane: emitter.id,
      type: "lane.registered",
      by: "ctl",
      laneId: l.id,
      name: l.name,
      machine: l.machine,
      kind: l.kind,
      active: l.active,
    });
    const n = Buffer.byteLength(line, "utf8");
    if (n > LINE_MAX) {
      throw new CtlError(
        3,
        `roster[${i}]: event line would be ${n} bytes; the limit is ${LINE_MAX}`,
      );
    }
    const hit = denylistHit(line);
    if (hit) throw new CtlError(4, `roster[${i}]: refused: ${hit}`);
    return line;
  });
  const events = lines.join("\n") + "\n";
  const errors = validateEvents([{ file: `${emitter.id}.jsonl`, text: events }], {
    tasks: [],
    releaseIds: [],
    denylistHit,
  });
  if (errors.length > 0) {
    const e = errors[0];
    throw new CtlError(3, `INVALID ${e.file}:${e.line} ${e.reason}`);
  }
  const size = Buffer.byteLength(README, "utf8") + Buffer.byteLength(events, "utf8");
  const branch = ctx.env.stateBranch;
  const summary = `${roster.length} lanes, emitter ${emitter.id}`;

  if (ctx.args.flags["dry-run"] === true) {
    ctx.out(changeLine(`plan: ${branch} with ${summary}, ${size} bytes (dry run, nothing pushed)`));
    return;
  }

  // the push below writes the state: same refusal as every other state entry point
  const origin = assertEnvOrigin(assertOrigin(ctx.env.origin));
  const remote = gitAnywhere(["ls-remote", "--heads", "--", origin, `refs/heads/${branch}`], {
    timeoutMs: cloneTimeoutMs(),
  });
  if (!remote.ok) {
    throw new CtlError(5, `cannot reach the state remote: ${oneLine(remote.err || remote.out)}`);
  }
  if (remote.out.trim() !== "") {
    throw new CtlError(3, "already initialised: use `ctl lane register`");
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-init-"));
  try {
    git(work, ["init", "-q"]);
    git(work, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    fs.mkdirSync(path.join(work, "events"));
    fs.writeFileSync(path.join(work, "README.md"), README);
    fs.writeFileSync(path.join(work, "events", `${emitter.id}.jsonl`), events);
    git(work, ["add", "-A"]);
    git(work, [
      ...CTL_IDENTITY,
      "commit",
      "-q",
      "--no-verify",
      "-m",
      `ctl(init): ${branch} with ${summary}`,
    ]);
    const pushed = gitTry(work, ["push", "-q", "--", origin, `HEAD:refs/heads/${branch}`], {
      timeoutMs: cloneTimeoutMs(),
    });
    if (!pushed.ok) {
      const why = oneLine(pushed.err || pushed.out);
      throw new CtlError(
        5,
        /rejected|non-fast-forward|fetch first/.test(pushed.err)
          ? `push rejected (another init may have created ${branch} first; nothing was overwritten): ${why}`
          : `push failed: ${why}`,
      );
    }
    const tip = git(work, ["rev-parse", "--short", "HEAD"]).trim();
    ctx.out(changeLine(`✓ initialised ${branch}: ${summary} (pushed ${tip})`));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export const initCmd: Command = (ctx) => {
  runInit(ctx);
  return Promise.resolve();
};

/** `ctl origin` (show) | `ctl origin set <url>` | `ctl origin unset`: config only, never the network. */
function runOrigin(ctx: Ctx): void {
  const [sub, url, ...rest] = ctx.args.pos;
  if (sub === undefined) {
    const r = resolveStateOrigin({ flag: flagOf(ctx.args, "origin") });
    ctx.out(
      r.origin === null
        ? "no state remote configured (source: none)\n"
        : `state remote: ${redactUrl(r.origin)} (source: ${r.source})\n`,
    );
    return;
  }
  if (sub === "set") {
    if (url === undefined || url === "" || rest.length > 0) {
      throw new CtlError(2, "origin set: usage: ctl origin set <url>");
    }
    writeOriginFile(url);
    ctx.out(`state remote set: ${redactUrl(url)}\n`);
    return;
  }
  if (sub === "unset") {
    if (url !== undefined) throw new CtlError(2, "origin unset: takes no argument");
    removeOriginFile();
    const env = (process.env.CONTROL_STATE_ORIGIN ?? "").trim() !== "";
    ctx.out(
      `state remote unset${env ? " (CONTROL_STATE_ORIGIN is still set in the environment)" : ""}\n`,
    );
    return;
  }
  throw new CtlError(2, `origin: unknown subcommand ${sub}`);
}

export const originCmd: Command = (ctx) => {
  runOrigin(ctx);
  return Promise.resolve();
};
