/**
 * WP3 fix round 1, group A (Opus HIGH review): parked-line handling, lock safety, git timeouts,
 * snapshot validity, denylist normalisation, pre-park checks, archive naming, ts clamp, lane names.
 * Sample strings are assembled at runtime so this file stays clean for the no-client-data scan.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { scaled } from "./helpers/platform";
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
  delete process.env.CTL_GIT_CLONE_TIMEOUT_MS;
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

  it(
    "never reclaims a stale lock whose pid is alive on this host (exit 5 after the wait)",
    async () => {
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
    },
    scaled(20_000),
  );

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

describe("N1 lock: a live same-host holder is never displaced; release is token-checked", () => {
  const lockDir = () => path.join(world.root, ".ctl.lock");

  it(
    "a live holder's lock aged 51 minutes is still not reclaimed (waiter gets exit 5)",
    async () => {
      const dir = lockDir();
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), `${process.pid} ${os.hostname()}\n`);
      const old = new Date(Date.now() - 51 * 60_000);
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
    },
    scaled(20_000),
  );

  it("release removes the dir only while the token is still ours", async () => {
    const dir = lockDir();
    await LK.withLock(dir, 30_000, async () => {
      const tokenFile = path.join(dir, "token");
      expect(fs.readFileSync(tokenFile, "utf8").trim()).toMatch(/^[0-9a-f]{32}$/);
      fs.writeFileSync(tokenFile, "taken-over-by-b\n"); // B took the lock over
    });
    expect(fs.readFileSync(path.join(dir, "token"), "utf8")).toBe("taken-over-by-b\n");
    LK.forceUnlock(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("release still removes our own lock", async () => {
    const dir = lockDir();
    await LK.withLock(dir, 30_000, async () => undefined);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("N2 nonces are kept by age; a parked line older than the retained window is set aside", () => {
  it(
    "600 appends later a restored parked line is still deduped (exactly one copy)",
    async () => {
      world.seedBranch(STATE_BRANCH, baseState(4));
      const hook = installRejectHook();
      const env = world.env("a");
      expect(codeOf(await fail(SB.appendAndPush(env, "lane-u", note("x"))))).toBe(5);
      const pendingFile = path.join(env.cloneDir, "pending", "lane-u.jsonl");
      const saved = fs.readFileSync(pendingFile, "utf8");
      fs.rmSync(hook);
      await SB.appendAndPush(env, "lane-u", note("y"));
      const nonces = path.join(env.cloneDir, "nonces.txt");
      const filler = Array.from(
        { length: 600 },
        (_, i) => `${i.toString(16).padStart(16, "0")} ${NOW}`,
      );
      fs.appendFileSync(nonces, filler.join("\n") + "\n");
      git(env.cloneDir, ["add", "-A"]);
      git(env.cloneDir, [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@localhost",
        "commit",
        "-q",
        "-m",
        "fill",
      ]);
      git(env.cloneDir, ["push", "-q", "origin", `HEAD:refs/heads/${STATE_BRANCH}`]);
      fs.writeFileSync(pendingFile, saved);
      await SB.appendAndPush(env, "lane-u", note("z"));
      fs.writeFileSync(pendingFile, saved); // and again: the nonce must survive being rewritten
      await SB.appendAndPush(env, "lane-u", note("w"));
      const notes = world.remoteLines("lane-u").map((l) => l.note);
      expect(notes.filter((n) => n === "x")).toHaveLength(1);
    },
    scaled(30_000),
  );

  it("a parked line older than the oldest retained nonce is moved to pending/rejected/ with a notice", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("first")); // nonces.txt now holds one entry
    const stale = JSON.stringify({
      ...note("ancient"),
      _nonce: "0123456789abcdef",
      _at: "2000-01-01T00:00:00Z",
    });
    fs.mkdirSync(path.join(env.cloneDir, "pending"), { recursive: true });
    fs.writeFileSync(path.join(env.cloneDir, "pending", "lane-u.jsonl"), stale + "\n");
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await SB.appendAndPush(env, "lane-u", note("second"));
      expect(write.mock.calls.map((c) => String(c[0])).join("")).toMatch(/set aside/);
    } finally {
      write.mockRestore();
    }
    expect(world.remoteLines("lane-u").map((l) => l.note)).not.toContain("ancient");
    expect(
      fs.readFileSync(path.join(env.cloneDir, "pending", "rejected", "lane-u.jsonl"), "utf8"),
    ).toContain("ancient");
  });

  it("nonces.txt holds `nonce ts` pairs", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("first"));
    const lines = fs.readFileSync(path.join(env.cloneDir, "nonces.txt"), "utf8").trim().split("\n");
    expect(lines[lines.length - 1]).toMatch(new RegExp(`^[0-9a-f]{16} ${NOW}$`));
  });
});

describe("R32 the nonce window is 7 days", () => {
  const day = (d: number) =>
    new Date(Date.parse(NOW) - d * 86_400_000).toISOString().replace(".000Z", "Z");
  const row = (i: number, ts: string) => `${i.toString(16).padStart(16, "0")} ${ts}`;

  it("compaction prunes nonces older than 7 days and keeps the window", async () => {
    world.seedBranch(STATE_BRANCH, {
      ...baseState(3),
      "nonces.txt":
        [row(1, day(8)), row(2, day(30)), row(3, day(6)), row(4, day(1))].join("\n") + "\n",
    });
    await CP.compact(world.env("srv"));
    const kept = world.remoteFile("nonces.txt").split("\n").filter(Boolean);
    expect(kept).toEqual([row(3, day(6)), row(4, day(1))]);
  });

  it("a parked line older than 7 days goes to pending/rejected/ even when the file still has older nonces", async () => {
    world.seedBranch(STATE_BRANCH, { ...baseState(2), "nonces.txt": row(1, day(9)) + "\n" });
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("first"));
    const old = JSON.stringify({ ...note("week-old"), _nonce: "0123456789abcdef", _at: day(8) });
    fs.mkdirSync(path.join(env.cloneDir, "pending"), { recursive: true });
    fs.writeFileSync(path.join(env.cloneDir, "pending", "lane-u.jsonl"), old + "\n");
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await SB.appendAndPush(env, "lane-u", note("second"));
      expect(write.mock.calls.map((c) => String(c[0])).join("")).toMatch(/set aside/);
    } finally {
      write.mockRestore();
    }
    expect(world.remoteLines("lane-u").map((l) => l.note)).not.toContain("week-old");
    expect(
      fs.readFileSync(path.join(env.cloneDir, "pending", "rejected", "lane-u.jsonl"), "utf8"),
    ).toContain("week-old");
  });

  it("append prunes rows older than 7 days too", async () => {
    world.seedBranch(STATE_BRANCH, {
      ...baseState(2),
      "nonces.txt": [row(1, day(8)), row(2, day(2))].join("\n") + "\n",
    });
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("x"));
    const rows = world.remoteFile("nonces.txt").split("\n").filter(Boolean);
    expect(rows.some((r) => r.startsWith(row(1, "").trim()))).toBe(false);
    expect(rows).toContain(row(2, day(2)));
  });
});

describe("ensureClone completion marker", () => {
  const marker = (dir: string) => path.join(dir, ".git", "ctl-clone-complete");

  it("a fresh clone ends with the marker", async () => {
    world.seedBranch(STATE_BRANCH, baseState(1));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("x"));
    expect(fs.existsSync(marker(env.cloneDir))).toBe(true);
  });

  it("OUR half-made clone (ctl-owned, no marker, no usable refs) is removed and re-cloned", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    fs.mkdirSync(path.join(env.cloneDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(env.cloneDir, ".git", "ctl-owned"), env.origin + "\n"); // ours
    fs.writeFileSync(path.join(env.cloneDir, ".git", "shallow.lock"), "");
    fs.writeFileSync(path.join(env.cloneDir, "junk.txt"), "half");
    const ev = await SB.appendAndPush(env, "lane-u", note("x"));
    expect(ev.seq).toBe(3);
    expect(fs.existsSync(marker(env.cloneDir))).toBe(true);
    expect(fs.existsSync(path.join(env.cloneDir, "junk.txt"))).toBe(false);
  });

  it("a complete clone that predates the marker is kept (its parked lines survive) and gets the marker", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("first"));
    fs.rmSync(marker(env.cloneDir));
    fs.writeFileSync(path.join(env.cloneDir, ".git", "sentinel"), "keep");
    await SB.ensureClone(env);
    expect(fs.existsSync(path.join(env.cloneDir, ".git", "sentinel"))).toBe(true);
    expect(fs.existsSync(marker(env.cloneDir))).toBe(true);
  });

  it("two ensureClone calls racing on a fresh dir both succeed", async () => {
    world.seedBranch(STATE_BRANCH, baseState(1));
    const env = world.env("a");
    const r = await Promise.all([SB.ensureClone(env), SB.ensureClone(env)]);
    expect(r[0]).toBe(r[1]);
    expect(fs.existsSync(marker(env.cloneDir))).toBe(true);
  });
});

describe("ensureClone never touches a dir the ctl did not create", () => {
  const OWNED_MSG = /is not a ctl clone; move it or set CONTROL_STATE_DIR/;
  const fingerprint = (dir: string) =>
    [
      git(dir, ["rev-parse", "HEAD"]).trim(),
      git(dir, ["status", "--porcelain", "-uall"]).trim(),
      fs.readFileSync(path.join(dir, "precious.txt"), "utf8"),
      fs.readFileSync(path.join(dir, "events", "lane-u.jsonl"), "utf8"),
    ].join("|");

  function foreignClone(env: any): World {
    const other = makeWorld();
    other.seedBranch(STATE_BRANCH, baseState(3));
    git(other.root, [
      "clone",
      "-q",
      "--single-branch",
      "--branch",
      STATE_BRANCH,
      other.originUrl,
      env.cloneDir,
    ]);
    fs.writeFileSync(path.join(env.cloneDir, "precious.txt"), "do not delete");
    return other;
  }

  it("a repo with a DIFFERENT origin (and origin/<stateBranch>) survives byte-identical; exit 5", async () => {
    world.seedBranch(STATE_BRANCH, baseState(1));
    const env = world.env("a");
    const other = foreignClone(env);
    try {
      const before = fingerprint(env.cloneDir);
      const err = await fail(SB.appendAndPush(env, "lane-u", note("x")));
      expect(codeOf(err)).toBe(5);
      expect(String(err.message)).toMatch(OWNED_MSG);
      expect(fingerprint(env.cloneDir)).toBe(before);
      // a stray marker from an older build does not make it ours either
      fs.writeFileSync(path.join(env.cloneDir, ".git", "ctl-clone-complete"), "ok\n");
      expect(codeOf(await fail(SB.appendAndPush(env, "lane-u", note("y"))))).toBe(5);
      expect(fingerprint(env.cloneDir)).toBe(before);
      expect(world.remoteLines("lane-u")).toHaveLength(1); // only the seed line
    } finally {
      other.cleanup();
    }
  });

  it("compact refuses it too", async () => {
    world.seedBranch(STATE_BRANCH, baseState(1));
    const env = world.env("a");
    const other = foreignClone(env);
    try {
      const before = fingerprint(env.cloneDir);
      expect(codeOf(await fail(CP.compact(env)))).toBe(5);
      expect(fingerprint(env.cloneDir)).toBe(before);
    } finally {
      other.cleanup();
    }
  });

  it("an unrelated non-git dir survives untouched; exit 5", async () => {
    world.seedBranch(STATE_BRANCH, baseState(1));
    const env = world.env("a");
    fs.mkdirSync(env.cloneDir, { recursive: true });
    fs.writeFileSync(path.join(env.cloneDir, "thesis.docx"), "years of work");
    const err = await fail(SB.appendAndPush(env, "lane-u", note("x")));
    expect(codeOf(err)).toBe(5);
    expect(String(err.message)).toMatch(OWNED_MSG);
    expect(fs.readFileSync(path.join(env.cloneDir, "thesis.docx"), "utf8")).toBe("years of work");
  });

  it("a full SAME-origin clone without ctl-owned is refused, dirty edit and untracked file byte-identical", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    git(world.root, [
      "clone",
      "-q",
      "--single-branch",
      "--branch",
      STATE_BRANCH,
      world.originUrl,
      env.cloneDir,
    ]);
    fs.appendFileSync(path.join(env.cloneDir, "events", "lane-u.jsonl"), "uncommitted edit\n");
    fs.writeFileSync(path.join(env.cloneDir, "precious.txt"), "untracked work");
    const snap = () =>
      [
        git(env.cloneDir, ["rev-parse", "HEAD"]).trim(),
        fs.readFileSync(path.join(env.cloneDir, "events", "lane-u.jsonl"), "utf8"),
        fs.readFileSync(path.join(env.cloneDir, "precious.txt"), "utf8"),
      ].join("|");
    const before = snap();
    for (const call of [
      () => SB.appendAndPush(env, "lane-u", note("x")),
      () => SB.ensureClone(env),
      () => CP.compact(env),
    ]) {
      const err = await fail(call());
      expect(codeOf(err)).toBe(5);
      expect(String(err.message)).toMatch(OWNED_MSG);
      expect(snap()).toBe(before);
    }
    expect(fs.existsSync(path.join(env.cloneDir, ".git", "ctl-owned"))).toBe(false);
  });

  it("a fresh clone records its origin in .git/ctl-owned", async () => {
    world.seedBranch(STATE_BRANCH, baseState(1));
    const env = world.env("a");
    await SB.ensureClone(env);
    expect(fs.readFileSync(path.join(env.cloneDir, ".git", "ctl-owned"), "utf8").trim()).toBe(
      env.origin,
    );
  });
});

describe("N3 clone and fetch have their own, longer timeout", () => {
  it("defaults: 120 s for clone/fetch, 10 s for everything else", () => {
    expect(GT.GIT_CLONE_TIMEOUT_MS).toBe(120_000);
    expect(GT.GIT_TIMEOUT_MS).toBe(10_000);
  });

  it("a slow fetch (CTL_GIT_CLONE_TIMEOUT_MS=1) ends as exit 5 with the line parked", async () => {
    world.seedBranch(STATE_BRANCH, baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("warm"));
    process.env.CTL_GIT_CLONE_TIMEOUT_MS = "1";
    const err = await fail(SB.appendAndPush(env, "lane-u", note("slowfetch")));
    delete process.env.CTL_GIT_CLONE_TIMEOUT_MS;
    expect(codeOf(err)).toBe(5);
    expect(fs.readFileSync(path.join(env.cloneDir, "pending", "lane-u.jsonl"), "utf8")).toContain(
      "slowfetch",
    );
  });

  it("the short cap does not apply to fetch: CTL_GIT_TIMEOUT_MS=1 alone still fetches (push is what times out)", () => {
    process.env.CTL_GIT_TIMEOUT_MS = "1";
    try {
      expect(GT.cloneTimeoutMs()).toBe(120_000);
      expect(GT.shortTimeoutMs()).toBe(1);
    } finally {
      delete process.env.CTL_GIT_TIMEOUT_MS;
    }
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
    ["ideographic full stop in an email", ["a", "b\u3002com"].join("@")],
    ["half-width ideographic stop in an email", ["a", "b\uff61com"].join("@")],
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
