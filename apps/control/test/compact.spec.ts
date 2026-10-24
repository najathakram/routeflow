/**
 * T55 (R26, R32) — compaction of the state branch.
 *
 * Contract (src/sources/compact.ts): compact(env) -> Promise<unknown>; operates on env.cloneDir
 * (cloning if needed), writes snapshot.json at the tip, pushes the archived segments to
 * env.archiveBranch (`archive/<lane>/<from>-<to>.jsonl`), restarts each lane segment with the header
 * line {"seq":0,"type":"segment","from":<first seq kept>}, and pushes env.stateBranch.
 * state-branch exports foldDir(dir, registers) = fold(snapshot + segments) for a checkout.
 */
import * as fs from "fs";
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

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const CP = tryRequire(() => require("../src/sources/compact"));
const SB = tryRequire(() => require("../src/sources/state-branch"));
const FD = tryRequire(() => require("../src/domain/fold"));
const need = (m: any, name: string) => {
  if (!m) throw new Error(`${name} does not exist yet`);
  return m;
};

const REGISTERS = { tasks: [], releases: [] };
const LANES = ["lane-u", "lane-v"];

/** ~2.1 MB of VALID events: lead registry + 2 lanes x 1150 notes of ~900 B each. */
function bigState(): { files: Record<string, string>; byLane: Record<string, any[]> } {
  const files = baseState(0);
  const byLane: Record<string, any[]> = {};
  byLane.lead = files["events/lead.jsonl"]
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const lane of LANES) {
    const evs: any[] = [
      { seq: 1, ts: "2026-01-10T08:00:00Z", lane, type: "task.started", by: "agent", task: "RF-1" },
    ];
    for (let i = 2; i <= 1150; i++) {
      evs.push({
        seq: i,
        ts: new Date(Date.parse("2026-01-10T08:00:00Z") + i * 1000)
          .toISOString()
          .replace(".000Z", "Z"),
        lane,
        type: "lane.note",
        by: "agent",
        note: `n${i}-`.padEnd(i % 4 === 0 ? 815 : 814, "x"),
      });
    }
    byLane[lane] = evs;
    files[`events/${lane}.jsonl`] = evs.map(jl).join("");
  }
  return { files, byLane };
}

const kb = (dir: string): number => {
  let total = 0;
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d)) {
      if (n === ".git") continue;
      const p = path.join(d, n);
      const st = fs.statSync(p);
      st.isDirectory() ? walk(p) : (total += st.size);
    }
  };
  walk(dir);
  return total / 1024;
};

let world: World;
beforeEach(() => {
  world = makeWorld();
});
afterEach(() => world.cleanup());

