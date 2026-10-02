/**
 * WP8 fix round 2 (Opus review): size gate before any fetch, offline durability, sync sha,
 * `next` failure shapes, flag parsing, atomic adopt, `lane use`.
 */
import * as fs from "fs";
import * as path from "path";
import { makeWorld, baseState, git, jl } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { runCli, makeWorkRepo, bytes, lineCount } from "./helpers/spawn-cli";
import { IS_WIN, scaled } from "./helpers/platform";
import { installWinFailGit } from "./helpers/win-git-shim";

jest.setTimeout(scaled(90_000));

let world: World;
afterEach(() => world.cleanup());

describe("1 size gate before any fetch", () => {
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(4));
  });

  it("an 80-char CJK note (240 B of text) exits 3, remote unchanged", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["note", "漢".repeat(80)]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/240/);
    expect(world.remoteHead()).toBe(tip);
  });

  it("block with a 120-char accented reason exits 3 on bytes, remote unchanged", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["block", "RF-1", "--reason", "é".repeat(120)]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/240/);
    expect(world.remoteHead()).toBe(tip);
  });

  it("the gate runs before any clone: an unreachable origin still exits 3, not 5", async () => {
    fs.renameSync(world.originDir, world.originDir + ".gone");
    const r = await runCli(world, ["note", "漢".repeat(80)]);
    fs.renameSync(world.originDir + ".gone", world.originDir);
    expect(r.code).toBe(3);
  });
});

describe("2 offline durability", () => {
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(4));
  });

  it("origin gone: exit 5 with the line in pending/; restored: both land in order", async () => {
    expect((await runCli(world, ["note", "a"])).code).toBe(0);
    fs.renameSync(world.originDir, world.originDir + ".gone");
    const r = await runCli(world, ["note", "x"]);
    fs.renameSync(world.originDir + ".gone", world.originDir);
    expect(r.code).toBe(5);
    const pending = path.join(world.cloneDirOf("a"), "pending", "lane-u.jsonl");
    expect(fs.readFileSync(pending, "utf8")).toContain('"note":"x"');
    expect((await runCli(world, ["note", "y"])).code).toBe(0);
    expect(
      world
        .remoteLines("lane-u")
        .slice(4)
        .map((l) => l.note),
    ).toEqual(["a", "x", "y"]);
  });

  it("no clone yet and origin gone: exit 5, line parked, lands after restore", async () => {
    fs.renameSync(world.originDir, world.originDir + ".gone");
    const r = await runCli(world, ["note", "z"], { machine: "b" });
    fs.renameSync(world.originDir + ".gone", world.originDir);
    expect(r.code).toBe(5);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/^ctl: event parked in pending\//);
    expect((await runCli(world, ["note", "w"], { machine: "b" })).code).toBe(0);
    expect(
      world
        .remoteLines("lane-u")
        .slice(4)
        .map((l) => l.note),
    ).toEqual(["z", "w"]);
  });
});

