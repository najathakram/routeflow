/**
 * WP3 fix round 1, group B: the snapshot resume contract.
 *   foldEvents(acc|null, base, eventsByLane) -> FoldAcc      (pure; JSON round-trippable)
 *   project(acc, base, github, railway, now) -> ControlState (stale calc + version hash)
 *   fold(...) == project(foldEvents(null, ...), ...)
 *   validateEvents(files, ctx, resume?)  with resume = {lastByLane, mintedIds, tracks, ...}
 */
import * as path from "path";
import { makeWorld, git, jl, NOW, STATE_BRANCH, World } from "./helpers/temp-repo";
import { scaled } from "./helpers/platform";

const FD = require("../src/domain/fold");
const VAL = require("../src/domain/validate");
const SB = require("../src/sources/state-branch");
const CP = require("../src/sources/compact");

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `acme ${id}`,
  kind: "feature",
  status: "planned",
  priority: "P2",
  release: null,
  areas: ["apps/web/**"],
  dependsOn: [],
  related: [],
  lane: null,
  phase: null,
  pr: null,
  notes: null,
  ...over,
});
const BASE1 = {
  tasks: [
    task("F-1", { release: "R1" }),
    task("F-2", { release: "R1", status: "code-complete" }),
    task("B1", { kind: "bug", status: "planned" }),
  ],
  releases: [{ id: "R1", name: "Release one", shipDate: "2026-01-20", status: "planned" }],
};
/** Register edits that do not change how any event applies (titles, priority, areas, extra ids). */
const BASE2 = {
  tasks: [
    task("F-1", { release: "R1", title: "renamed one", priority: "P0", areas: ["apps/api/**"] }),
    task("F-2", { release: "R1", status: "code-complete", notes: "note", effort: "L" }),
    task("B1", { kind: "bug", status: "planned", priority: "P1" }),
    task("F-9", { title: "new register row" }),
  ],
  releases: [
    { id: "R1", name: "Release one (renamed)", shipDate: "2026-01-20", status: "planned" },
    { id: "R9", name: "Release nine", shipDate: null, status: "planned" },
  ],
};

const byLane = (evs: any[]) => {
  const m: Record<string, any[]> = {};
  for (const e of evs) (m[e.lane] ??= []).push(e);
  return m;
};