describe("T55 compact", () => {
  it("fixture really is >= 2 MB and every line <= 1024 B", () => {
    const { files } = bigState();
    const total = Object.values(files).reduce((a, t) => a + Buffer.byteLength(t), 0);
    expect(total).toBeGreaterThan(2 * 1024 * 1024);
    for (const t of Object.values(files)) {
      for (const l of t.split("\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(1024);
    }
  });

  it(
    "snapshot + archive + headers; fold(snapshot+segments) deep-equals fold(all); tip <= 512 KB; depth-1 clone <= 1 MB",
    async () => {
      const { files, byLane } = bigState();
      world.seedBranch(STATE_BRANCH, files);
      const env = world.env("srv");
      const fd = need(SB, "state-branch");
      const { fold } = need(FD, "domain/fold");

      // pre-compaction: the clone folds to exactly what folding the raw events gives
      await fd.appendAndPush(env, "lane-u", { type: "lane.note", by: "agent", note: "pre" }); // seeds the clone
      const preEvents: Record<string, any[]> = {};
      for (const lane of ["lead", ...LANES]) {
        preEvents[lane] = fs
          .readFileSync(path.join(env.cloneDir, "events", `${lane}.jsonl`), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      }
      expect(preEvents["lane-u"]).toHaveLength(byLane["lane-u"].length + 1);
      const expected = fold(REGISTERS, preEvents, null, null, NOW);
      const lastSeq = Object.fromEntries(
        Object.entries(preEvents).map(([l, e]) => [l, e[e.length - 1].seq]),
      );

      await need(CP, "compact").compact(env);

      // snapshot.json at the tip of ctl/state
      const snap = JSON.parse(world.remoteFile("snapshot.json"));
      expect(snap).toBeTruthy();
      expect(snap.seqByLane).toMatchObject(lastSeq);

      // segments moved to the archive branch, byte-identical, named <from>-<to>
      expect(world.remoteHas(ARCHIVE_BRANCH)).toBe(true);
      for (const lane of ["lead", ...LANES]) {
        const to = lastSeq[lane];
        const archived = world.remoteFile(`archive/${lane}/1-${to}.jsonl`, ARCHIVE_BRANCH);
        expect(archived).toBe(preEvents[lane].map(jl).join(""));
      }
      // ...and no longer on the tip; new segments start with the header
      const tree = git(world.originDir, ["ls-tree", "-r", "--name-only", STATE_BRANCH]).split("\n");
      expect(tree.filter((p) => p.startsWith("archive/"))).toEqual([]);
      for (const lane of LANES) {
        const first = world.remoteFile(`events/${lane}.jsonl`).split("\n")[0];
        expect(JSON.parse(first)).toEqual({ seq: 0, type: "segment", from: lastSeq[lane] + 1 });
      }

      // R26: fold(snapshot + segments) == fold(all events)
      const after = fd.foldDir(env.cloneDir, REGISTERS);
      // (clone must be at the pushed tip)
      expect(git(env.cloneDir, ["rev-parse", "HEAD"]).trim()).toBe(world.remoteHead());
      expect(after).toEqual(expected);

      // R32: tip tree <= 512 KB, depth-1 clone transfers <= 1 MB
      const shallow = world.shallowClone(STATE_BRANCH, "shallow");
      expect(kb(shallow)).toBeLessThanOrEqual(512);
      const cnt = git(shallow, ["count-objects", "-v"]);
      const num = (k: string) => Number(new RegExp(`^${k}: (\\d+)`, "m").exec(cnt)![1]);
      expect(num("size") + num("size-pack")).toBeLessThanOrEqual(1024);

      // a fresh clone of the compacted branch folds to the same state too
      expect(fd.foldDir(shallow, REGISTERS)).toEqual(expected);
    },
    scaled(20_000),
  );

  it(
    "seq continues across compaction: next append on a compacted lane is last+1, headers skipped",
    async () => {
      const { files } = bigState();
      world.seedBranch(STATE_BRANCH, files);
      const env = world.env("srv");
      await need(CP, "compact").compact(env);
      const ev = await need(SB, "state-branch").appendAndPush(env, "lane-u", {
        type: "lane.note",
        by: "agent",
        note: "after",
      });
      expect(ev.seq).toBe(1151);
      const lines = world
        .remoteFile("events/lane-u.jsonl")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(lines.map((l) => l.seq)).toEqual([0, 1151]);
      expect(lines[1].note).toBe("after");
      // a lane with no new events since compaction still appends correctly from a header-only file
      const ev2 = await SB.appendAndPush(env, "lane-v", {
        type: "lane.note",
        by: "agent",
        note: "v",
      });
      expect(ev2.seq).toBe(1151);
    },
    scaled(20_000),
  );

  it(
    "a second compaction keeps the equivalence and archives only the new segment",
    async () => {
      const { files } = bigState();
      world.seedBranch(STATE_BRANCH, files);
      const env = world.env("srv");
      const { fold } = need(FD, "domain/fold");
      await need(CP, "compact").compact(env);
      await SB.appendAndPush(env, "lane-u", { type: "lane.note", by: "agent", note: "a" });
      await SB.appendAndPush(env, "lane-u", { type: "lane.note", by: "agent", note: "b" });
      const allLane: Record<string, any[]> = {};
      const archive1 = (lane: string) =>
        world.remoteFile(`archive/${lane}/1-${lane === "lead" ? 4 : 1150}.jsonl`, ARCHIVE_BRANCH);
      for (const lane of ["lead", ...LANES]) {
        allLane[lane] = archive1(lane)
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      }
      const live = world.remoteLines("lane-u").filter((l) => l.seq > 0);
      allLane["lane-u"] = [...allLane["lane-u"], ...live];
      const expected = fold(REGISTERS, allLane, null, null, NOW);
      await CP.compact(env);
      expect(world.remoteFile("archive/lane-u/1151-1152.jsonl", ARCHIVE_BRANCH)).not.toBe("");
      expect(world.remoteFile("archive/lane-u/1-1150.jsonl", ARCHIVE_BRANCH)).not.toBe(""); // never rewritten
      expect(SB.foldDir(env.cloneDir, REGISTERS)).toEqual(expected);
    },
    scaled(20_000),
  );
});

describe("R32 compacted tip with a full nonce window", () => {
  it(
    "200 appends/day: 7 days of nonces + 30 days of old rows + a 384 KB events trigger -> tip <= 512 KB",
    async () => {
      const files = baseState(0);
      const evs: any[] = [
        {
          seq: 1,
          ts: "2026-01-10T08:00:00Z",
          lane: "lane-u",
          type: "task.started",
          by: "agent",
          task: "RF-1",
        },
      ];
      for (let i = 2; i <= 400; i++) {
        evs.push({
          seq: i,
          ts: new Date(Date.parse("2026-01-10T08:00:00Z") + i * 1000)
            .toISOString()
            .replace(".000Z", "Z"),
          lane: "lane-u",
          type: "lane.note",
          by: "agent",
          note: `n${i}-`.padEnd(930, "x"),
        });
      }
      files["events/lane-u.jsonl"] = evs.map(jl).join("");
      expect(Buffer.byteLength(files["events/lane-u.jsonl"])).toBeGreaterThanOrEqual(384 * 1024);
      const rows: string[] = [];
      for (let n = 0; n < 200 * 37; n++) {
        const ts = new Date(Date.parse(NOW) - Math.floor((n * 86_400_000) / 200))
          .toISOString()
          .replace(".000Z", "Z");
        rows.push(`${n.toString(16).padStart(16, "0")} ${ts}`);
      }
      files["nonces.txt"] = rows.join("\n") + "\n";
      world.seedBranch(STATE_BRANCH, files);
      const env = world.env("srv");
      await need(CP, "compact").compact(env);
      const shallow = world.shallowClone(STATE_BRANCH, "shallow");
      expect(kb(shallow)).toBeLessThanOrEqual(512);
      const kept = fs
        .readFileSync(path.join(shallow, "nonces.txt"), "utf8")
        .split("\n")
        .filter(Boolean);
      expect(kept.length).toBeLessThanOrEqual(200 * 7 + 1);
      const oldest = Math.min(...kept.map((r) => Date.parse(r.split(" ")[1])));
      expect(oldest).toBeGreaterThanOrEqual(Date.parse(NOW) - 7 * 86_400_000);
    },
    scaled(30_000),
  );
});

describe("R32b snapshot size with many tasks, and the whole-tip compaction trigger", () => {
  /** lead creates 600 RF tasks; one lane starts and progresses each; notes pad events/ to >= 384 KB. */
  function manyTasks(count = 600): Record<string, string> {
    const files = baseState(0);
    const lead = files["events/lead.jsonl"]
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    let t = Date.parse("2026-01-10T00:00:00Z");
    const ts = () => new Date((t += 1000)).toISOString().replace(".000Z", "Z");
    let seq = lead.length;
    lead.push({
      seq: ++seq,
      ts: ts(),
      lane: "lead",
      type: "release.created",
      by: "agent",
      id: "R1",
      name: "One",
      shipDate: "2026-02-01",
    });
    for (let n = 2; n <= count; n++) {
      lead.push({
        seq: ++seq,
        ts: ts(),
        lane: "lead",
        type: "task.created",
        by: "agent",
        id: `RF-${n}`,
        title: `acme task ${n}: a realistic title of about sixty characters long`,
        kind: "feature",
        priority: "P1",
        release: "R1",
        areas: ["apps/web/src/app/(dashboard)/orders/**", "apps/api/src/orders/**"],
        effort: "L",
        importance: 4,
        customerImpact: "high",
        dependsOn: ["RF-1"],
        related: ["B12", "F-3"],
        ref: { feature: "F-12" },
        notes: "kept short but present on every row, as real registers do",
      });
    }
    files["events/lead.jsonl"] = lead.map(jl).join("");
    const u: any[] = [];
    let us = 0;
    for (let n = 1; n <= count; n++) {
      u.push({
        seq: ++us,
        ts: ts(),
        lane: "lane-u",
        type: "task.started",
        by: "agent",
        task: `RF-${n}`,
      });
      u.push({
        seq: ++us,
        ts: ts(),
        lane: "lane-u",
        type: "task.progress",
        by: "agent",
        task: `RF-${n}`,
        phase: "phase1",
      });
    }
    while (u.map(jl).join("").length + files["events/lead.jsonl"].length < 400 * 1024) {
      u.push({
        seq: ++us,
        ts: ts(),
        lane: "lane-u",
        type: "lane.note",
        by: "agent",
        note: "n".padEnd(900, "x"),
      });
    }
    files["events/lane-u.jsonl"] = u.map(jl).join("");
    return files;
  }

  it(
    "600 tasks at the trigger: compacted tip (events + snapshot + nonces) <= 512 KB and fold is unchanged",
    async () => {
      const files = manyTasks();
      world.seedBranch(STATE_BRANCH, files);
      const env = world.env("srv");
      const all: Record<string, any[]> = {};
      for (const lane of ["lead", "lane-u"]) {
        all[lane] = files[`events/${lane}.jsonl`]
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      }
      const { fold } = need(FD, "domain/fold");
      const expected = fold(REGISTERS, all, null, null, NOW);
      await need(CP, "compact").compact(env);
      const shallow = world.shallowClone(STATE_BRANCH, "shallow");
      expect(kb(shallow)).toBeLessThanOrEqual(512);
      expect(need(SB, "state-branch").foldDir(shallow, REGISTERS, NOW)).toEqual(expected);
    },
    scaled(30_000),
  );

  it("compactDue triggers on events/ bytes ONLY (a fat snapshot or nonces.txt never re-triggers)", () => {
    const { compactDue, tipBytes } = need(CP, "compact");
    const dir = fs.mkdtempSync(path.join(world.root, "tip-"));
    fs.mkdirSync(path.join(dir, "events"));
    fs.writeFileSync(path.join(dir, "events", "lane-u.jsonl"), "x".repeat(100 * 1024));
    expect(compactDue(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, "snapshot.json"), "x".repeat(600 * 1024));
    fs.writeFileSync(path.join(dir, "nonces.txt"), "x".repeat(100 * 1024));
    expect(compactDue(dir)).toBe(false);
    expect(tipBytes(dir)).toBe((100 + 600 + 100) * 1024); // still reported as a metric
    fs.writeFileSync(path.join(dir, "events", "lane-v.jsonl"), "x".repeat(300 * 1024));
    expect(compactDue(dir)).toBe(true);
  });

  it("snapshotWarning fires only above 1 MB", () => {
    const { snapshotWarning } = need(CP, "compact");
    const dir = fs.mkdtempSync(path.join(world.root, "snap-"));
    expect(snapshotWarning(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "snapshot.json"), "x".repeat(1024 * 1024));
    expect(snapshotWarning(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "snapshot.json"), "x".repeat(1024 * 1024 + 1));
    expect(String(snapshotWarning(dir))).toMatch(/snapshot\.json/);
  });

  it(
    "300 tasks: compacted tip <= 512 KB",
    async () => {
      world.seedBranch(STATE_BRANCH, manyTasks(300));
      const env = world.env("srv");
      await need(CP, "compact").compact(env);
      expect(kb(world.shallowClone(STATE_BRANCH, "shallow300"))).toBeLessThanOrEqual(512);
    },
    scaled(30_000),
  );

  it(
    "1,000 tasks: no compaction loop (compactDue false right after compact), no snapshot warning",
    async () => {
      world.seedBranch(STATE_BRANCH, manyTasks(1000));
      const env = world.env("srv");
      const { compact, compactDue } = need(CP, "compact");
      expect(compactDue(world.shallowClone(STATE_BRANCH, "before"))).toBe(true);
      const r = await compact(env);
      expect(r.compacted).toBe(true);
      expect(r.snapshotWarning).toBeNull();
      const after = world.shallowClone(STATE_BRANCH, "after");
      expect(compactDue(after)).toBe(false);
      expect(fs.statSync(path.join(after, "snapshot.json")).size).toBeLessThan(1024 * 1024);
      const again = await compact(env); // nothing new: no churn
      expect(again.compacted).toBe(false);
    },
    scaled(60_000),
  );
});

/** mulberry32: fixed-seed PRNG, so the property test is reproducible. */
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

/** Valid history: lead registers 3 lanes + RF-1..3, then 60 interleaved lane events (globally ordered). */
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
  const lanes = ["lane-u", "lane-v", "lane-w"];
  lanes.forEach((l) => reg(l, "feature"));
  [1, 2, 3].forEach((n) =>
    push("lead", {
      type: "task.created",
      id: `RF-${n}`,
      title: `acme: task ${n}`,
      kind: "feature",
    }),
  );
  const started = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const idx = Math.floor(rand() * 3);
    const lane = lanes[idx];
    if (!started.has(lane)) {
      started.add(lane);
      push(lane, { type: "task.started", task: `RF-${idx + 1}` });
    } else if (rand() < 0.5) {
      push(lane, {
        type: "task.progress",
        task: `RF-${idx + 1}`,
        phase: rand() < 0.5 ? "phase1" : "phase2",
      });
    } else {
      push(lane, { type: "lane.note", note: `n${i}` });
    }
  }
  return out;
}

describe("T8b/R26 property: compact at a random cut, append the rest, fold equals fold(all)", () => {
  it(
    "20 seeded cut points over >= 60 events in >= 3 lanes",
    async () => {
      const rand = prng(20260930);
      const all = history(rand);
      expect(all.length).toBeGreaterThanOrEqual(60);
      const { fold } = need(FD, "domain/fold");
      const byLane = (evs: any[]) => {
        const m: Record<string, any[]> = {};
        for (const e of evs) (m[e.lane] ??= []).push(e);
        return m;
      };
      const expected = fold(REGISTERS, byLane(all), null, null, NOW);
      const cuts = Array.from({ length: 20 }, () => 1 + Math.floor(rand() * (all.length - 1)));
      for (const cut of cuts) {
        const w = makeWorld();
        try {
          const head = all.slice(0, cut);
          const rest = all.slice(cut);
          const files: Record<string, string> = { "README.md": "seed\n" };
          for (const [lane, evs] of Object.entries(byLane(head))) {
            files[`events/${lane}.jsonl`] = evs.map(jl).join("");
          }
          w.seedBranch(STATE_BRANCH, files);
          const env = w.env("srv");
          await need(CP, "compact").compact(env);
          for (const [lane, evs] of Object.entries(byLane(rest))) {
            const f = path.join(env.cloneDir, "events", `${lane}.jsonl`);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.appendFileSync(f, evs.map(jl).join(""));
          }
          git(env.cloneDir, ["add", "-A"]);
          git(env.cloneDir, ["commit", "-q", "--allow-empty", "-m", `rest after cut ${cut}`]);
          git(env.cloneDir, ["push", "-q", "origin", `HEAD:${STATE_BRANCH}`]);
          const got = need(SB, "state-branch").foldDir(env.cloneDir, REGISTERS);
          expect({ cut, version: got.version }).toEqual({ cut, version: expected.version });
          expect({ cut, state: got }).toEqual({ cut, state: expected });
        } finally {
          w.cleanup();
        }
      }
    },
    scaled(60_000),
  );
});
