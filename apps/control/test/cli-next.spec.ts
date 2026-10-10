/**
 * T21, T22, T37, T63 (R10, R20, R35): `ctl next` / `show` / panels, token-cost oracles.
 * Assumed env: CONTROL_STATE_ORIGIN / CONTROL_STATE_DIR / CTL_LANE.
 */
import { makeWorld, baseState, jl } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { runCli, bytes, lineCount } from "./helpers/spawn-cli";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));

let world: World;
afterEach(() => world.cleanup());

/** lane-u has RF-1 current (progress + a blocker), and 28 more planned tasks, long titles. */
function busyState(): Record<string, string> {
  const files = baseState(0);
  const lead = JSON.parse(`[${files["events/lead.jsonl"].trim().split("\n").join(",")}]`);
  let seq = lead.length;
  for (let i = 2; i <= 30; i++) {
    lead.push({
      seq: ++seq,
      ts: "2026-01-09T09:00:00Z",
      lane: "lead",
      type: "task.created",
      by: "agent",
      id: `RF-${i}`,
      title: `acme: a deliberately long task title number ${i} that must be truncated by the formatter`,
      kind: "feature",
      priority: i % 2 ? "P1" : "P2",
      areas: [`apps/api/src/area${i % 4}/**`],
    });
  }
  files["events/lead.jsonl"] = lead.map(jl).join("");
  files["events/lane-u.jsonl"] = [
    {
      seq: 1,
      ts: "2026-01-10T09:00:00Z",
      lane: "lane-u",
      type: "task.started",
      by: "agent",
      task: "RF-1",
      sha: "abc1234",
    },
    {
      seq: 2,
      ts: "2026-01-10T09:05:00Z",
      lane: "lane-u",
      type: "task.blocked",
      by: "agent",
      task: "RF-1",
      reason: "waiting on review",
    },
    {
      seq: 3,
      ts: "2026-01-10T09:06:00Z",
      lane: "lane-u",
      type: "task.next",
      by: "agent",
      task: "RF-7",
    },
  ]
    .map(jl)
    .join("");
  return files;
}

describe("T21 ctl next on a busy fixture (>= 25 eligible)", () => {
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", busyState());
  });

  it("exit 0; <= 30 lines; <= 1,536 B; current, blocker, explicit next, five eligible", async () => {
    const r = await runCli(world, ["next", "--lane", "lane-u"]);
    expect(r.code).toBe(0);
    expect(lineCount(r.stdout)).toBeLessThanOrEqual(30);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(1536);
    expect(r.stdout).toMatch(/current RF-1/);
    expect(r.stdout).toMatch(/waiting on review/);
    expect(r.stdout).toMatch(/★ RF-7/);
    const eligible = r.stdout.split("\n").filter((l) => /RF-(?:[2-9]|[12]\d|30)\b/.test(l));
    expect(eligible.length).toBeGreaterThanOrEqual(5);
    expect(r.stdout).not.toMatch(/RF-2[0-9] /);
  });

  it("a change call prints <= 200 B and ctl show is <= 1,024 B (T37)", async () => {
    const s = await runCli(world, ["show", "RF-1"]);
    expect(s.code).toBe(0);
    expect(bytes(s.stdout)).toBeLessThanOrEqual(1024);
    expect(s.stdout).toMatch(/acme: a deliberately long task title/);
    expect(s.stdout).toMatch(/blocked|started|status/i);
    expect(s.stdout).toMatch(/P\d/);
    const n = await runCli(world, ["note", "hi"]);
    expect(n.code).toBe(0);
    expect(bytes(n.stdout)).toBeLessThanOrEqual(200);
  });

  it("every appended line stays <= 240 B", async () => {
    await runCli(world, ["note", "m".repeat(80)]);
    await runCli(world, ["progress", "RF-1", "--phase", "phase1"]);
    const raw = world.remoteFile("events/lane-u.jsonl").split("\n").filter(Boolean);
    expect(raw.length).toBeGreaterThanOrEqual(4);
    for (const l of raw.slice(3)) expect(bytes(l)).toBeLessThanOrEqual(240);
  });

  it("T63 overlap / piggyback / waste: exit 0, each <= 40 lines", async () => {
    for (const args of [["overlap"], ["piggyback", "--lane", "lane-u"], ["waste"]]) {
      const r = await runCli(world, args);
      expect(r.code).toBe(0);
      expect(lineCount(r.stdout)).toBeLessThanOrEqual(40);
    }
  });
});

describe("T22 corrupt state", () => {
  it("exit 0 and exactly one line starting `control: INVALID`", async () => {
    world = makeWorld();
    const files = baseState(2);
    files["events/lane-u.jsonl"] += "{this is not json\n";
    world.seedBranch("ctl/state", files);
    const r = await runCli(world, ["next", "--lane", "lane-u"]);
    expect(r.code).toBe(0);
    expect(lineCount(r.stdout)).toBe(1);
    expect(r.stdout.startsWith("control: INVALID")).toBe(true);
  });
});