describe("3 sync keeps the merged commit's sha and is idempotent", () => {
  it("bug.fixed carries the commit sha; a second sync appends nothing", async () => {
    world = makeWorld();
    const files = baseState(0);
    world.seedBranch("ctl/state", files);
    // bugs come from the register (fixture dir), not from events
    const fx = path.join(world.root, "fixture");
    fs.mkdirSync(path.join(fx, "registers"), { recursive: true });
    fs.writeFileSync(
      path.join(fx, "registers", "bugs.jsonl"),
      jl({ id: "B5", title: "acme: a bug", severity: "low", register: "Open", location: "x.ts:1" }),
    );
    const env = { CONTROL_FIXTURE: fx };
    const work = makeWorkRepo(world);
    const bare = path.join(world.root, "work-origin.git");
    fs.mkdirSync(bare);
    git(bare, ["init", "-q", "--bare"]);
    git(work.dir, ["remote", "add", "origin", bare]);
    git(work.dir, ["push", "-q", "origin", "main:master"]);
    const since = git(work.dir, ["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(work.dir, "f.txt"), "x\n");
    git(work.dir, ["add", "-A"]);
    git(work.dir, ["commit", "-q", "-m", "fix: thing (#12)", "-m", "Bug: B5"]);
    git(work.dir, ["push", "-q", "origin", "main:master"]);
    const head = git(work.dir, ["rev-parse", "HEAD"]).trim();

    const r1 = await runCli(world, ["sync", "--since", since], { cwd: work.dir, env });
    expect(r1.code).toBe(0);
    expect(r1.stdout).toMatch(/1 appended, 0 skipped/);
    const ev = world
      .remoteLines("lane-u")
      .filter((l) => l.type === "bug.fixed")
      .pop();
    expect(ev).toMatchObject({ bug: "B5", pr: 12, sha: head });
    const r2 = await runCli(world, ["sync", "--since", since], { cwd: work.dir, env });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/0 appended, 0 skipped/);
  });
});

describe("4 next failure shapes", () => {
  const cases: [string, () => void][] = [
    [
      "snapshot not JSON",
      () => world.seedBranch("ctl/state", { ...baseState(2), "snapshot.json": "{nope" }),
    ],
    [
      "snapshot wrong shape",
      () => world.seedBranch("ctl/state", { ...baseState(2), "snapshot.json": '{"v":1}' }),
    ],
    [
      "corrupt event line",
      () =>
        world.seedBranch("ctl/state", {
          ...baseState(2),
          "events/lane-u.jsonl": baseState(2)["events/lane-u.jsonl"] + "{bad\n",
        }),
    ],
  ];
  for (const quiet of [false, true]) {
    for (const [name, seed] of cases) {
      it(`${name}${quiet ? " --quiet" : ""}: one INVALID line, exit 0, no paths`, async () => {
        world = makeWorld();
        seed();
        const r = await runCli(world, ["next", ...(quiet ? ["--quiet"] : [])]);
        expect(r.code).toBe(0);
        expect(lineCount(r.stdout)).toBe(1);
        expect(r.stdout.startsWith("control: INVALID")).toBe(true);
        expect(bytes(r.stdout)).toBeLessThanOrEqual(121);
        expect(r.stdout).not.toMatch(/[\\/]/);
      });
    }
    it(`missing branch${quiet ? " --quiet" : ""}: one UNAVAILABLE line, exit 0, no paths`, async () => {
      world = makeWorld();
      const r = await runCli(world, ["next", ...(quiet ? ["--quiet"] : [])]);
      expect(r.code).toBe(0);
      expect(lineCount(r.stdout)).toBe(1);
      expect(r.stdout.startsWith("control: UNAVAILABLE")).toBe(true);
      expect(bytes(r.stdout)).toBeLessThanOrEqual(121);
      expect(r.stdout).not.toMatch(/[\\/]/);
    });
  }
});

describe("5 flag parsing and 7 lane use", () => {
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(4));
  });

  it("a flag value starting with -- exits 2, remote unchanged", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["block", "RF-1", "--reason", "--phase", "p"]);
    expect(r.code).toBe(2);
    expect(world.remoteHead()).toBe(tip);
  });

  it("an explicit empty --lane exits 2", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["note", "hi", "--lane", ""]);
    expect(r.code).toBe(2);
    expect(world.remoteHead()).toBe(tip);
  });

  it("lane use refuses an unregistered lane (2) and accepts a registered one", async () => {
    const work = makeWorkRepo(world);
    expect((await runCli(world, ["lane", "use", "nope"], { cwd: work.dir })).code).toBe(2);
    expect(fs.existsSync(path.join(work.dir, ".claude", "control", ".lane"))).toBe(false);
    expect((await runCli(world, ["lane", "use", "lane-v"], { cwd: work.dir })).code).toBe(0);
    expect(fs.readFileSync(path.join(work.dir, ".claude", "control", ".lane"), "utf8").trim()).toBe(
      "lane-v",
    );
  });

  it("next --json carries a truncated flag and stays under 16 KB", async () => {
    const r = await runCli(world, ["next", "--json"]);
    expect(r.code).toBe(0);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(16384);
    expect(JSON.parse(r.stdout)).toHaveProperty("truncated", false);
  });
});

