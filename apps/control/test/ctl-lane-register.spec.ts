/**
 * B938: `ctl lane register <id> --name "<n>" --machine <m> --kind <k> [--inactive]` appends ONE
 * `lane.registered` event through the normal append path (retry / lock / parking / validation /
 * denylist), emitted by the caller's lane, which must be lead-like. Synthetic fixtures only.
 */
import * as fs from "fs";
import * as path from "path";
import { foldDir } from "../src/sources/state-branch";
import { makeWorld, baseState, NOW } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { makeGitShim } from "./helpers/git-shim";
import { runCli, makeWorkRepo, bytes } from "./helpers/spawn-cli";
import type { SpawnOpts } from "./helpers/spawn-cli";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));

let world: World;
beforeEach(() => {
  world = makeWorld();
  world.seedBranch("ctl/state", baseState(2)); // lead (lead), lane-u, lane-v (feature); 4 lead events
});
afterEach(() => world.cleanup());

const register = (
  id: string | null,
  fields: { name?: string; machine?: string; kind?: string; extra?: string[] } = {},
  opts: SpawnOpts = {},
) =>
  runCli(
    world,
    [
      "lane",
      "register",
      ...(id === null ? [] : [id]),
      ...(fields.name === undefined ? [] : ["--name", fields.name]),
      ...(fields.machine === undefined ? [] : ["--machine", fields.machine]),
      ...(fields.kind === undefined ? [] : ["--kind", fields.kind]),
      ...(fields.extra ?? []),
    ],
    { lane: "lead", ...opts },
  );
const GOOD = { name: "Lane W", machine: "mac-w", kind: "test" };