/** Random (often illegal, fold must still agree with itself) history in global order. */
function history(rand: () => number): any[] {
  const out: any[] = [];
  const seqs: Record<string, number> = {};
  let t = Date.parse("2026-01-10T08:00:00Z");
  const push = (lane: string, body: Record<string, unknown>) => {
    seqs[lane] = (seqs[lane] ?? 0) + 1;
    t += 1000;
    out.push({
      seq: seqs[lane],
      ts: new Date(t).toISOString().replace(".000Z", "Z"),
      lane,
      by: "agent",
      ...body,
    });
  };
  const lanes = ["lane-u", "lane-v", "lane-w"];
  const reg = (id: string, kind: string) =>
    push("lead", {
      type: "lane.registered",
      laneId: id,
      name: id,
      machine: "mac",
      kind,
      active: true,
    });
  reg("lead", "lead");
  lanes.forEach((l) => reg(l, "feature"));
  [1, 2, 3].forEach((n) =>
    push("lead", { type: "task.created", id: `RF-${n}`, title: `acme task ${n}`, kind: "feature" }),
  );
  push("lead", { type: "release.created", id: "R2", name: "Two", shipDate: "2026-02-01" });
  const pool = ["RF-1", "RF-2", "RF-3", "F-1", "F-2", "B1"];
  const phases = ["idea", "design", "phase1", "phase2", "testing", "qa"];
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];
  const proposed: string[] = [];
  const n = 40 + Math.floor(rand() * 40);
  for (let i = 0; i < n; i++) {
    const lane = pick(lanes);
    const tk = pick(pool);
    switch (Math.floor(rand() * 22)) {
      case 0:
      case 1:
        push(lane, { type: "task.started", task: tk });
        break;
      case 2:
      case 3:
        push(lane, { type: "task.progress", task: tk, phase: pick(phases) });
        break;
      case 4:
        push(lane, { type: "task.blocked", task: tk, reason: `r${i}` });
        break;
      case 5:
        push(lane, { type: "task.unblocked", task: tk });
        break;
      case 6:
        push(lane, { type: "task.done", task: tk, pr: 100 + i });
        break;
      case 7:
        push(lane, { type: "task.reopened", task: tk, reason: "again" });
        break;
      case 8:
        push("lead", {
          type: "task.priority",
          task: tk,
          priority: pick(["P0", "P1", "P3"]),
          prev: "P2",
        });
        break;
      case 9:
        push("lead", {
          type: "task.release",
          task: tk,
          release: pick(["R1", "R2", null]),
          prev: null,
        });
        break;
      case 10:
        push("lead", { type: "task.released", task: tk, release: "R1", sha: "abc1234" });
        break;
      case 11:
        push("lead", { type: "release.shipped", release: pick(["R1", "R2"]), sha: "abc1234" });
        break;
      case 12:
        push("lead", {
          type: "release.moved",
          release: "R1",
          shipDate: "2026-03-01",
          prev: "2026-01-20",
          why: "slip",
        });
        break;
      case 13:
        push("lead", { type: "task.areas", task: tk, areas: ["apps/control/**"] });
        break;
      case 14:
        push("lead", { type: "task.lane", task: tk, toLane: pick(lanes) });
        break;
      case 15:
        push("lead", { type: "waste.ack", key: `k${i}`, why: "ok" });
        break;
      case 16:
        push("lead", { type: "pr.superseded", pr: 5 + (i % 3), supersededBy: 9, why: "dup" });
        break;
      case 17:
        push(lane, { type: "bug.filed", bug: "B1", task: tk });
        break;
      case 18:
        push(lane, { type: "bug.fixed", bug: "B1", pr: 200 + i });
        break;
      case 19: {
        const tmp = `${lane}.${i}`;
        proposed.push(tmp);
        push(lane, {
          type: "task.proposed",
          tmpId: tmp,
          title: `idea ${i}`,
          kind: "feature",
          areas: [],
        });
        break;
      }
      case 20:
        if (proposed.length > 0) {
          push("lead", { type: "task.adopted", tmpId: proposed.shift(), task: pick(pool) });
          break;
        }
        push(lane, { type: "task.next", task: tk });
        break;
      default:
        push(lane, { type: "lane.note", note: `n${i}` });
    }
  }
  return out;
}

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("B1 fold == project(foldEvents(null, ...)) and the acc resumes across JSON", () => {
  it("fold is exactly project(foldEvents(null))", () => {
    const evs = history(prng(1));
    const a = FD.fold(BASE1, byLane(evs), null, null, NOW);
    const b = FD.project(FD.foldEvents(null, BASE1, byLane(evs)), BASE1, null, null, NOW);
    expect(b).toEqual(a);
    expect(b.version).toBe(a.version);
  });

  it("200 seeded histories: ONE cut, acc through JSON, deep-equal incl. version", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = prng(seed);
      const all = history(rand);
      const cut = Math.floor(rand() * (all.length + 1));
      const expected = FD.fold(BASE1, byLane(all), null, null, NOW);
      const head = roundTrip(FD.foldEvents(null, BASE1, byLane(all.slice(0, cut))));
      const acc = FD.foldEvents(head, BASE1, byLane(all.slice(cut)));
      const got = FD.project(roundTrip(acc), BASE1, null, null, NOW);
      expect({ seed, cut, state: got }).toEqual({ seed, cut, state: expected });
      expect({ seed, v: got.version }).toEqual({ seed, v: expected.version });
    }
  });

  it("200 seeded histories: TWO cuts, acc through JSON twice, deep-equal incl. version", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = prng(seed * 7919);
      const all = history(rand);
      const c1 = Math.floor(rand() * (all.length + 1));
      const c2 = c1 + Math.floor(rand() * (all.length - c1 + 1));
      const expected = FD.fold(BASE1, byLane(all), null, null, NOW);
      let acc = roundTrip(FD.foldEvents(null, BASE1, byLane(all.slice(0, c1))));
      acc = roundTrip(FD.foldEvents(acc, BASE1, byLane(all.slice(c1, c2))));
      acc = FD.foldEvents(acc, BASE1, byLane(all.slice(c2)));
      const got = FD.project(roundTrip(acc), BASE1, null, null, NOW);
      expect({ seed, c1, c2, state: got }).toEqual({ seed, c1, c2, state: expected });
    }
  });

  it("200 seeded histories: registers changed AFTER the cut (untouched fields follow the new register)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = prng(seed * 104729);
      const all = history(rand);
      const cut = Math.floor(rand() * (all.length + 1));
      const expected = FD.fold(BASE2, byLane(all), null, null, NOW);
      const head = roundTrip(FD.foldEvents(null, BASE1, byLane(all.slice(0, cut))));
      const acc = FD.foldEvents(head, BASE2, byLane(all.slice(cut)));
      const got = FD.project(roundTrip(acc), BASE2, null, null, NOW);
      expect({ seed, cut, state: got }).toEqual({ seed, cut, state: expected });
    }
  });

  it("acc never embeds register data: no register title/notes appear in it", () => {
    const acc = FD.foldEvents(null, BASE2, byLane(history(prng(3))));
    const text = JSON.stringify(acc);
    expect(text).not.toContain("renamed one");
    expect(text).not.toContain("Release one (renamed)");
    expect(text).not.toContain("new register row");
  });
});

