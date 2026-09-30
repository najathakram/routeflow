/**
 * WP3 fix round 1, group A (Opus HIGH review): parked-line handling, lock safety, git timeouts,
 * snapshot validity, denylist normalisation, pre-park checks, archive naming, ts clamp, lane names.
 * Sample strings are assembled at runtime so this file stays clean for the no-client-data scan.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  makeWorld,
  baseState,
  git,
  jl,
  NOW,
  ARCHIVE_BRANCH,
  STATE_BRANCH,
  World,
} from "./helpers/temp-repo";

const SB = require("../src/sources/state-branch");
const LK = require("../src/sources/lock");
const GT = require("../src/sources/git");
const DL = require("../src/sources/denylist");
const CP = require("../src/sources/compact");
const FD = require("../src/domain/fold");

const note = (text: string) => ({ type: "lane.note", by: "agent", note: text });
const codeOf = (e: any) => e?.code ?? e?.exitCode;
const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: any) => e,
  );
const REGISTERS = { tasks: [], releases: [] };

let world: World;
beforeEach(() => {
  world = makeWorld();
});
afterEach(() => {
  delete process.env.CTL_GIT_TIMEOUT_MS;
  world.cleanup();
});

function installRejectHook(): string {
  const hook = path.join(world.originDir, "hooks", "pre-receive");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(hook, 0o755);
  return hook;
}

describe("A1 rejected parked lines live in pending/rejected/ and never become a lane", () => {
  it("an invalid parked draft is set aside in pending/rejected/<lane>.jsonl; no `rejected` lane ever lands", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("first")); // creates the clone
    const bad = JSON.stringify({ type: "lane.note", by: "agent", note: "bad", bogus: 1 });
    fs.mkdirSync(path.join(env.cloneDir, "pending"), { recursive: true });
    fs.writeFileSync(path.join(env.cloneDir, "pending", "lane-u.jsonl"), bad + "\n");
    await SB.appendAndPush(env, "lane-u", note("second"));
    await SB.appendAndPush(env, "lane-u", note("third"));
    expect(world.remoteFile("events/rejected.jsonl")).toBe("");
    const set = path.join(env.cloneDir, "pending", "rejected", "lane-u.jsonl");
    expect(fs.readFileSync(set, "utf8")).toContain("bogus");
    expect(fs.existsSync(path.join(env.cloneDir, "pending", "rejected.jsonl"))).toBe(false);
  });

  it("a stale pending/rejected.jsonl (old layout) is never drained as a lane and its bytes are unchanged", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("first"));
    const old = path.join(env.cloneDir, "pending", "rejected.jsonl");
    const bytes = JSON.stringify(note("zzz")) + "\n";
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, bytes);
    await SB.appendAndPush(env, "lane-u", note("second"));
    expect(world.remoteFile("events/rejected.jsonl")).toBe("");
    expect(fs.readFileSync(old, "utf8")).toBe(bytes);
  });

  it("`rejected` is a reserved lane name (exit 2)", async () => {
    world.seedBranch(STATE_BRANCH, baseState(1));
    const err = await fail(SB.appendAndPush(world.env("a"), "rejected", note("x")));
    expect(codeOf(err)).toBe(2);
  });
});

describe("A2 idempotent drain: a parked line applied once is never applied twice", () => {
  it("restoring the pending file after a successful push does not duplicate the event", async () => {
    world.seedBranch(STATE_BRANCH, baseState(4));
    const hook = installRejectHook();
    const env = world.env("a");
    expect(codeOf(await fail(SB.appendAndPush(env, "lane-u", note("x"))))).toBe(5);
    const pendingFile = path.join(env.cloneDir, "pending", "lane-u.jsonl");
    const saved = fs.readFileSync(pendingFile, "utf8");
    expect(JSON.parse(saved.trim())._nonce).toMatch(/^[0-9a-f]{16}$/);
    fs.rmSync(hook);
    await SB.appendAndPush(env, "lane-u", note("y")); // drains x, then y
    fs.writeFileSync(pendingFile, saved); // a crash left the consumed line behind
    await SB.appendAndPush(env, "lane-u", note("z"));
    const notes = world.remoteLines("lane-u").map((l) => l.note);
    expect(notes.filter((n) => n === "x")).toHaveLength(1);
    expect(notes.slice(-3)).toEqual(["x", "y", "z"]);
  });
});

describe("A3 lock theft and git timeouts", () => {
  const lockDir = () => path.join(world.root, ".ctl.lock");

  it("never reclaims a stale lock whose pid is alive on this host (exit 5 after the wait)", async () => {
    const dir = lockDir();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "pid"), `${process.pid} ${os.hostname()}\n`);
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(dir, old, old);
    let ran = false;
    const err = await fail(
      LK.withLock(dir, 300, async () => {
        ran = true;
      }),
    );
    expect(ran).toBe(false);
    expect(codeOf(err)).toBe(5);
    expect(fs.existsSync(path.join(dir, "pid"))).toBe(true);
  }, 20_000);

  it("reclaims a stale lock whose pid is dead on this host", async () => {
    const dir = lockDir();
    const deadPid = execFileSync(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "pid"), `${deadPid.toString()} ${os.hostname()}\n`);
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(dir, old, old);
    expect(await LK.withLock(dir, 300, async () => "ran")).toBe("ran");
  });

  it("reclaims a stale lock held from another host (age decides)", async () => {
    const dir = lockDir();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "pid"), `${process.pid} some-other-host\n`);
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(dir, old, old);
    expect(await LK.withLock(dir, 300, async () => "ran")).toBe("ran");
  });

  it("a git call that times out ends as CtlError exit 5 with the line parked", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("warm")); // clone exists
    process.env.CTL_GIT_TIMEOUT_MS = "1";
    const err = await fail(SB.appendAndPush(env, "lane-u", note("slow")));
    delete process.env.CTL_GIT_TIMEOUT_MS;
    expect(err).toBeInstanceOf(GT.CtlError);
    expect(codeOf(err)).toBe(5);
    expect(fs.readFileSync(path.join(env.cloneDir, "pending", "lane-u.jsonl"), "utf8")).toContain(
      "slow",
    );
  });

  it("a git call has a 10 s default cap", () => {
    expect(GT.GIT_TIMEOUT_MS).toBe(10_000);
  });
});

describe("A4 a corrupt existing snapshot.json is refused", () => {
  it.each([
    ["not json", "{not json"],
    ["wrong version", JSON.stringify({ v: 1, at: NOW })],
    ["missing acc", JSON.stringify({ v: 2, at: NOW })],
  ])("%s -> CtlError(3, INVALID snapshot), remote unchanged", async (_n, text) => {
    world.seedBranch(STATE_BRANCH, { ...baseState(2), "snapshot.json": text });
    const before = world.remoteHead();
    const err = await fail(SB.appendAndPush(world.env("a"), "lane-u", note("x")));
    expect(codeOf(err)).toBe(3);
    expect(String(err.message)).toContain("INVALID snapshot");
    expect(world.remoteHead()).toBe(before);
  });
});

describe("A5 denylist normalisation (T58)", () => {
  const email = ["someone", "example.co"].join("@");
  const uuidParts = ["3f2a1b4c", "5d6e", "4f70", "8a9b", "0c1d2e3f4a5b"];
  const hex = (n: number) => "a1b2c3d4e5f60718293a4b5c6d7e8f90".slice(0, n);
  const jwt = "ey" + "J" + hex(16) + "." + hex(16);
  const line = (n: string) =>
    JSON.stringify({ seq: 5, lane: "lane-u", type: "lane.note", note: n });

  it.each([
    ["zero-width space inside an email", email.replace("@", "\u200b@")],
    ["zero-width joiner inside a JWT", jwt.slice(0, 10) + "\u200d" + jwt.slice(10)],
    ["full-width email", email.replace("someone", "\uff53omeone").replace("@", "\uff20")],
    ["non-breaking-hyphen UUID", uuidParts.join("\u2011")],
    ["en-dash UUID", uuidParts.join("\u2013")],
    ["hxxps scheme", "hxx" + "ps://x"],
    ["hxxp scheme", "hxx" + "p://x"],
    ["zero-width inside a scheme", "ht\u200btps://x"],
    ["full-width scheme", "\uff48\uff54\uff54\uff50\uff53\uff1a\uff0f\uff0fx"],
  ])("flags %s", (_n, text) => {
    expect(DL.denylistHit(line(`see ${text} tail`))).not.toBeNull();
  });

  it("flags a JSON-escaped email (\\u0040) in raw line text", () => {
    const raw = '{"note":"someone\\u0040example.co"}';
    expect(DL.denylistHit(raw)).not.toBeNull();
  });

  it("still passes a clean line", () => {
    expect(DL.denylistHit(line("phase1 done, see RF-12 and PR 2801"))).toBeNull();
  });
});

describe("A6 size and denylist are checked BEFORE parking", () => {
  it("a denylisted draft with the origin unreachable exits 4 and is never parked", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("warm"));
    fs.rmSync(world.originDir, { recursive: true, force: true });
    const mail = ["someone", "example.co"].join("@");
    const err = await fail(SB.appendAndPush(env, "lane-u", note(`mail ${mail}`)));
    expect(codeOf(err)).toBe(4);
    const p = path.join(env.cloneDir, "pending", "lane-u.jsonl");
    expect(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "").toBe("");
  });

  it("an oversize draft with the origin unreachable exits 3 and is never parked", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("warm"));
    fs.rmSync(world.originDir, { recursive: true, force: true });
    const err = await fail(SB.appendAndPush(env, "lane-u", note("n".repeat(1100))));
    expect(codeOf(err)).toBe(3);
    expect(fs.existsSync(path.join(env.cloneDir, "pending", "lane-u.jsonl"))).toBe(false);
  });
});

describe("A7 archive ranges never overlap across retries", () => {
  it("an already-archived prefix is reused: only the rest is archived (4-5), never an overlapping 1-5", async () => {
    const files = baseState(5);
    const first3 = files["events/lane-u.jsonl"].split("\n").filter(Boolean).slice(0, 3);
    world.seedBranch(STATE_BRANCH, files);
    world.seedBranch(ARCHIVE_BRANCH, { "archive/lane-u/1-3.jsonl": first3.join("\n") + "\n" });
    const env = world.env("srv");
    await CP.compact(env);
    expect(world.remoteFile("archive/lane-u/1-5.jsonl", ARCHIVE_BRANCH)).toBe("");
    expect(world.remoteFile("archive/lane-u/1-3.jsonl", ARCHIVE_BRANCH)).not.toBe("");
    expect(world.remoteFile("archive/lead/1-4.jsonl", ARCHIVE_BRANCH)).not.toBe("");
    expect(world.remoteFile("archive/lane-u/4-5.jsonl", ARCHIVE_BRANCH)).not.toBe("");
    expect(world.remoteLines("lane-u").map((l) => l.seq)).toEqual([0]);
    const all: Record<string, any[]> = {
      lead: files["events/lead.jsonl"]
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
      "lane-u": files["events/lane-u.jsonl"]
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    };
    expect(SB.foldDir(env.cloneDir, REGISTERS, NOW)).toEqual(
      FD.fold(REGISTERS, all, null, null, NOW),
    );
  });
});

describe("A8 ts is clamped to the tip's newest event", () => {
  it("a clock behind the tip still appends (ts = max(now, tip maxTs))", async () => {
    world.seedBranch(STATE_BRANCH, baseState(4)); // newest seed ts is 2026-01-10T09:03:00Z
    const env = world.env("a", { now: () => "2025-01-01T00:00:00Z" });
    const ev = await SB.appendAndPush(env, "lane-u", note("late clock"));
    expect(ev.ts).toBe("2026-01-10T09:03:00Z");
    expect(world.remoteLines("lane-u").pop().ts).toBe("2026-01-10T09:03:00Z");
  });
});

describe("A9 lane names and clone settings", () => {
  it.each(["con", "nul", "aux", "prn", "com1", "com9", "lpt1", "lpt9", "CON", "con.x"])(
    "rejects Windows-reserved lane name %s (exit 2)",
    async (name) => {
      world.seedBranch(STATE_BRANCH, baseState(1));
      expect(codeOf(await fail(SB.appendAndPush(world.env("a"), name, note("x"))))).toBe(2);
    },
  );

  it("clones with core.autocrlf=false", async () => {
    world.seedBranch(STATE_BRANCH, baseState(1));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("x"));
    expect(git(env.cloneDir, ["config", "--local", "core.autocrlf"]).trim()).toBe("false");
    expect(jl({ a: 1 })).toBe('{"a":1}\n');
  });
});