describe("emitter and success path", () => {
  it("a lead lane registers a new lane: one line, seq 5, <= 240 B, stdout `registered <id>`", async () => {
    const work = makeWorkRepo(world);
    const r = await register("lane-w", GOOD, { cwd: work.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("registered lane-w\n");
    const ev = world.remoteLines("lead");
    expect(ev).toHaveLength(5);
    expect(ev[4]).toMatchObject({
      seq: 5,
      lane: "lead",
      type: "lane.registered",
      by: "agent",
      sha: work.shortSha,
      laneId: "lane-w",
      name: "Lane W",
      machine: "mac-w",
      kind: "test",
      active: true,
    });
    const raw = world.remoteFile("events/lead.jsonl").split("\n").filter(Boolean).pop()!;
    expect(bytes(raw)).toBeLessThanOrEqual(240);
  });
  it("--inactive registers active:false", async () => {
    const r = await register("lane-w", { ...GOOD, extra: ["--inactive"] });
    expect(r.code).toBe(0);
    expect(world.remoteLines("lead").pop()).toMatchObject({ laneId: "lane-w", active: false });
  });
  it("the new lane is usable at once: validate passes and it can emit", async () => {
    await register("lane-w", GOOD);
    const n = await runCli(world, ["note", "hello"], { lane: "lane-w", machine: "b" });
    expect(n.code).toBe(0);
    expect(world.remoteLines("lane-w")).toHaveLength(1);
    const v = await runCli(world, ["validate"], { lane: "lead", machine: "b" });
    expect(v.code).toBe(0);
  });
  it("a coordinator or owner lane may register too", async () => {
    expect((await register("coord", { ...GOOD, kind: "coordinator" })).code).toBe(0);
    const r = await register("lane-x", GOOD, { lane: "coord" });
    expect(r.code).toBe(0);
    expect(world.remoteLines("coord").pop()).toMatchObject({
      type: "lane.registered",
      laneId: "lane-x",
    });
  });
  it("registering an existing id updates it and prints `updated <id>`", async () => {
    const r = await register("lane-u", {
      name: "Renamed U",
      machine: "mac-z",
      kind: "bug",
      extra: ["--inactive"],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("updated lane-u\n");
    expect(world.remoteLines("lead")).toHaveLength(5);
    const state = foldDir(
      world.shallowClone("ctl/state", "fold"),
      { tasks: [], releases: [] },
      NOW,
    );
    expect(state.lanes["lane-u"]).toMatchObject({
      name: "Renamed U",
      machine: "mac-z",
      kind: "bug",
      active: false,
    });
  });
  it("registering the same new id twice: registered then updated", async () => {
    expect((await register("lane-w", GOOD)).stdout).toBe("registered lane-w\n");
    expect((await register("lane-w", { ...GOOD, name: "Lane W2" })).stdout).toBe(
      "updated lane-w\n",
    );
  });
  it("--note rides on the event like every change verb", async () => {
    const r = await register("lane-w", { ...GOOD, extra: ["--note", "why"] });
    expect(r.code).toBe(0);
    expect(world.remoteLines("lead").pop()).toMatchObject({ note: "why" });
  });
});

describe("refusals leave the remote unchanged", () => {
  it("a non-lead emitter is exit 3 (illegal) naming the unauthorised emitter", async () => {
    const tip = world.remoteHead();
    const r = await register("lane-w", GOOD, { lane: "lane-u" });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/unauthorised emitter: lane\.registered from lane lane-u \(feature\)/);
    expect(world.remoteHead()).toBe(tip);
  });
  it("an unknown emitter lane is exit 2", async () => {
    const tip = world.remoteHead();
    const r = await register("lane-w", GOOD, { lane: "ghost" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown lane ghost/);
    expect(world.remoteHead()).toBe(tip);
  });
  it("no lane at all is exit 2", async () => {
    const r = await register("lane-w", GOOD, { lane: null });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no lane/);
  });
  it("downgrading the registering lane itself is refused (it would lose the right to emit)", async () => {
    const tip = world.remoteHead();
    const r = await register("lead", { ...GOOD, kind: "feature" });
    expect(r.code).toBe(3);
    expect(world.remoteHead()).toBe(tip);
  });

  const bad: [string, string | null, Record<string, string | undefined>, RegExp][] = [
    ["missing id", null, GOOD, /missing lane id/],
    ["uppercase id", "Lane-W", GOOD, /bad lane name/],
    ["id with a space", "lane w", GOOD, /bad lane name/],
    ["reserved id", "rejected", GOOD, /reserved lane name/],
    ["one-character id", "w", GOOD, /id: /],
    ["id with a dot", "lane.w", GOOD, /id: /],
    ["missing --name", "lane-w", { ...GOOD, name: undefined }, /--name is required/],
    ["empty --name", "lane-w", { ...GOOD, name: "" }, /--name is required/],
    ["blank --name", "lane-w", { ...GOOD, name: "   " }, /name: /],
    ["61-char name", "lane-w", { ...GOOD, name: "n".repeat(61) }, /name: .*60/],
    ["control char in name", "lane-w", { ...GOOD, name: "a\u0007b" }, /name: .*control/],
    ["bidi override in name", "lane-w", { ...GOOD, name: "a\u202Eb" }, /name: .*format/],
    ["zero-width space in name", "lane-w", { ...GOOD, name: "a\u200Bb" }, /name: .*format/],
    ["BOM in name", "lane-w", { ...GOOD, name: "a\uFEFFb" }, /name: .*format/],
    ["bidi isolate in machine", "lane-w", { ...GOOD, machine: "m\u2067x" }, /machine: .*format/],
    [
      "zero-width joiner in machine",
      "lane-w",
      { ...GOOD, machine: "m\u200Dx" },
      /machine: .*format/,
    ],
    ["missing --machine", "lane-w", { ...GOOD, machine: undefined }, /--machine is required/],
    ["control char in machine", "lane-w", { ...GOOD, machine: "m\u0001" }, /machine: .*control/],
    ["missing --kind", "lane-w", { ...GOOD, kind: undefined }, /--kind is required/],
    ["unknown kind", "lane-w", { ...GOOD, kind: "wizard" }, /kind: must be one of /],
  ];
  it.each(bad)("%s is exit 2", async (_label, id, fields, want) => {
    const tip = world.remoteHead();
    const r = await register(id, fields);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(want);
    expect(world.remoteHead()).toBe(tip);
  });

  it("an extra positional is exit 2", async () => {
    const r = await runCli(
      world,
      ["lane", "register", "lane-w", "extra", "--name", "n", "--machine", "m", "--kind", "test"],
      { lane: "lead" },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unexpected argument/);
  });
  it("an unknown lane subcommand stays exit 2 and `lane use` is unchanged", async () => {
    const r = await runCli(world, ["lane", "bogus"], { lane: "lead" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown subcommand bogus/);
    const work = makeWorkRepo(world, "use");
    const u = await runCli(world, ["lane", "use", "lane-v"], { lane: null, cwd: work.dir });
    expect(u.code).toBe(0);
    expect(u.stdout).toBe("✓ lane lane-v\n");
  });
  it("a denylist hit is exit 4", async () => {
    const tip = world.remoteHead();
    const r = await register("lane-w", { ...GOOD, name: "key sk_live_" + "a".repeat(24) });
    expect(r.code).toBe(4);
    expect(world.remoteHead()).toBe(tip);
  });
  it("the 240-byte cap holds: a long machine is exit 3 with the size, nothing pushed", async () => {
    const tip = world.remoteHead();
    const r = await register("lane-w", { ...GOOD, name: "n".repeat(60), machine: "m".repeat(200) });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/event line would be \d+ bytes; the limit is 240/);
    expect(world.remoteHead()).toBe(tip);
  });
  it("an over-cap or denylisted line is refused before any clone or fetch", async () => {
    const shim = makeGitShim(world);
    const long = await register("lane-w", { ...GOOD, machine: "m".repeat(200) }, { env: shim.env });
    expect(long.code).toBe(3);
    const hit = await register(
      "lane-w",
      { ...GOOD, name: "key sk_live_" + "a".repeat(24) },
      { env: shim.env },
    );
    expect(hit.code).toBe(4);
    expect(shim.calls().filter((c) => /^(clone|fetch)\b/.test(c))).toEqual([]);
    expect(fs.existsSync(world.cloneDirOf("a"))).toBe(false);
  });
  it("a line right under the cap is accepted", async () => {
    const r = await register("lane-w", { ...GOOD, name: "n".repeat(50) });
    expect(r.code).toBe(0);
    const raw = world.remoteFile("events/lead.jsonl").split("\n").filter(Boolean).pop()!;
    expect(bytes(raw)).toBeLessThanOrEqual(240);
  });
});

describe("offline: the event is parked and drains on the next call", () => {
  it("origin unreachable after the clone exists: exit 5, pending/lead.jsonl, then both lines push", async () => {
    expect((await runCli(world, ["note", "warm the clone"], { lane: "lead" })).code).toBe(0);
    const away = `${world.originDir}.away`;
    fs.renameSync(world.originDir, away);
    const r = await register("lane-w", GOOD);
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/event parked in pending\//);
    const pending = path.join(world.cloneDirOf("a"), "pending", "lead.jsonl");
    expect(fs.readFileSync(pending, "utf8")).toContain('"laneId":"lane-w"');

    fs.renameSync(away, world.originDir);
    const next = await runCli(world, ["note", "back online"], { lane: "lead" });
    expect(next.code).toBe(0);
    const ev = world.remoteLines("lead");
    expect(ev.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ev[5]).toMatchObject({ type: "lane.registered", laneId: "lane-w" });
    expect(ev[6]).toMatchObject({ type: "lane.note", note: "back online" });
  });
  it("no clone and no origin at all: exit 5 and the line is kept in the offline stash", async () => {
    fs.renameSync(world.originDir, `${world.originDir}.away`);
    const r = await register("lane-w", GOOD, { machine: "fresh" });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/event parked in pending\//);
    const stash = path.join(`${world.cloneDirOf("fresh")}.offline`, "pending", "lead.jsonl");
    expect(fs.readFileSync(stash, "utf8")).toContain('"laneId":"lane-w"');
  });
});