/** Mixed, valid, ~2.2 MB: 6 lanes x 5 tasks cycling progress/blocked/unblocked (few tasks, many events). */
function bigMixed(): { files: Record<string, string>; events: any[] } {
  const events: any[] = [];
  const seqs: Record<string, number> = {};
  let t = Date.parse("2026-01-10T00:00:00Z");
  const push = (lane: string, body: Record<string, unknown>) => {
    seqs[lane] = (seqs[lane] ?? 0) + 1;
    t += 1000;
    events.push({
      seq: seqs[lane],
      ts: new Date(t).toISOString().replace(".000Z", "Z"),
      lane,
      by: "agent",
      ...body,
    });
  };
  const lanes = ["lane-a", "lane-b", "lane-c", "lane-d", "lane-e", "lane-f"];
  push("lead", {
    type: "lane.registered",
    laneId: "lead",
    name: "Lead",
    machine: "mac",
    kind: "lead",
    active: true,
  });
  lanes.forEach((l) =>
    push("lead", {
      type: "lane.registered",
      laneId: l,
      name: l,
      machine: "mac",
      kind: "feature",
      active: true,
    }),
  );
  for (let n = 1; n <= 30; n++) {
    push("lead", { type: "task.created", id: `RF-${n}`, title: `acme task ${n}`, kind: "feature" });
  }
  push("lead", { type: "release.created", id: "R1", name: "One", shipDate: "2026-02-01" });
  const laneEvents = lanes.map((lane, li) => {
    const out: Record<string, unknown>[] = [];
    for (let j = 0; j < 5; j++) {
      const id = `RF-${li * 5 + j + 1}`;
      out.push({ type: "task.started", task: id });
      for (let k = 0; k < 138; k++) {
        out.push({ type: "task.progress", task: id, phase: "phase1" });
        out.push({ type: "task.progress", task: id, phase: "phase2" });
        out.push({ type: "task.blocked", task: id, reason: "waiting on review of the change set" });
        out.push({ type: "task.unblocked", task: id });
      }
      out.push({ type: "task.done", task: id, pr: 100 + li * 5 + j });
    }
    return out;
  });
  const longest = Math.max(...laneEvents.map((l) => l.length));
  for (let i = 0; i < longest; i++)
    lanes.forEach((lane, li) => laneEvents[li][i] && push(lane, laneEvents[li][i]));
  const files: Record<string, string> = { "README.md": "seed\n" };
  for (const [lane, evs] of Object.entries(byLane(events)))
    files[`events/${lane}.jsonl`] = evs.map(jl).join("");
  return { files, events };
}

