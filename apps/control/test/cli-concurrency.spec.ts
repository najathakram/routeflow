/**
 * NOTE: the two-real-OS-process lock test (two `ctl` processes on one clone) is deferred to WP8; it
 * needs the built CLI. Here concurrency is exercised in-process (same clone + separate clones).
 *
 * T18/T20/T23 (R9, R11) — the state-branch push loop against throwaway LOCAL git repos.
 *
 * Contract under test (src/sources/*.ts; Env = {origin, cloneDir, stateBranch, registers, now(),
 * sleep?(ms)} — `sleep` is the backoff hook, defaulting to a real timer):
 *   state-branch: appendAndPush(env, lane, draft, mint?) -> Promise<Event>  (seq = last+1, ts = env.now())
 *     failures throw CtlError with numeric `code`: 3 invalid / >1024 B, 4 denylist, 5 push exhausted
 *   lock:         withLock(lockDir, staleMs, fn) -> Promise<T>  (mkdir-atomic, stale dir reclaimed)
 *   git:          git(cwd, args[]) -> string (throws), gitTry(cwd, args[]) -> {ok, out, err}; never a shell
 */
import * as fs from "fs";
import * as path from "path";
import { makeWorld, baseState, git, jl, NOW, World } from "./helpers/temp-repo";

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const SB = tryRequire(() => require("../src/sources/state-branch"));
const LK = tryRequire(() => require("../src/sources/lock"));
const GT = tryRequire(() => require("../src/sources/git"));
const need = (m: any, name: string) => {
  if (!m) throw new Error(`src/sources/${name}.ts does not exist yet`);
  return m;
};

const note = (text: string) => ({ type: "lane.note", by: "agent", note: text });
const codeOf = (e: any) => e?.code ?? e?.exitCode;

let world: World;
beforeEach(() => {
  world = makeWorld();
});
afterEach(() => world.cleanup());

describe("T18 append-and-push happy path", () => {
  it("appends exactly one line seq n+1 with env.now() and pushes it", async () => {
    world.seedBranch("ctl/state", baseState(4));
    const before = world.remoteHead();
    const ev = await need(SB, "state-branch").appendAndPush(world.env("a"), "lane-u", note("x"));
    expect(ev).toMatchObject({ seq: 5, ts: NOW, lane: "lane-u", type: "lane.note", note: "x" });
    const lines = world.remoteLines("lane-u");
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(lines[4]).toMatchObject({ seq: 5, ts: NOW, lane: "lane-u", note: "x", by: "agent" });
    expect(world.remoteHead()).not.toBe(before);
    expect(git(world.originDir, ["rev-list", "--count", `${before}..ctl/state`]).trim()).toBe("1");
    expect(git(world.originDir, ["log", "-1", "--format=%s", "ctl/state"]).trim()).toMatch(
      /^ctl\(lane-u\): #5 lane\.note/,
    );
  });

  it("clones on first use (single branch) and starts a missing lane file at seq 1", async () => {
    world.seedBranch("ctl/state", baseState(0));
    const env = world.env("a");
    expect(fs.existsSync(env.cloneDir)).toBe(false);
    const ev = await need(SB, "state-branch").appendAndPush(env, "lane-v", note("first"));
    expect(ev.seq).toBe(1);
    expect(fs.existsSync(path.join(env.cloneDir, ".git"))).toBe(true);
    expect(world.remoteLines("lane-v")).toHaveLength(1);
  });

  it("mint(state) supplies the id and sees the folded state (RF-1 exists -> RF-2)", async () => {
    world.seedBranch("ctl/state", baseState(1));
    const mint = (s: any) =>
      `RF-${Object.keys(s.tasks).filter((k) => /^RF-\d+$/.test(k)).length + 1}`;
    const ev = await need(SB, "state-branch").appendAndPush(
      world.env("a"),
      "lead",
      { type: "task.created", by: "agent", title: "acme: minted", kind: "feature" },
      mint,
    );
    expect(ev.id).toBe("RF-2");
    expect(world.remoteLines("lead").pop()).toMatchObject({
      seq: 5,
      type: "task.created",
      id: "RF-2",
    });
  });

  it("refuses an event line over 1024 bytes: code 3, remote unchanged", async () => {
    world.seedBranch("ctl/state", baseState(2));
    const before = world.remoteHead();
    const err = await need(SB, "state-branch")
      .appendAndPush(world.env("a"), "lane-u", note("n".repeat(1100)))
      .then(
        () => null,
        (e: any) => e,
      );
    expect(err).not.toBeNull();
    expect(codeOf(err)).toBe(3);
    expect(world.remoteHead()).toBe(before);
  });

  it("refuses a schema-invalid event (unknown payload key): code 3, remote unchanged", async () => {
    world.seedBranch("ctl/state", baseState(2));
    const before = world.remoteHead();
    const err = await need(SB, "state-branch")
      .appendAndPush(world.env("a"), "lane-u", { ...note("x"), bogus: 1 } as any)
      .then(
        () => null,
        (e: any) => e,
      );
    expect(codeOf(err)).toBe(3);
    expect(world.remoteHead()).toBe(before);
  });
});

