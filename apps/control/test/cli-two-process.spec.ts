/**
 * The WP3-deferred test (R9): two REAL OS processes of the built CLI, started concurrently.
 * Assumed env: CONTROL_STATE_ORIGIN / CONTROL_STATE_DIR / CTL_LANE.
 */
import { makeWorld, baseState } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { runCli, makeWorkRepo, bytes } from "./helpers/spawn-cli";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));

let world: World;
beforeEach(() => {
  world = makeWorld();
  world.seedBranch("ctl/state", baseState(4));
});
afterEach(() => world.cleanup());

describe("two processes, one lane", () => {
  it("one clone: seq n+1 and n+2, no duplicate, no interleave, both exit 0", async () => {
    const work = makeWorkRepo(world);
    const [a, b] = await Promise.all([
      runCli(world, ["note", "alpha"], { machine: "a", cwd: work.dir }),
      runCli(world, ["note", "bravo"], { machine: "a", cwd: work.dir }),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const lines = world.remoteLines("lane-u");
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      lines
        .slice(4)
        .map((l) => l.note)
        .sort(),
    ).toEqual(["alpha", "bravo"]);
    for (const l of world.remoteFile("events/lane-u.jsonl").split("\n").filter(Boolean)) {
      expect(bytes(l)).toBeLessThanOrEqual(240);
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  it("two clones on one lane: distinct seqs via the retry loop", async () => {
    const [a, b] = await Promise.all([
      runCli(world, ["note", "alpha"], { machine: "a" }),
      runCli(world, ["note", "bravo"], { machine: "b" }),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const seqs = world.remoteLines("lane-u").map((l) => l.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("three processes on one FRESH clone dir: the clone is taken once, all exit 0, seqs distinct", async () => {
    const work = makeWorkRepo(world);
    const r = await Promise.all(
      ["alpha", "bravo", "charlie"].map((n) =>
        runCli(world, ["note", n], { machine: "fresh", cwd: work.dir }),
      ),
    );
    expect(r.map((x) => x.code)).toEqual([0, 0, 0]);
    expect(world.remoteLines("lane-u").map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
