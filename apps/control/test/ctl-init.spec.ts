/**
 * B938: `ctl init --roster <file>` creates the orphan `ctl/state` branch on the resolved state
 * remote. Specs run the built CLI against file:// bare origins under the OS temp dir (never the
 * network, never the real repo); roster lanes are synthetic (`lead`, `lane-a`, ...).
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { foldDir } from "../src/sources/state-branch";
import { makeWorld, baseState, git, NOW } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { makeGitShim, withoutOriginProbes } from "./helpers/git-shim";
import { IS_WIN, itPosix, scaled } from "./helpers/platform";
import { runCli, bytes } from "./helpers/spawn-cli";
import type { SpawnOpts } from "./helpers/spawn-cli";

jest.setTimeout(scaled(30_000));

const AT = "@";
const SLUG = ["najathakram", "routeflow"].join("/");
const README =
  "State branch of the control dashboard. Written only by `ctl`. Never edit by hand, never merge.\n";

const ROSTER = [
  { id: "lead", name: "Lead", machine: "mac-a", kind: "lead" },
  { id: "lane-a", name: "Lane A", machine: "mac-a", kind: "feature" },
  { id: "lane-b", name: "Lane B", machine: "mac-b", kind: "bug", active: false },
];

let world: World;
let tmp: string;
beforeEach(() => {
  world = makeWorld();
  tmp = path.join(world.root, "tmp");
  fs.mkdirSync(tmp);
});
afterEach(() => world.cleanup());

const writeRoster = (entries: unknown, raw?: string): string => {
  const file = path.join(world.root, "roster.json");
  fs.writeFileSync(file, raw ?? JSON.stringify(entries));
  return file;
};

const init = (args: string[], opts: SpawnOpts = {}) =>
  runCli(world, ["init", ...args], {
    lane: "lead",
    ...opts,
    env: { CONTROL_NOW: NOW, TMPDIR: tmp, ...opts.env },
  });

/** git calls other than the offline origin-resolution probes (insteadOf, local-repo remotes). */
const gitRuns = (shim: { calls(): string[] }): string[] => withoutOriginProbes(shim.calls());
const lines = (): Record<string, unknown>[] => world.remoteLines("lead");
const tmpEntries = (): string[] => fs.readdirSync(tmp);