describe("T20 push exhausted parks the line and the next call drains it", () => {
  function installRejectHook(counter: string): string {
    const hook = path.join(world.originDir, "hooks", "pre-receive");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\necho x >> '${counter}'\nexit 1\n`);
    fs.chmodSync(hook, 0o755);
    return hook;
  }

  it("6 rejected pushes -> code 5, pending/lane-u.jsonl; next call pushes both (n+1, n+2)", async () => {
    world.seedBranch("ctl/state", baseState(4));
    const counter = path.join(world.root, "attempts.txt");
    const hook = installRejectHook(counter);
    const delays: number[] = [];
    const env = world.env("a", {
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });
    const before = world.remoteHead();
    const err = await need(SB, "state-branch")
      .appendAndPush(env, "lane-u", note("x"))
      .then(
        () => null,
        (e: any) => e,
      );
    expect(codeOf(err)).toBe(5);
    expect(fs.readFileSync(counter, "utf8").split("\n").filter(Boolean)).toHaveLength(6);
    expect(world.remoteHead()).toBe(before);
    const pending = fs
      .readFileSync(path.join(env.cloneDir, "pending", "lane-u.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: "lane.note", note: "x" });

    // exponential backoff 500 * 2^(attempt-1) ms, jitter +/-20%; at least the 5 gaps between 6 attempts
    expect(delays.length).toBeGreaterThanOrEqual(5);
    delays.slice(0, 5).forEach((d, i) => {
      const nominal = 500 * 2 ** i;
      expect(d).toBeGreaterThanOrEqual(nominal * 0.8 - 1);
      expect(d).toBeLessThanOrEqual(nominal * 1.2 + 1);
    });

    fs.rmSync(hook);
    const ev = await SB.appendAndPush(env, "lane-u", note("y"));
    expect(ev.seq).toBe(6);
    const lines = world.remoteLines("lane-u");
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lines.slice(4).map((l) => l.note)).toEqual(["x", "y"]);
    const left = path.join(env.cloneDir, "pending", "lane-u.jsonl");
    expect(!fs.existsSync(left) || fs.readFileSync(left, "utf8").trim() === "").toBe(true);
  });

  it("a non-rejection push failure (unreachable origin) is not retried 6 times", async () => {
    world.seedBranch("ctl/state", baseState(2));
    const env = world.env("a");
    await SB.appendAndPush(env, "lane-u", note("ok")); // clone exists now
    fs.rmSync(world.originDir, { recursive: true, force: true });
    const delays: number[] = [];
    const err = await SB.appendAndPush(
      { ...env, sleep: async (ms: number) => void delays.push(ms) },
      "lane-u",
      note("z"),
    ).then(
      () => null,
      (e: any) => e,
    );
    expect(err).not.toBeNull();
    expect(delays.length).toBeLessThan(5);
  });
});

describe("T23 concurrency", () => {
  const assertLane = (lane: string, upto: number) => {
    const lines = world.remoteLines(lane);
    const seqs = lines.map((l) => l.seq);
    expect(seqs).toEqual(Array.from({ length: upto }, (_, i) => i + 1)); // contiguous, no dup, no gap
  };

  it("two appenders on the SAME clone serialize: seqs 5 and 6, each once", async () => {
    world.seedBranch("ctl/state", baseState(4));
    const env = world.env("a");
    const r = await Promise.all(
      [SB.appendAndPush(env, "lane-u", note("p")), SB.appendAndPush(env, "lane-u", note("q"))].map(
        (p) => p,
      ),
    );
    expect(r.map((e: any) => e.seq).sort()).toEqual([5, 6]);
    assertLane("lane-u", 6);
    expect(new Set(world.remoteLines("lane-u").map((l) => l.note))).toEqual(
      new Set(["seed 1", "seed 2", "seed 3", "seed 4", "p", "q"]),
    );
  });

  it("two SEPARATE clones racing one lane: seqs n+1 and n+2 via refetch-and-retry", async () => {
    world.seedBranch("ctl/state", baseState(4));
    const r = await Promise.all([
      need(SB, "state-branch").appendAndPush(world.env("m1"), "lane-u", note("one")),
      SB.appendAndPush(world.env("m2"), "lane-u", note("two")),
    ]);
    expect(r.map((e: any) => e.seq).sort()).toEqual([5, 6]);
    assertLane("lane-u", 6);
  });

  it("k=3 clones racing one lane: seqs n+1..n+3 exactly once", async () => {
    world.seedBranch("ctl/state", baseState(4));
    const r = await Promise.all(
      ["m1", "m2", "m3"].map((m) => SB.appendAndPush(world.env(m), "lane-u", note(`from ${m}`))),
    );
    expect(r.map((e: any) => e.seq).sort()).toEqual([5, 6, 7]);
    assertLane("lane-u", 7);
  });

  it("two clones on DIFFERENT lanes both land; each lane stays contiguous", async () => {
    world.seedBranch("ctl/state", baseState(4));
    await Promise.all([
      SB.appendAndPush(world.env("m1"), "lane-u", note("u")),
      SB.appendAndPush(world.env("m2"), "lane-v", note("v")),
    ]);
    assertLane("lane-u", 5);
    assertLane("lane-v", 1);
  });

  it("minted ids are recomputed per attempt: racing task.created mints RF-2 and RF-3", async () => {
    world.seedBranch("ctl/state", baseState(1));
    const mint = (s: any) =>
      `RF-${Object.keys(s.tasks).filter((k) => /^RF-\d+$/.test(k)).length + 1}`;
    const draft = (t: string) => ({ type: "task.created", by: "agent", title: t, kind: "feature" });
    const r = await Promise.all([
      SB.appendAndPush(world.env("m1"), "lead", draft("acme: one"), mint),
      SB.appendAndPush(world.env("m2"), "lead", draft("acme: two"), mint),
    ]);
    expect(r.map((e: any) => e.id).sort()).toEqual(["RF-2", "RF-3"]);
    expect(world.remoteLines("lead").map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("lock.ts", () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(world.root, ".ctl.lock");
  });

  it("is mutually exclusive: no overlap across 4 concurrent holders, lock dir gone after", async () => {
    const { withLock } = need(LK, "lock");
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        withLock(dir, 30_000, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 15));
          order.push(i);
          active--;
        }),
      ),
    );
    expect(maxActive).toBe(1);
    expect(order.sort()).toEqual([1, 2, 3, 4]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("holds a lock dir with a pid file while running, and releases it when fn throws", async () => {
    const { withLock } = need(LK, "lock");
    await withLock(dir, 30_000, async () => {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
      const files = fs.readdirSync(dir);
      expect(files.length).toBeGreaterThanOrEqual(1);
      const pidFile = files.find((f) => /pid/i.test(f))!;
      expect(fs.readFileSync(path.join(dir, pidFile), "utf8")).toContain(String(process.pid));
    });
    await expect(
      withLock(dir, 30_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("reclaims a lock dir whose mtime is older than 30 s (crashed holder)", async () => {
    const { withLock } = need(LK, "lock");
    fs.mkdirSync(dir);
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(dir, old, old);
    const t0 = Date.now();
    const got = await withLock(dir, 30_000, async () => "ran");
    expect(got).toBe("ran");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("git.ts never uses a shell", () => {
  it("passes shell metacharacters as literal argv", () => {
    const { git: g, gitTry } = need(GT, "git");
    const repo = path.join(world.root, "r");
    fs.mkdirSync(repo);
    g(repo, ["init", "-q"]);
    const evil = `x; touch ${path.join(world.root, "PWNED")} $(touch ${path.join(world.root, "PWNED2")})`;
    g(repo, ["config", "user.name", evil]);
    expect(g(repo, ["config", "user.name"]).trim()).toBe(evil);
    expect(fs.existsSync(path.join(world.root, "PWNED"))).toBe(false);
    expect(fs.existsSync(path.join(world.root, "PWNED2"))).toBe(false);
    const bad = gitTry(repo, ["rev-parse", "--verify", "refs/heads/nope"]);
    expect(bad.ok).toBe(false);
    expect(typeof bad.err).toBe("string");
    expect(gitTry(repo, ["rev-parse", "--git-dir"]).ok).toBe(true);
    expect(jl({ a: 1 })).toBe('{"a":1}\n');
  });
});
