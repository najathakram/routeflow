/**
 * T8, T9 (R4, R5) — `fold` and `eventOrder` (src/domain/fold.ts).
 *
 * Contract under test:
 *   fold(base, eventsByLane, github, railway, now) -> state        (spec §4; github/railway = null here)
 *     base = { tasks: BaseTask[], releases: {id,name,shipDate,status}[] }  (already adapted registers)
 *     BaseTask = {id,title,kind,status,priority,release,areas,dependsOn,related,lane,phase}
 *     eventsByLane = Record<laneId, Event[]>
 *   state.tasks: Record<id, task>; status/priority/release/lane/phase are {value, source, ref}
 *     source "register" | "reported" | "inferred"; ref "<lane>#<seq>" for reported values
 *   state.lanes: Record<id, {id,name,machine,kind,active,current: {value: taskId|null, source, ref}}> (next likewise)
 *   state.warnings: {lane, seq, reason}[]; state.version = sha256 hex of the canonical JSON
 *   eventOrder(a, b): ts, then sync|server|infer after the rest, then lane, then seq
 */
import * as fs from "fs";
import * as path from "path";
import { NOW, pinClock } from "./helpers/clock";

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const mod = tryRequire(() => require("../src/domain/fold"));
const need = () => {
  expect(mod).toBeDefined();
  expect(typeof mod.fold).toBe("function");
  expect(typeof mod.eventOrder).toBe("function");
  return mod as {
    fold: (b: any, e: any, g: any, r: any, now: string) => any;
    eventOrder: (a: any, b: any) => number;
  };
};

let restore: () => void;
beforeAll(() => {
  restore = pinClock();
});
afterAll(() => restore());

const FIX = path.join(__dirname, "fixtures", "acme");
const jsonl = (p: string): any[] =>
  fs
    .readFileSync(path.join(FIX, p), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const baseTask = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `acme ${id}`,
  kind: "feature",
  status: "planned",
  priority: "P2",
  release: null,
  areas: [],
  dependsOn: [],
  related: [],
  lane: null,
  phase: null,
  ...over,
});

function fixtureBase() {
  const rows = [
    ...jsonl("registers/features.jsonl"),
    ...jsonl("registers/bugs.jsonl"),
    ...jsonl("registers/deferred.jsonl"),
  ];
  return {
    tasks: rows.map((r) => baseTask(r.id, { release: r.id === "F-01" ? "R1" : null })),
    releases: jsonl("registers/releases.jsonl").map((r) => ({
      id: r.id,
      name: r.name,
      shipDate: r.shipDate,
      status: r.status,
    })),
  };
}
function fixtureEvents(): Record<string, any[]> {
  const dir = path.join(FIX, "state", "events");
  const out: Record<string, any[]> = {};
  for (const n of fs.readdirSync(dir).sort()) {
    out[n.replace(/\.jsonl$/, "")] = jsonl(path.join("state", "events", n));
  }
  return out;
}

const ev = (lane: string, seq: number, ts: string, type: string, extra = {}, by = "agent") => ({
  seq,
  ts,
  lane,
  type,
  by,
  ...extra,
});
const T = (hhmm: string) => `2026-01-10T${hhmm}:00Z`;
const small = () => ({ tasks: [baseTask("F-01"), baseTask("F-02")], releases: [] });