describe("6 adopt is atomic across a failed second push", () => {
  it("a retry reuses the minted task instead of minting RF-(n+1)", async () => {
    world = makeWorld();
    const files = baseState(0);
    files["events/lane-u.jsonl"] = jl({
      seq: 1,
      ts: "2026-01-10T09:00:00Z",
      lane: "lane-u",
      type: "task.proposed",
      by: "agent",
      tmpId: "lane-u.1",
      title: "acme: proposed thing",
      kind: "feature",
      areas: ["apps/api/src/x/**"],
    });
    world.seedBranch("ctl/state", files);
    // pre-receive: let push 1 through, reject pushes 2..7 (the whole retry budget)
    const cnt = path.join(world.root, "push-count");
    const hook = path.join(world.originDir, "hooks", "pre-receive");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nn=$(cat "${cnt}" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > "${cnt}"\n` +
        `[ $n -ge 2 ] && [ $n -le 7 ] && exit 1\nexit 0\n`,
    );
    fs.chmodSync(hook, 0o755);

    const r1 = await runCli(world, ["adopt", "lane-u.1"], { lane: "lead", timeoutMs: 80_000 });
    expect(r1.code).toBe(5);
    fs.rmSync(hook);
    const r2 = await runCli(world, ["adopt", "lane-u.1"], { lane: "lead" });
    expect(r2.code).toBe(0);

    const lead = world.remoteLines("lead");
    const created = lead.filter((l) => l.type === "task.created" && l.id !== "RF-1");
    expect(created.map((l) => l.id)).toEqual(["RF-2"]);
    expect(lead.filter((l) => l.type === "task.adopted")).toHaveLength(1);
  });
});

describe("round 3", () => {
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(4));
  });

  it("propose fits 240 B by truncating the title and dropping areas; hopeless => exit 3", async () => {
    const ok = await runCli(world, [
      "propose",
      "t".repeat(120),
      "--kind",
      "feature",
      "--areas",
      "apps/api/src/a/**,apps/api/src/b/**,apps/api/src/c/**,apps/api/src/d/**",
    ]);
    expect(ok.code).toBe(0);
    const raw = world.remoteFile("events/lane-u.jsonl").split("\n").filter(Boolean).pop()!;
    expect(bytes(raw)).toBeLessThanOrEqual(240);
    expect(JSON.parse(raw).type).toBe("task.proposed");
    const tip = world.remoteHead();
    const bad = await runCli(world, [
      "propose",
      "x",
      "--kind",
      "feature",
      "--areas",
      "a/".repeat(150),
    ]);
    expect(bad.code).toBe(3);
    expect(world.remoteHead()).toBe(tip);
  });

  it("next with the origin gone prints the state plus an offline marker line", async () => {
    expect((await runCli(world, ["note", "a"])).code).toBe(0);
    fs.renameSync(world.originDir, world.originDir + ".gone");
    const r = await runCli(world, ["next"]);
    fs.renameSync(world.originDir + ".gone", world.originDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/offline/);
    expect(r.stdout).toMatch(/lane lane-u/);
    expect(lineCount(r.stdout)).toBeLessThanOrEqual(30);
  });
});

describe("next --hook", () => {
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(4));
  });

  it("origin gone: reads the local clone only, < 2 s, exit 0, prints the brief", async () => {
    expect((await runCli(world, ["note", "a"])).code).toBe(0);
    fs.renameSync(world.originDir, world.originDir + ".gone");
    const t0 = Date.now();
    const r = await runCli(world, ["next", "--hook"]);
    const ms = Date.now() - t0;
    fs.renameSync(world.originDir + ".gone", world.originDir);
    expect(r.code).toBe(0);
    // the hook budget is 2 s on POSIX; a Windows process start (node + git) alone costs about 1 s, so there
    // the same "never waits on the network" proof gets 8 s (an unreachable origin would take 25 s+)
    expect(ms).toBeLessThan(IS_WIN ? 8000 : 2000);
    expect(r.stdout).toMatch(/lane lane-u/);
    expect(lineCount(r.stdout)).toBeLessThanOrEqual(30);
  });

  it("no clone yet: prints nothing, exit 0, and does not create a clone", async () => {
    const r = await runCli(world, ["next", "--hook"], { machine: "z" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(world.cloneDirOf("z"))).toBe(false);
  });

  it("no lane: prints nothing, exit 0", async () => {
    const r = await runCli(world, ["next", "--hook"], { lane: null });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("git stderr credential scrub", () => {
  beforeEach(() => {
    world = makeWorld();
  });

  it("an error carrying https://user:tok@host/x prints <redacted> and no token", async () => {
    // a stub git that fails with a credentialed URL in stderr (real git strips userinfo itself)
    const bin = fs.mkdtempSync(path.join(world.root, "stubgit-"));
    let shimEnv: Record<string, string> = {};
    if (IS_WIN) {
      // Windows cannot run an extensionless sh script as `git`: the exe twin fails every call alike
      shimEnv = installWinFailGit(bin, "*", "fatal: unable to access https://user:tok@host/x");
    } else {
      fs.writeFileSync(
        path.join(bin, "git"),
        "#!/bin/sh\necho 'fatal: unable to access https://user:tok@host/x' >&2\nexit 1\n",
        { mode: 0o755 },
      );
    }
    const r = await runCli(world, ["note", "hello"], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...shimEnv },
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toMatch(/tok/);
    expect(r.stderr).toContain("<redacted>");
  });
});