describe("roster validation (exit 2, precise message, nothing pushed)", () => {
  const entry = (over: Record<string, unknown>) => ({ ...ROSTER[1], ...over });
  const many = Array.from({ length: 61 }, (_, i) => ({
    id: `lane-${i}`,
    name: `Lane ${i}`,
    machine: "m",
    kind: "feature",
  }));
  const cases: [string, unknown, RegExp][] = [
    ["not an array", { id: "lead" }, /roster: must be a JSON array/],
    ["empty array", [], /roster: needs 1 to 60 entries/],
    ["61 entries", many, /roster: needs 1 to 60 entries \(got 61\)/],
    ["entry not an object", ["lead"], /roster\[0\]: must be an object/],
    ["entry is null", [null], /roster\[0\]: must be an object/],
    ["unknown field", [ROSTER[0], entry({ acitve: false })], /roster\[1\]: unknown field "acitve"/],
    ["id missing", [{ name: "x", machine: "m", kind: "lead" }], /roster\[0\]\.id: /],
    ["id not a string", [entry({ id: 7 })], /roster\[0\]\.id: /],
    ["id uppercase", [entry({ id: "Lane-A" })], /roster\[0\]\.id: /],
    ["id with a space", [entry({ id: "lane a" })], /roster\[0\]\.id: /],
    ["id reserved", [entry({ id: "rejected" })], /roster\[0\]\.id: /],
    ["id one character", [entry({ id: "a" })], /roster\[0\]\.id: /],
    ["id with a dot", [entry({ id: "lane.a" })], /roster\[0\]\.id: /],
    ["id too long", [entry({ id: "a".repeat(42) })], /roster\[0\]\.id: /],
    ["id duplicate", [ROSTER[0], entry({ id: "lead" })], /roster\[1\]\.id: duplicate/],
    ["kind missing", [{ id: "lead", name: "x", machine: "m" }], /roster\[0\]\.kind: /],
    ["kind unknown", [entry({ kind: "wizard" })], /roster\[0\]\.kind: must be one of /],
    ["name empty", [entry({ name: "" })], /roster\[0\]\.name: /],
    ["name blank", [entry({ name: "   " })], /roster\[0\]\.name: /],
    ["name not a string", [entry({ name: 5 })], /roster\[0\]\.name: /],
    ["name 61 chars", [entry({ name: "n".repeat(61) })], /roster\[0\]\.name: .*60/],
    [
      "name with a control char",
      [entry({ name: "bad\u0007name" })],
      /roster\[0\]\.name: .*control/,
    ],
    ["name with a newline", [entry({ name: "two\nlines" })], /roster\[0\]\.name: .*control/],
    ["machine empty", [entry({ machine: "" })], /roster\[0\]\.machine: /],
    ["machine not a string", [entry({ machine: 3 })], /roster\[0\]\.machine: /],
    [
      "machine with a control char",
      [entry({ machine: "m\u0000" })],
      /roster\[0\]\.machine: .*control/,
    ],
    ["active not a boolean", [entry({ active: "yes" })], /roster\[0\]\.active: must be a boolean/],
    ["name with a bidi override", [entry({ name: "ab\u202Ecd" })], /roster\[0\]\.name: .*format/],
    [
      "name with a zero-width space",
      [entry({ name: "ab\u200Bcd" })],
      /roster\[0\]\.name: .*format/,
    ],
    ["name with a BOM", [entry({ name: "ab\uFEFFcd" })], /roster\[0\]\.name: .*format/],
    ["name with a bidi isolate", [entry({ name: "ab\u2066cd" })], /roster\[0\]\.name: .*format/],
    ["name with a word joiner", [entry({ name: "ab\u2060cd" })], /roster\[0\]\.name: .*format/],
    [
      "machine with a zero-width joiner",
      [entry({ machine: "m\u200Dx" })],
      /roster\[0\]\.machine: .*format/,
    ],
    [
      "machine with a right-to-left mark",
      [entry({ machine: "m\u200Fx" })],
      /roster\[0\]\.machine: .*format/,
    ],
  ];
  it.each(cases)("%s", async (_label, roster, want) => {
    const r = await init(["--roster", writeRoster(roster)]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(want);
    expect(world.remoteHas("ctl/state")).toBe(false);
    expect(tmpEntries()).toEqual([]);
  });

  it("an exact 60-entry roster and a 60-character name are accepted (dry run)", async () => {
    const sixty = many.slice(0, 60).map((e, i) => (i === 0 ? { ...e, kind: "lead" } : e));
    sixty[1] = { ...sixty[1], name: "n".repeat(60) };
    const r = await init(["--roster", writeRoster(sixty), "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/60 lanes/);
  });

  it("missing --roster, a missing file and non-JSON exit 2 without echoing file contents", async () => {
    expect((await init([])).code).toBe(2);
    const missing = await init(["--roster", path.join(world.root, "nope.json")]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/roster: cannot read/);
    const junk = await init(["--roster", writeRoster(null, "secret-marker-9 {not json")]);
    expect(junk.code).toBe(2);
    expect(junk.stderr).toMatch(/roster: not valid JSON/);
    expect(junk.stderr).not.toContain("secret-marker-9");
  });

  // POSIX-only: Windows has no mkfifo and no /dev nodes (the directory case below still covers the
  // "not a regular file" guard there)
  itPosix("a FIFO roster is exit 2 immediately (never opened for a blocking read)", async () => {
    const fifo = path.join(world.root, "roster.fifo");
    execFileSync("mkfifo", [fifo]);
    const r = await init(["--roster", fifo]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/roster: not a regular file/);
    expect(tmpEntries()).toEqual([]);
  });
  itPosix("a character device roster (/dev/zero) is exit 2, not an endless read", async () => {
    const r = await init(["--roster", "/dev/zero"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/roster: not a regular file/);
  });
  it("a directory roster is exit 2", async () => {
    const r = await init(["--roster", tmp]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/roster: not a regular file/);
  });
  it("the roster is capped at 64 KB: one byte over is too large, exactly 64 KB is read", async () => {
    const padded = (n: number): string => {
      const body = JSON.stringify(ROSTER);
      return body + " ".repeat(n - Buffer.byteLength(body));
    };
    const over = await init(["--roster", writeRoster(null, padded(64 * 1024 + 1))]);
    expect(over.code).toBe(2);
    expect(over.stderr).toMatch(/roster: file too large/);
    const exact = await init(["--roster", writeRoster(null, padded(64 * 1024)), "--dry-run"]);
    expect(exact.code).toBe(0);
    expect(exact.stdout).toMatch(/3 lanes/);
  });
  it("never echoes the offending value, only its index and field", async () => {
    const r = await init([
      "--roster",
      writeRoster([entry({ name: "secret-marker-7".padEnd(70, "x") })]),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/roster\[0\]\.name/);
    expect(r.stderr).not.toContain("secret-marker-7");
  });
});

describe("emitter selection", () => {
  it("defaults to the first lead-like entry, even when it is not first in the roster", async () => {
    const roster = [
      ROSTER[1],
      { id: "coord", name: "Coord", machine: "mac-a", kind: "coordinator" },
      ROSTER[0],
    ];
    const r = await init(["--roster", writeRoster(roster)]);
    expect(r.code).toBe(0);
    expect(world.remoteFile("events/coord.jsonl")).not.toBe("");
    expect(world.remoteFile("events/lead.jsonl")).toBe("");
    expect(world.remoteLines("coord").map((l) => l.laneId)).toEqual(["lane-a", "coord", "lead"]);
    expect(world.remoteLines("coord").every((l) => l.lane === "coord")).toBe(true);
  });
  it("--emitter picks another lead-like lane in the roster", async () => {
    const roster = [
      ROSTER[0],
      { id: "owner-x", name: "Owner", machine: "mac-a", kind: "owner" },
      ROSTER[1],
    ];
    const r = await init(["--roster", writeRoster(roster), "--emitter", "owner-x"]);
    expect(r.code).toBe(0);
    expect(world.remoteLines("owner-x")).toHaveLength(3);
    expect(world.remoteFile("events/lead.jsonl")).toBe("");
  });
  it("--emitter that is not lead-like exits 2", async () => {
    const r = await init(["--roster", writeRoster(ROSTER), "--emitter", "lane-a"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/emitter lane-a/);
    expect(world.remoteHas("ctl/state")).toBe(false);
  });
  it("--emitter that is not in the roster, or is a bad name, exits 2", async () => {
    const ghost = await init(["--roster", writeRoster(ROSTER), "--emitter", "ghost"]);
    expect(ghost.code).toBe(2);
    expect(ghost.stderr).toMatch(/emitter ghost is not in the roster/);
    const bad = await init(["--roster", writeRoster(ROSTER), "--emitter", "Bad Name"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/bad lane name/);
    expect(world.remoteHas("ctl/state")).toBe(false);
  });
  it("no lead-like lane and no --emitter exits 2", async () => {
    const r = await init(["--roster", writeRoster([ROSTER[1], ROSTER[2]])]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/lead-like/);
    expect(world.remoteHas("ctl/state")).toBe(false);
  });
});

describe("branch content, orphan history, single plain push", () => {
  it("writes README.md and events/<emitter>.jsonl, nothing else", async () => {
    const shim = makeGitShim(world);
    const r = await init(["--roster", writeRoster(ROSTER)], { env: shim.env });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^✓ initialised ctl\/state: 3 lanes, emitter lead \(pushed [0-9a-f]{7,}\)\n$/,
    );
    expect(bytes(r.stdout)).toBeLessThanOrEqual(200);
    expect(
      git(world.originDir, ["ls-tree", "-r", "--name-only", "ctl/state"]).trim().split("\n"),
    ).toEqual(["README.md", "events/lead.jsonl"]);
    expect(world.remoteFile("README.md")).toBe(README);
  });
  it("one lane.registered line per roster entry: seq 1..n, lane = emitter, by ctl, injected clock", async () => {
    await init(["--roster", writeRoster(ROSTER)]);
    expect(lines()).toEqual([
      {
        seq: 1,
        ts: NOW,
        lane: "lead",
        type: "lane.registered",
        by: "ctl",
        laneId: "lead",
        name: "Lead",
        machine: "mac-a",
        kind: "lead",
        active: true,
      },
      {
        seq: 2,
        ts: NOW,
        lane: "lead",
        type: "lane.registered",
        by: "ctl",
        laneId: "lane-a",
        name: "Lane A",
        machine: "mac-a",
        kind: "feature",
        active: true,
      },
      {
        seq: 3,
        ts: NOW,
        lane: "lead",
        type: "lane.registered",
        by: "ctl",
        laneId: "lane-b",
        name: "Lane B",
        machine: "mac-b",
        kind: "bug",
        active: false,
      },
    ]);
    const raw = world.remoteFile("events/lead.jsonl").split("\n").filter(Boolean);
    for (const l of raw) expect(bytes(l)).toBeLessThanOrEqual(240);
    expect(world.remoteFile("events/lead.jsonl").endsWith("\n")).toBe(true);
  });
  it("is an orphan: one commit, no parent; branches already on the origin are untouched", async () => {
    world.seedBranch("feature/acme", { "a.txt": "acme\n" });
    const before = world.remoteHead("feature/acme");
    const r = await init(["--roster", writeRoster(ROSTER)]);
    expect(r.code).toBe(0);
    expect(git(world.originDir, ["rev-list", "--count", "ctl/state"]).trim()).toBe("1");
    expect(
      git(world.originDir, ["rev-list", "--parents", "-n1", "ctl/state"]).trim().split(" "),
    ).toHaveLength(1);
    expect(world.remoteHead("feature/acme")).toBe(before);
    const refs = git(world.originDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .trim()
      .split("\n")
      .sort();
    expect(refs).toEqual(["ctl/state", "feature/acme"]);
  });
  it("commits as ctl and leaves no temp dir and no state clone behind", async () => {
    await init(["--roster", writeRoster(ROSTER)]);
    expect(git(world.originDir, ["log", "-1", "--format=%an <%ae>", "ctl/state"]).trim()).toBe(
      "ctl <ctl@localhost>",
    );
    expect(git(world.originDir, ["log", "-1", "--format=%s", "ctl/state"]).trim()).toMatch(
      /^ctl\(init\)/,
    );
    expect(tmpEntries()).toEqual([]);
    expect(fs.existsSync(world.cloneDirOf("a"))).toBe(false);
  });
  it("pushes exactly once and never with force", async () => {
    const shim = makeGitShim(world);
    const r = await init(["--roster", writeRoster(ROSTER)], { env: shim.env });
    expect(r.code).toBe(0);
    const pushes = shim.calls().filter((c) => c.split(" ").includes("push"));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).not.toMatch(/--force|\s-f\b|--mirror|\+/);
    expect(pushes[0]).toContain("HEAD:refs/heads/ctl/state");
  });
  it("a push that loses a race is rejected, not forced: exit 5, the racer's branch survives", async () => {
    const shim = makeGitShim(world, { raceOriginDir: world.originDir });
    const r = await init(["--roster", writeRoster(ROSTER)], { env: shim.env });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/push rejected/);
    expect(git(world.originDir, ["log", "-1", "--format=%s", "ctl/state"]).trim()).toBe("race");
    expect(tmpEntries()).toEqual([]);
  });
  it("an origin that rejects the push (hook) is exit 5 and leaves no branch", async () => {
    const hook = path.join(world.originDir, "hooks", "pre-receive");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const r = await init(["--roster", writeRoster(ROSTER)]);
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/push rejected/);
    expect(world.remoteHas("ctl/state")).toBe(false);
  });
  it("an unreachable origin is exit 5 (cannot reach), temp dir removed", async () => {
    const r = await init(["--roster", writeRoster(ROSTER)], {
      env: { CONTROL_STATE_ORIGIN: "file:///nonexistent-acme/state.git" },
    });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/cannot reach the state remote/);
    expect(tmpEntries()).toEqual([]);
  });
});

describe("refusals", () => {
  it("an already-initialised origin is exit 3, origin unchanged, with the register hint", async () => {
    world.seedBranch("ctl/state", baseState(2));
    const tip = world.remoteHead();
    const r = await init(["--roster", writeRoster(ROSTER)]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("already initialised: use `ctl lane register`");
    expect(world.remoteHead()).toBe(tip);
    expect(tmpEntries()).toEqual([]);
  });
  it("a second init after a successful one is refused the same way", async () => {
    const roster = writeRoster(ROSTER);
    expect((await init(["--roster", roster])).code).toBe(0);
    const tip = world.remoteHead();
    const again = await init(["--roster", roster]);
    expect(again.code).toBe(3);
    expect(world.remoteHead()).toBe(tip);
  });
  it.each([
    ["env", { CONTROL_STATE_ORIGIN: `https://github.com/${SLUG}.git` }, []],
    ["flag", {}, ["--origin", `git${AT}github.com:${SLUG}.git`]],
  ] as const)(
    "a product-repo origin (%s) is exit 2 before ANY git call",
    async (_n, env, extra) => {
      const shim = makeGitShim(world);
      const r = await init(["--roster", writeRoster(ROSTER), ...extra], {
        env: { ...shim.env, ...env },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/refusing state remote/);
      expect(shim.calls()).toEqual([]);
      expect(tmpEntries()).toEqual([]);
    },
  );
  it("a product-repo origin from the config file is refused too", async () => {
    const cfg = path.join(world.root, "cfg");
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, "origin"), `https://github.com/${SLUG}\n`);
    const shim = makeGitShim(world);
    const r = await init(["--roster", writeRoster(ROSTER)], {
      env: { ...shim.env, CONTROL_STATE_ORIGIN: "", CONTROL_CONFIG_DIR: cfg },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/refusing state remote/);
    expect(shim.calls()).toEqual([]);
  });
  it("no state remote configured is exit 2 with the fix", async () => {
    const cfg = path.join(world.root, "empty");
    fs.mkdirSync(cfg);
    const r = await init(["--roster", writeRoster(ROSTER)], {
      env: { CONTROL_STATE_ORIGIN: "", CONTROL_CONFIG_DIR: cfg },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no state remote configured — run `ctl origin set <url>`");
  });
  it("the --origin flag points init at another bare origin", async () => {
    const other = makeWorld();
    try {
      const r = await init(["--roster", writeRoster(ROSTER), "--origin", other.originUrl]);
      expect(r.code).toBe(0);
      expect(other.remoteHas("ctl/state")).toBe(true);
      expect(world.remoteHas("ctl/state")).toBe(false);
    } finally {
      other.cleanup();
    }
  });
});

describe("line guards run before the network is touched", () => {
  it("a denylist hit is exit 4 and nothing is pushed", async () => {
    const roster = [{ ...ROSTER[0] }, { ...ROSTER[1], name: "key sk_live_" + "a".repeat(24) }];
    const shim = makeGitShim(world);
    const r = await init(["--roster", writeRoster(roster)], { env: shim.env });
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/refused/);
    expect(world.remoteHas("ctl/state")).toBe(false);
    expect(gitRuns(shim)).toEqual([]);
    expect(tmpEntries()).toEqual([]);
  });
  it("a line over 240 bytes is exit 3 naming the entry; nothing is pushed", async () => {
    const roster = [{ ...ROSTER[0] }, { ...ROSTER[1], machine: "m".repeat(200) }];
    const shim = makeGitShim(world);
    const r = await init(["--roster", writeRoster(roster)], { env: shim.env });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/roster\[1\].*240/);
    expect(gitRuns(shim)).toEqual([]);
    expect(world.remoteHas("ctl/state")).toBe(false);
  });
  it("a state that fails validation (bad clock) is exit 3 before any git call", async () => {
    const shim = makeGitShim(world);
    const r = await init(["--roster", writeRoster(ROSTER)], {
      env: { ...shim.env, CONTROL_NOW: "yesterday" },
    });
    expect(r.code).toBe(3);
    expect(gitRuns(shim)).toEqual([]);
    expect(world.remoteHas("ctl/state")).toBe(false);
  });
});

describe("--dry-run", () => {
  it("prints the plan (lanes, emitter, byte size) and pushes nothing, even with an unreachable origin", async () => {
    const shim = makeGitShim(world);
    const r = await init(["--roster", writeRoster(ROSTER), "--dry-run"], {
      env: { ...shim.env, CONTROL_STATE_ORIGIN: "file:///nonexistent-acme/state.git" },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^plan: ctl\/state with 3 lanes, emitter lead, \d+ bytes \(dry run, nothing pushed\)\n$/,
    );
    expect(gitRuns(shim)).toEqual([]);
    expect(tmpEntries()).toEqual([]);
  });
  it("the byte size is README plus the events file", async () => {
    const r = await init(["--roster", writeRoster(ROSTER), "--dry-run"]);
    const real = await init(["--roster", writeRoster(ROSTER)]);
    expect(real.code).toBe(0);
    const total =
      bytes(world.remoteFile("README.md")) + bytes(world.remoteFile("events/lead.jsonl"));
    expect(r.stdout).toContain(`${total} bytes`);
  });
  it("leaves the origin empty", async () => {
    await init(["--roster", writeRoster(ROSTER), "--dry-run"]);
    expect(world.remoteHas("ctl/state")).toBe(false);
  });
});

describe("end to end: init, then validate / next / lane register against that origin", () => {
  it(
    "validate passes, the fold knows every registered lane, next works, register appends",
    async () => {
      expect((await init(["--roster", writeRoster(ROSTER)])).code).toBe(0);

      const v = await runCli(world, ["validate"], { lane: "lead", machine: "e2e" });
      expect(v.code).toBe(0);
      expect(v.stdout).toMatch(/valid \(3 events\)/);

      const clone = world.shallowClone("ctl/state", "fold");
      const state = foldDir(clone, { tasks: [], releases: [] }, NOW);
      expect(Object.keys(state.lanes).sort()).toEqual(["lane-a", "lane-b", "lead"]);
      expect(state.lanes["lane-a"]).toMatchObject({
        name: "Lane A",
        machine: "mac-a",
        kind: "feature",
        active: true,
      });
      expect(state.lanes["lane-b"]).toMatchObject({ kind: "bug", active: false });

      const n = await runCli(world, ["next", "--json"], { lane: "lane-a", machine: "e2e" });
      expect(n.code).toBe(0);
      expect(JSON.parse(n.stdout)).toMatchObject({ lane: "lane-a" });

      const reg = await runCli(
        world,
        ["lane", "register", "lane-c", "--name", "Lane C", "--machine", "mac-c", "--kind", "test"],
        { lane: "lead", machine: "e2e" },
      );
      expect(reg.code).toBe(0);
      expect(reg.stdout).toBe("registered lane-c\n");
      expect(lines().map((l) => l.seq)).toEqual([1, 2, 3, 4]);
      expect(lines()[3]).toMatchObject({ type: "lane.registered", laneId: "lane-c", lane: "lead" });

      const v2 = await runCli(world, ["validate"], { lane: "lead", machine: "e2e" });
      expect(v2.stdout).toMatch(/valid \(4 events\)/);
      // init + validate + next + register + validate is six process starts, each a clone or a fetch; on
      // Windows that is real work well past the 30 s default
    },
    IS_WIN ? 150_000 : undefined,
  );
});