describe("fold over the acme fixture (T8)", () => {
  it("folds to the hand-derived state with no warnings", () => {
    const { fold } = need();
    const s = fold(fixtureBase(), fixtureEvents(), null, null, NOW);
    expect(s.warnings).toEqual([]);
    const t = s.tasks;
    // RF-1: created planned, started, done
    expect(t["RF-1"].status).toMatchObject({ value: "code-complete", source: "reported" });
    expect(t["RF-1"].phase.value).toBe("phase1");
    // RF-2: started, blocked, unblocked -> back to in-progress (prior)
    expect(t["RF-2"].status.value).toBe("in-progress");
    // RF-3: started by lane-u, owner priority override P3 -> P0
    expect(t["RF-3"].status.value).toBe("in-progress");
    expect(t["RF-3"].priority).toEqual({ value: "P0", source: "reported", ref: "owner#1" });
    // F-01: owner release override R1 -> R3; F-02 blocked by r-ui
    expect(t["F-01"].release).toEqual({ value: "R3", source: "reported", ref: "owner#2" });
    expect(t["F-02"].status.value).toBe("blocked");
    // untouched register row keeps its register provenance
    expect(t["F-03"].status.value).toBe("planned");
    expect(t["F-03"].status.source).toBe("register");
    // proposed alias task
    expect(t["r-ui.1"].status.value).toBe("proposed");
    // lanes
    expect(s.lanes["lane-u"]).toMatchObject({
      id: "lane-u",
      kind: "feature",
      current: { value: "RF-3", source: "reported", ref: "lane-u#4" },
    });
    expect(s.lanes["lane-b"].current).toEqual({
      value: "RF-2",
      source: "reported",
      ref: "lane-b#1",
    });
    expect(Object.keys(s.lanes).sort()).toEqual(["lane-b", "lane-u", "lead", "owner", "r-ui"]);
    expect(s.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is byte-identical across 50 shuffles of file order and of lines (same inputs, same state)", () => {
    const { fold } = need();
    const base = fixtureBase();
    const baseline = fold(base, fixtureEvents(), null, null, NOW);
    let seed = 20260112;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0; // mulberry32
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const shuffle = <A>(a: A[]): A[] => {
      const b = [...a];
      for (let i = b.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [b[i], b[j]] = [b[j], b[i]];
      }
      return b;
    };
    for (let i = 0; i < 50; i++) {
      const src = fixtureEvents();
      const shuffled: Record<string, any[]> = {};
      for (const lane of shuffle(Object.keys(src))) shuffled[lane] = shuffle(src[lane]);
      const s = fold(base, shuffled, null, null, NOW);
      expect(s.version).toBe(baseline.version);
      expect(JSON.stringify(s)).toBe(JSON.stringify(baseline));
    }
  });

  it("version changes when an event is added", () => {
    const { fold } = need();
    const a = fold(fixtureBase(), fixtureEvents(), null, null, NOW);
    const more = fixtureEvents();
    more["lane-b"].push(ev("lane-b", 5, T("11:30"), "lane.note", { note: "more" }));
    const b = fold(fixtureBase(), more, null, null, NOW);
    expect(b.version).not.toBe(a.version);
  });
});

describe("eventOrder (spec §4 total order)", () => {
  const e = (ts: string, by: string, lane: string, seq: number) =>
    ev(lane, seq, ts, "lane.note", { note: "n" }, by);

  it("orders by ts first", () => {
    const { eventOrder } = need();
    expect(
      eventOrder(e(T("09:00"), "sync", "zz", 9), e(T("09:01"), "agent", "aa", 1)),
    ).toBeLessThan(0);
    expect(
      eventOrder(e(T("09:01"), "agent", "aa", 1), e(T("09:00"), "sync", "zz", 9)),
    ).toBeGreaterThan(0);
  });

  it("at equal ts, sync|server|infer sort after agent|owner|ctl regardless of lane", () => {
    const { eventOrder } = need();
    for (const late of ["sync", "server", "infer"]) {
      expect(
        eventOrder(e(T("09:00"), late, "aaa", 1), e(T("09:00"), "agent", "zzz", 1)),
      ).toBeGreaterThan(0);
      expect(
        eventOrder(e(T("09:00"), "agent", "zzz", 1), e(T("09:00"), late, "aaa", 1)),
      ).toBeLessThan(0);
    }
    expect(
      eventOrder(e(T("09:00"), "owner", "zzz", 1), e(T("09:00"), "agent", "aaa", 1)),
    ).toBeGreaterThan(0);
    expect(
      eventOrder(e(T("09:00"), "ctl", "aaa", 1), e(T("09:00"), "owner", "zzz", 1)),
    ).toBeLessThan(0);
  });

  it("then lane, then seq", () => {
    const { eventOrder } = need();
    expect(
      eventOrder(e(T("09:00"), "agent", "lane-b", 9), e(T("09:00"), "agent", "lane-u", 1)),
    ).toBeLessThan(0);
    expect(
      eventOrder(e(T("09:00"), "agent", "lane-u", 2), e(T("09:00"), "agent", "lane-u", 3)),
    ).toBeLessThan(0);
    expect(
      eventOrder(e(T("09:00"), "agent", "lane-u", 3), e(T("09:00"), "agent", "lane-u", 3)),
    ).toBe(0);
  });
});

describe("fold warnings (T9 and transitions in history)", () => {
  it("T9: an event targeting unknown RF-999 -> warning {lane, seq, reason}; task map unchanged", () => {
    const { fold } = need();
    const events = {
      "lane-u": [
        ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" }),
        ev("lane-u", 2, T("09:05"), "task.progress", { task: "F-01", phase: "phase1" }),
        ev("lane-u", 3, T("09:10"), "task.started", { task: "RF-999" }),
      ],
    };
    const clean = fold(small(), { "lane-u": events["lane-u"].slice(0, 2) }, null, null, NOW);
    const s = fold(small(), events, null, null, NOW);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatchObject({ lane: "lane-u", seq: 3 });
    expect(s.warnings[0].reason).toMatch(/unknown task/);
    expect(Object.keys(s.tasks)).toEqual(Object.keys(clean.tasks));
    expect(s.tasks["RF-999"]).toBeUndefined();
    expect(s.tasks["F-01"].status.value).toBe("in-progress");
  });

  it("an illegal transition in history warns and leaves the status unchanged", () => {
    const { fold } = need();
    const s = fold(
      small(),
      { "lane-u": [ev("lane-u", 1, T("09:00"), "task.done", { task: "F-01" })] },
      null,
      null,
      NOW,
    );
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatchObject({ lane: "lane-u", seq: 1 });
    expect(s.warnings[0].reason).toMatch(/illegal transition planned→done/);
    expect(s.tasks["F-01"].status).toMatchObject({ value: "planned", source: "register" });
  });

  it("released from planned is legal only for sync|server|infer, never for an agent", () => {
    const { fold } = need();
    const agent = fold(
      small(),
      {
        "lane-u": [
          ev("lane-u", 1, T("09:00"), "task.released", {
            task: "F-01",
            release: "R1",
            sha: "abc1234",
          }),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(agent.warnings).toHaveLength(1);
    expect(agent.warnings[0].reason).toMatch(/illegal transition planned→released/);
    expect(agent.tasks["F-01"].status.value).toBe("planned");

    for (const by of ["sync", "server"]) {
      const s = fold(
        small(),
        {
          ctl: [
            ev(
              "ctl",
              1,
              T("09:00"),
              "task.released",
              { task: "F-01", release: "R1", sha: "abc1234" },
              by,
            ),
          ],
        },
        null,
        null,
        NOW,
      );
      expect(s.warnings).toEqual([]);
      expect(s.tasks["F-01"].status.value).toBe("released");
    }
  });

  it("equal ts: an agent start applies before a sync release even when the sync lane sorts first", () => {
    const { fold } = need();
    const s = fold(
      small(),
      {
        aaa: [
          ev(
            "aaa",
            1,
            T("09:00"),
            "task.released",
            { task: "F-01", release: "R1", sha: "abc1234" },
            "sync",
          ),
        ],
        "lane-u": [ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" })],
      },
      null,
      null,
      NOW,
    );
    expect(s.warnings).toEqual([]);
    expect(s.tasks["F-01"].status.value).toBe("released");
  });
});

describe("fold effects (spec §1.3)", () => {
  it("blocked then unblocked restores the prior status", () => {
    const { fold } = need();
    const fromProgress = fold(
      small(),
      {
        "lane-u": [
          ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" }),
          ev("lane-u", 2, T("09:01"), "task.blocked", { task: "F-01", reason: "waiting" }),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(fromProgress.tasks["F-01"].status.value).toBe("blocked");
    const restored = fold(
      small(),
      {
        "lane-u": [
          ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" }),
          ev("lane-u", 2, T("09:01"), "task.blocked", { task: "F-01", reason: "waiting" }),
          ev("lane-u", 3, T("09:02"), "task.unblocked", { task: "F-01" }),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(restored.tasks["F-01"].status.value).toBe("in-progress");
    const fromPlanned = fold(
      small(),
      {
        "lane-u": [
          ev("lane-u", 1, T("09:01"), "task.blocked", { task: "F-01", reason: "waiting" }),
          ev("lane-u", 2, T("09:02"), "task.unblocked", { task: "F-01" }),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(fromPlanned.tasks["F-01"].status.value).toBe("planned");
  });

  it("task.created mints a planned RF task with reported provenance", () => {
    const { fold } = need();
    const s = fold(
      small(),
      {
        lead: [
          ev("lead", 1, T("08:00"), "task.created", {
            id: "RF-7",
            title: "acme: minted",
            kind: "chore",
            priority: "P1",
          }),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(s.warnings).toEqual([]);
    expect(s.tasks["RF-7"].status).toMatchObject({
      value: "planned",
      source: "reported",
      ref: "lead#1",
    });
    expect(s.tasks["RF-7"].priority).toEqual({ value: "P1", source: "reported", ref: "lead#1" });
    expect(s.tasks["RF-7"].title).toBe("acme: minted");
  });

  it("started sets the lane's current task; done clears it", () => {
    const { fold } = need();
    const started = fold(
      small(),
      { "lane-u": [ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" })] },
      null,
      null,
      NOW,
    );
    expect(started.lanes["lane-u"].current).toEqual({
      value: "F-01",
      source: "reported",
      ref: "lane-u#1",
    });
    const done = fold(
      small(),
      {
        "lane-u": [
          ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" }),
          ev("lane-u", 2, T("09:10"), "task.done", { task: "F-01", pr: 2801 }),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(done.lanes["lane-u"].current).toEqual({
      value: null,
      source: "reported",
      ref: "lane-u#2",
    });
    expect(done.tasks["F-01"].status.value).toBe("code-complete");
  });

  it("reopened returns a code-complete task to planned", () => {
    const { fold } = need();
    const s = fold(
      small(),
      {
        "lane-u": [
          ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" }),
          ev("lane-u", 2, T("09:10"), "task.done", { task: "F-01" }),
          ev("lane-u", 3, T("09:20"), "task.reopened", { task: "F-01", reason: "regressed" }),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(s.tasks["F-01"].status.value).toBe("planned");
    expect(s.warnings).toEqual([]);
  });
});