let world: World;
beforeEach(() => {
  world = makeWorld();
});
afterEach(() => world.cleanup());

describe("B2 a realistic mixed 2 MB history compacts to a small tip and resumes exactly", () => {
  it("fixture is >= 2 MiB, valid, every line <= 1024 B and every lane file < 1 MiB", () => {
    const { files, events } = bigMixed();
    const total = Object.values(files).reduce((a, t) => a + Buffer.byteLength(t), 0);
    expect(total).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    for (const [f, text] of Object.entries(files)) {
      expect(Buffer.byteLength(text)).toBeLessThan(1024 * 1024);
      for (const l of text.split("\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(1024);
      void f;
    }
    const evFiles = Object.entries(files)
      .filter(([f]) => f.startsWith("events/"))
      .map(([f, text]) => ({ file: path.basename(f), text }));
    expect(VAL.validateEvents(evFiles, { releaseIds: [], taskIds: [] })).toEqual([]);
    expect(events.length).toBeGreaterThan(15_000);
  });

  it(
    "compacted tip <= 512 KB; foldDir (resume path) == fold(all); a later append continues the seq",
    async () => {
      const { files, events } = bigMixed();
      world.seedBranch(STATE_BRANCH, files);
      const env = world.env("srv");
      const expected = FD.fold({ tasks: [], releases: [] }, byLane(events), null, null, NOW);
      await CP.compact(env);
      const snap = JSON.parse(world.remoteFile("snapshot.json"));
      expect(snap.v).toBe(2);
      expect(snap.acc).toBeTruthy();
      const shallow = world.shallowClone(STATE_BRANCH, "shallow");
      let bytes = 0;
      const walk = (d: string) => {
        const fs = require("fs");
        for (const n of fs.readdirSync(d)) {
          if (n === ".git") continue;
          const p = path.join(d, n);
          fs.statSync(p).isDirectory() ? walk(p) : (bytes += fs.statSync(p).size);
        }
      };
      walk(shallow);
      expect(bytes / 1024).toBeLessThanOrEqual(512);
      expect(SB.foldDir(shallow, { tasks: [], releases: [] }, NOW)).toEqual(expected);
      const ev = await SB.appendAndPush(env, "lane-a", {
        type: "lane.note",
        by: "agent",
        note: "after",
      });
      const lastA = events.filter((e) => e.lane === "lane-a").length;
      expect(ev.seq).toBe(lastA + 1);
      void git;
    },
    scaled(120_000),
  );
});

describe("B3 validateEvents(files, ctx, resume)", () => {
  const lead = [
    {
      seq: 1,
      ts: "2026-01-09T08:00:00Z",
      lane: "lead",
      type: "lane.registered",
      by: "agent",
      laneId: "lead",
      name: "L",
      machine: "m",
      kind: "lead",
      active: true,
    },
    {
      seq: 2,
      ts: "2026-01-09T08:00:01Z",
      lane: "lead",
      type: "lane.registered",
      by: "agent",
      laneId: "lane-u",
      name: "U",
      machine: "m",
      kind: "feature",
      active: true,
    },
    {
      seq: 3,
      ts: "2026-01-09T08:00:02Z",
      lane: "lead",
      type: "task.created",
      by: "agent",
      id: "RF-1",
      title: "acme one",
      kind: "feature",
    },
  ];
  const u = (seq: number, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      seq,
      ts,
      lane: "lane-u",
      type: "task.started",
      by: "agent",
      task: "RF-1",
      ...extra,
    });
  const ctx = { tasks: [], releaseIds: [] };
  const acc = FD.foldEvents(
    null,
    { tasks: [], releases: [] },
    byLane([
      ...lead,
      ...[1, 2, 3, 4, 5].map((s) => ({
        seq: s,
        ts: `2026-01-10T09:0${s}:00Z`,
        lane: "lane-u",
        type: "lane.note",
        by: "agent",
        note: "n",
      })),
    ]),
  );
  const header = (from: number) => JSON.stringify({ seq: 0, type: "segment", from });

  it("accepts a live segment whose header continues the lane (from == last seq + 1)", () => {
    const files = [
      { file: "lane-u.jsonl", text: header(6) + "\n" + u(6, "2026-01-10T10:00:00Z") + "\n" },
    ];
    expect(VAL.validateEvents(files, ctx, acc)).toEqual([]);
  });

  it("reports a header whose `from` is not last seq + 1", () => {
    const files = [
      { file: "lane-u.jsonl", text: header(9) + "\n" + u(9, "2026-01-10T10:00:00Z") + "\n" },
    ];
    const errs = VAL.validateEvents(files, ctx, acc);
    expect(errs.map((e: any) => e.reason).join("|")).toMatch(/segment header/);
    expect(errs[0]).toMatchObject({ file: "lane-u.jsonl", line: 1 });
  });

  it("works with exactly the documented minimal resume shape", () => {
    const minimal = {
      lastByLane: { "lane-u": { seq: 5, ts: "2026-01-10T09:05:00Z" } },
      mintedIds: [],
      tracks: {},
    };
    const files = [{ file: "lane-u.jsonl", text: header(9) + "\n" }];
    const errs = VAL.validateEvents(files, ctx, minimal);
    expect(errs.map((e: any) => e.reason).join("|")).toMatch(/segment header/);
  });

  it("reports a live event older than the snapshot's newest event (total order would break)", () => {
    const files = [
      { file: "lane-u.jsonl", text: header(6) + "\n" + u(6, "2026-01-09T10:00:00Z") + "\n" },
    ];
    const errs = VAL.validateEvents(files, ctx, acc);
    expect(errs.map((e: any) => e.reason).join("|")).toMatch(/ts/);
  });

  it("resume carries minted ids: re-minting RF-1 after the cut is a duplicate", () => {
    const leadLive = JSON.stringify({
      seq: 4,
      ts: "2026-01-10T10:00:00Z",
      lane: "lead",
      type: "task.created",
      by: "agent",
      id: "RF-1",
      title: "acme dup",
      kind: "feature",
    });
    const files = [{ file: "lead.jsonl", text: header(4) + "\n" + leadLive + "\n" }];
    const errs = VAL.validateEvents(files, ctx, acc);
    expect(errs.map((e: any) => e.reason).join("|")).toMatch(/duplicate mint RF-1/);
  });

  it("resume carries task tracks: starting a task the snapshot already finished is illegal", () => {
    const evs = [
      ...lead,
      {
        seq: 1,
        ts: "2026-01-10T09:00:00Z",
        lane: "lane-u",
        type: "task.started",
        by: "agent",
        task: "RF-1",
      },
      {
        seq: 2,
        ts: "2026-01-10T09:01:00Z",
        lane: "lane-u",
        type: "task.done",
        by: "agent",
        task: "RF-1",
      },
    ];
    const a2 = FD.foldEvents(null, { tasks: [], releases: [] }, byLane(evs));
    const files = [
      { file: "lane-u.jsonl", text: header(3) + "\n" + u(3, "2026-01-10T10:00:00Z") + "\n" },
    ];
    // code-complete -> started is not in the matrix
    expect(
      VAL.validateEvents(files, ctx, a2)
        .map((e: any) => e.reason)
        .join("|"),
    ).toMatch(/illegal transition/);
  });
});
