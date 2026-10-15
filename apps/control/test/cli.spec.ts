/**
 * T11, T18, T19, T20 (R9, R20): the built `ctl` CLI as a real child process against local
 * throwaway git remotes. Assumed env: CONTROL_STATE_ORIGIN / CONTROL_STATE_DIR / CTL_LANE.
 */
import * as fs from "fs";
import * as path from "path";
import { makeWorld, baseState, git } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { runCli, makeWorkRepo, bytes } from "./helpers/spawn-cli";
import { IS_WIN, scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));

let world: World;
beforeEach(() => {
  world = makeWorld();
  world.seedBranch("ctl/state", baseState(4));
});
afterEach(() => world.cleanup());

describe("T18 ctl start appends exactly one line", () => {
  it("exit 0; one new line seq 5, sha = working repo short HEAD, <= 240 B; stdout <= 200 B", async () => {
    const work = makeWorkRepo(world);
    const before = Date.now();
    const r = await runCli(world, ["start", "RF-1", "--note", "x"], { cwd: work.dir });
    expect(r.code).toBe(0);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(200);
    const lines = world.remoteLines("lane-u");
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    const ev = lines[4];
    expect(ev).toMatchObject({
      seq: 5,
      lane: "lane-u",
      type: "task.started",
      task: "RF-1",
      note: "x",
      sha: work.shortSha,
    });
    expect(Math.abs(Date.parse(ev.ts) - before)).toBeLessThan(60_000);
    const raw = world.remoteFile("events/lane-u.jsonl").split("\n").filter(Boolean).pop()!;
    expect(bytes(raw)).toBeLessThanOrEqual(240);
  });

  it("note over 80 chars is refused: exit 3, remote unchanged", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["note", "n".repeat(81)]);
    expect(r.code).toBe(3);
    expect(world.remoteHead()).toBe(tip);
  });

  it("ctl note appends a lane.note line", async () => {
    const r = await runCli(world, ["note", "hello"]);
    expect(r.code).toBe(0);
    expect(world.remoteLines("lane-u").pop()).toMatchObject({
      seq: 5,
      type: "lane.note",
      note: "hello",
    });
  });

  it("denylisted text exits 4, remote unchanged", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["note", "key sk_live_" + "a".repeat(24)]);
    expect(r.code).toBe(4);
    expect(world.remoteHead()).toBe(tip);
  });
});

describe("T11 illegal transition", () => {
  it("done on a planned task: exit 3, stderr names the transition, tip unchanged", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["done", "RF-1"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/RF-1/);
    expect(r.stderr).toMatch(/planned/);
    expect(r.stderr).toMatch(/done/);
    expect(world.remoteHead()).toBe(tip);
  });
});

describe("T19 lane resolution", () => {
  it("no lane at all: exit 2, remote unchanged", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["start", "RF-1"], { lane: null });
    expect(r.code).toBe(2);
    expect(world.remoteHead()).toBe(tip);
  });

  it("--lane nope: exit 2, remote unchanged", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["start", "RF-1", "--lane", "nope"], { lane: null });
    expect(r.code).toBe(2);
    expect(world.remoteHead()).toBe(tip);
  });

  it("--lane beats CTL_LANE; .claude/control/.lane is the fallback", async () => {
    const work = makeWorkRepo(world);
    const r1 = await runCli(world, ["note", "via flag", "--lane", "lane-v"], {
      cwd: work.dir,
      lane: "lane-u",
    });
    expect(r1.code).toBe(0);
    expect(world.remoteLines("lane-v")).toHaveLength(1);
    fs.mkdirSync(path.join(work.dir, ".claude", "control"), { recursive: true });
    fs.writeFileSync(path.join(work.dir, ".claude", "control", ".lane"), "lane-v\n");
    const r2 = await runCli(world, ["note", "via file"], { cwd: work.dir, lane: null });
    expect(r2.code).toBe(0);
    expect(world.remoteLines("lane-v").pop()).toMatchObject({ seq: 2, note: "via file" });
  });
});

describe("T20 push exhausted parks and drains", () => {
  it(
    "exit 5 with the line in pending/; the next call pushes both lines",
    async () => {
      const hook = path.join(world.originDir, "hooks", "pre-receive");
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(hook, 0o755);
      const tip = world.remoteHead();

      // the CLI retries a rejected push 6 times with a 0.5 s..8 s backoff (~16 s of real waiting on POSIX);
      // each attempt is a clone/fetch/push cycle, ~5x slower to spawn on Windows, so that run gets the room
      const r = await runCli(world, ["note", "x"], { timeoutMs: IS_WIN ? 100_000 : undefined });
      expect(r.code).toBe(5);
      expect(world.remoteHead()).toBe(tip);
      const pending = path.join(world.cloneDirOf("a"), "pending", "lane-u.jsonl");
      expect(fs.readFileSync(pending, "utf8")).toContain('"note":"x"');

      fs.rmSync(hook);
      const r2 = await runCli(world, ["note", "y"]);
      expect(r2.code).toBe(0);
      const lines = world.remoteLines("lane-u");
      expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(lines.slice(4).map((l) => l.note)).toEqual(["x", "y"]);
      expect(git(world.originDir, ["rev-parse", "ctl/state"]).trim()).toBe(world.remoteHead());
    },
    IS_WIN ? 180_000 : undefined,
  );
});
