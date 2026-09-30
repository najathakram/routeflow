/**
 * WP1 fix round 1 (Opus review) — added tests only; every case below pins one review finding.
 * Modules are `require`d as `any` so a not-yet-extended signature fails on its own assertion.
 */
import * as fs from "fs";
import * as path from "path";
import type { RegisterTask } from "../src/domain/validate";

/* eslint-disable @typescript-eslint/no-explicit-any */
const V: any = require("../src/domain/validate");
const F: any = require("../src/domain/fold");

const FIX = path.join(__dirname, "fixtures", "acme");
type FL = { file: string; text: string };
const readJsonl = (rel: string): any[] =>
  fs
    .readFileSync(path.join(FIX, rel), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const ids = () =>
  [
    ...readJsonl("registers/features.jsonl"),
    ...readJsonl("registers/bugs.jsonl"),
    ...readJsonl("registers/deferred.jsonl"),
  ].map((r) => r.id as string);
const releaseIds = () => readJsonl("registers/releases.jsonl").map((r) => r.id as string);
const ctx = (extra: Record<string, unknown> = {}) => ({
  taskIds: ids(),
  releaseIds: releaseIds(),
  ...extra,
});
const files = (): FL[] => {
  const dir = path.join(FIX, "state", "events");
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .map((n) => ({ file: n, text: fs.readFileSync(path.join(dir, n), "utf8") }));
};
/** Append an explicit raw line (caller sets seq/ts/lane/by) to `name`. */
const raw = (fs_: FL[], name: string, obj: Record<string, unknown>): FL[] =>
  fs_.map((f) => (f.file === name ? { ...f, text: f.text + JSON.stringify(obj) + "\n" } : f));
const line = (
  lane: string,
  seq: number,
  ts: string,
  type: string,
  by: string,
  extra: Record<string, unknown>,
) => ({ seq, ts, lane, type, by, ...extra });
const run = (fl: FL[], c: any): any[] => V.validateEvents(fl, c);

describe("1. envelope type checks (no throw, error with file:line)", () => {
  it.each([
    ["lane", { lane: 5 }, /lane/],
    ["by", { by: 5 }, /by/],
    ["type", { type: 5 }, /type/],
  ])("non-string %s is rejected, never reaches the sort", (_n, over, re) => {
    const fl = raw(files(), "lane-b.jsonl", {
      seq: 5,
      ts: "2026-01-10T10:20:00Z",
      lane: "lane-b",
      type: "lane.note",
      by: "agent",
      note: "x",
      ...over,
    });
    let errors: any[] = [];
    expect(() => {
      errors = run(fl, ctx());
    }).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lane-b.jsonl", line: 5 });
    expect(errors[0].reason).toMatch(re);
  });
});

describe("2. locale-independent order (code-unit comparison)", () => {
  const e = (lane: string) => ({ ts: "2026-01-10T09:00:00Z", by: "agent", lane, seq: 1 });
  it("uppercase lane sorts before lowercase (code units, not ICU)", () => {
    expect(F.eventOrder(e("B"), e("a"))).toBeLessThan(0);
    expect(F.eventOrder(e("a"), e("B"))).toBeGreaterThan(0);
  });
  it("lane-j before lane-y (ICU `lt` puts y first)", () => {
    expect(F.eventOrder(e("lane-j"), e("lane-y"))).toBeLessThan(0);
  });
  it("hyphen is not ignored: 'a-b' < 'a0' by code unit", () => {
    expect(F.eventOrder(e("a-b"), e("a0"))).toBeLessThan(0);
  });
});

describe("3. validator status model (register status + release.shipped cascade)", () => {
  const tasks = (extra: any[]) => ({
    tasks: [...ids().map((id) => ({ id, status: "planned", release: null })), ...extra],
    releaseIds: releaseIds(),
  });
  it("task.started on a register code-complete task is illegal", () => {
    const fl = raw(
      files(),
      "lane-u.jsonl",
      line("lane-u", 5, "2026-01-10T10:01:00Z", "task.started", "agent", { task: "F-09" }),
    );
    const errors = run(fl, tasks([{ id: "F-09", status: "code-complete", release: null }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lane-u.jsonl", line: 5 });
    expect(errors[0].reason).toMatch(/illegal transition code-complete→started/);
  });
  it("task.reopened on a register released task passes", () => {
    const fl = raw(
      files(),
      "lane-u.jsonl",
      line("lane-u", 5, "2026-01-10T10:01:00Z", "task.reopened", "agent", {
        task: "F-10",
        reason: "regressed",
      }),
    );
    expect(run(fl, tasks([{ id: "F-10", status: "released", release: null }]))).toEqual([]);
  });
  it("release.shipped cascades code-complete -> released, so a later done is illegal", () => {
    let fl = raw(
      files(),
      "lead.jsonl",
      line("lead", 9, "2026-01-10T12:00:00Z", "release.shipped", "agent", {
        release: "R2",
        sha: "abc1234",
      }),
    );
    fl = raw(
      fl,
      "lane-u.jsonl",
      line("lane-u", 5, "2026-01-10T13:00:00Z", "task.done", "agent", { task: "F-11" }),
    );
    const errors = run(fl, tasks([{ id: "F-11", status: "code-complete", release: "R2" }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lane-u.jsonl", line: 5 });
    expect(errors[0].reason).toMatch(/illegal transition released→done/);
  });
});

describe("3b. RegisterTask.release is required", () => {
  it("a task without release is a type error; with release the cascade applies", () => {
    // @ts-expect-error release is required when tasks is supplied
    const bad: RegisterTask = { id: "F-11", status: "code-complete" };
    expect(bad.id).toBe("F-11");
    const ok: RegisterTask = { id: "F-11", status: "code-complete", release: "R2" };
    expect(ok.release).toBe("R2");
  });
});

describe("4. injectable denylist hook", () => {
  it("a hit becomes `denylist hit: <pattern>` at file:line", () => {
    const fl = raw(
      files(),
      "lane-b.jsonl",
      line("lane-b", 5, "2026-01-10T10:30:00Z", "lane.note", "agent", { note: "acme-secret here" }),
    );
    const errors = run(
      fl,
      ctx({ denylistHit: (l: string) => (l.includes("acme-secret") ? "secret-word" : null) }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lane-b.jsonl", line: 5 });
    expect(errors[0].reason).toBe("denylist hit: secret-word");
  });
  it("no hook, no denylist error", () => {
    expect(run(files(), ctx())).toEqual([]);
  });
});

describe("5. prototype safety", () => {
  it.each(["__proto__", "constructor", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"])(
    "waste.ack key %s is a validation error",
    (key) => {
      const fl = raw(
        files(),
        "owner.jsonl",
        line("owner", 4, "2026-01-10T11:20:00Z", "waste.ack", "owner", { key }),
      );
      const errors = run(fl, ctx());
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ file: "owner.jsonl", line: 5 });
      expect(errors[0].reason).toMatch(/key/);
    },
  );
  it("a normal ack key is fine", () => {
    const fl = raw(
      files(),
      "owner.jsonl",
      line("owner", 4, "2026-01-10T11:20:00Z", "waste.ack", "owner", { key: "W1:pr-12:abc1234" }),
    );
    expect(run(fl, ctx())).toEqual([]);
  });
  it.each(["__proto__", "constructor"])("task id %s is a validation error", (id) => {
    const fl = raw(
      files(),
      "lane-u.jsonl",
      line("lane-u", 5, "2026-01-10T10:01:00Z", "task.started", "agent", { task: id }),
    );
    const errors = run(fl, ctx());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lane-u.jsonl", line: 5 });
  });

  const base = () => ({
    tasks: [
      {
        id: "F-01",
        title: "t",
        kind: "feature",
        status: "planned",
        priority: "P2",
        release: null,
        areas: [],
        dependsOn: [],
        related: [],
        lane: null,
        phase: null,
      },
    ],
    releases: [],
  });
  const ev = (lane: string, seq: number, ts: string, type: string, extra = {}, by = "agent") => ({
    seq,
    ts,
    lane,
    type,
    by,
    ...extra,
  });
  const T = (hhmm: string) => `2026-01-10T${hhmm}:00Z`;
  const NOW = "2026-01-12T10:00:00Z";

  it("fold: an ack keyed __proto__ is an own property, nothing throws", () => {
    let s: any;
    expect(() => {
      s = F.fold(
        base(),
        { owner: [ev("owner", 1, T("09:00"), "waste.ack", { key: "__proto__" }, "owner")] },
        null,
        null,
        NOW,
      );
    }).not.toThrow();
    expect(Object.hasOwn(s.acks, "__proto__")).toBe(true);
  });
  it.each(["constructor", "__proto__", "toString"])(
    "fold: task id %s is unknown, never throws",
    (id) => {
      let s: any;
      expect(() => {
        s = F.fold(
          base(),
          { "lane-u": [ev("lane-u", 1, T("09:00"), "task.started", { task: id })] },
          null,
          null,
          NOW,
        );
      }).not.toThrow();
      expect(s.warnings).toHaveLength(1);
      expect(s.warnings[0].reason).toMatch(/unknown task/);
    },
  );
  it("fold: event type `constructor` is an unknown type warning", () => {
    const s = F.fold(
      base(),
      { "lane-u": [ev("lane-u", 1, T("09:00"), "constructor", {})] },
      null,
      null,
      NOW,
    );
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0].reason).toMatch(/unknown type/);
  });
});

describe("6. provenance on pr, related and empty lane pointers", () => {
  const bt = (id: string, over = {}) => ({
    id,
    title: id,
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
  const ev = (lane: string, seq: number, ts: string, type: string, extra = {}, by = "agent") => ({
    seq,
    ts,
    lane,
    type,
    by,
    ...extra,
  });
  const T = (hhmm: string) => `2026-01-10T${hhmm}:00Z`;
  const NOW = "2026-01-12T10:00:00Z";
  const small = () => ({
    tasks: [bt("F-01"), bt("F-02"), bt("B01", { kind: "bug" })],
    releases: [],
  });

  it("pr is {value, source, ref}", () => {
    const s = F.fold(
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
    expect(s.tasks["F-01"].pr).toEqual({ value: 2801, source: "reported", ref: "lane-u#2" });
    expect(s.tasks["F-02"].pr).toEqual({ value: null, source: "register", ref: "register:F-02" });
  });
  it("related is {value, source, ref} and bug.filed links both ways", () => {
    const s = F.fold(
      small(),
      { "lane-b": [ev("lane-b", 1, T("09:00"), "bug.filed", { bug: "B01", task: "F-01" })] },
      null,
      null,
      NOW,
    );
    expect(s.tasks["B01"].related).toEqual({
      value: ["F-01"],
      source: "reported",
      ref: "lane-b#1",
    });
    expect(s.tasks["F-01"].related).toEqual({
      value: ["B01"],
      source: "reported",
      ref: "lane-b#1",
    });
  });
  it("lanes with nothing reported have current/next {null, reported, null}", () => {
    const s = F.fold(
      small(),
      { lead: [ev("lead", 1, T("09:00"), "lane.note", { note: "n" })] },
      null,
      null,
      NOW,
    );
    expect(s.lanes["lead"].current).toEqual({ value: null, source: "reported", ref: null });
    expect(s.lanes["lead"].next).toEqual({ value: null, source: "reported", ref: null });
  });
});

describe("7. missing fold and validator coverage", () => {
  const bt = (id: string, over = {}) => ({
    id,
    title: id,
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
  const ev = (lane: string, seq: number, ts: string, type: string, extra = {}, by = "agent") => ({
    seq,
    ts,
    lane,
    type,
    by,
    ...extra,
  });
  const T = (hhmm: string) => `2026-01-10T${hhmm}:00Z`;
  const NOW = "2026-01-12T10:00:00Z";
  const small = () => ({ tasks: [bt("F-01"), bt("F-02")], releases: [] });

  it("owner task.next with targetLane sets that lane's next; lane-u clears it", () => {
    const owner = [
      ev("owner", 1, T("09:00"), "task.next", { task: "F-02", targetLane: "lane-u" }, "owner"),
    ];
    const s = F.fold(small(), { owner }, null, null, NOW);
    expect(s.warnings).toEqual([]);
    expect(s.lanes["lane-u"].next).toEqual({ value: "F-02", source: "reported", ref: "owner#1" });
    const s2 = F.fold(
      small(),
      { owner, "lane-u": [ev("lane-u", 1, T("09:05"), "task.next", { task: null })] },
      null,
      null,
      NOW,
    );
    expect(s2.lanes["lane-u"].next).toEqual({ value: null, source: "reported", ref: "lane-u#1" });
  });
  it("release.shipped releases the release's code-complete tasks only", () => {
    const base = {
      tasks: [bt("F-01", { release: "R1" }), bt("F-02", { release: "R1" })],
      releases: [{ id: "R1", name: "R1", shipDate: "2026-01-20", status: "planned" }],
    };
    const s = F.fold(
      base,
      {
        "lane-u": [
          ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" }),
          ev("lane-u", 2, T("09:10"), "task.done", { task: "F-01" }),
        ],
        lead: [ev("lead", 1, T("10:00"), "release.shipped", { release: "R1", sha: "abc1234" })],
      },
      null,
      null,
      NOW,
    );
    expect(s.warnings).toEqual([]);
    expect(s.tasks["F-01"].status).toEqual({
      value: "released",
      source: "reported",
      ref: "lead#1",
    });
    expect(s.tasks["F-02"].status.value).toBe("planned");
    expect(s.releases["R1"].status).toEqual({
      value: "shipped",
      source: "reported",
      ref: "lead#1",
    });
  });
  it("task.lane reassigns the derived lane", () => {
    const s = F.fold(
      small(),
      {
        owner: [
          ev("owner", 1, T("09:00"), "task.lane", { task: "F-01", toLane: "lane-b" }, "owner"),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(s.tasks["F-01"].lane).toEqual({ value: "lane-b", source: "reported", ref: "owner#1" });
  });
  it("bug.fixed moves a bug task to code-complete with its pr", () => {
    const base = { tasks: [bt("B01", { kind: "bug" })], releases: [] };
    const s = F.fold(
      base,
      { "lane-b": [ev("lane-b", 1, T("09:00"), "bug.fixed", { bug: "B01", pr: 101 })] },
      null,
      null,
      NOW,
    );
    expect(s.warnings).toEqual([]);
    expect(s.tasks["B01"].status).toEqual({
      value: "code-complete",
      source: "reported",
      ref: "lane-b#1",
    });
    expect(s.tasks["B01"].pr).toEqual({ value: 101, source: "reported", ref: "lane-b#1" });
  });
  it("waste.ack is recorded by key", () => {
    const s = F.fold(
      small(),
      {
        owner: [
          ev(
            "owner",
            1,
            T("09:00"),
            "waste.ack",
            { key: "W1:pr-1:abc", until: "2026-02-01", why: "ok" },
            "owner",
          ),
        ],
      },
      null,
      null,
      NOW,
    );
    expect(s.acks["W1:pr-1:abc"]).toEqual({
      key: "W1:pr-1:abc",
      until: "2026-02-01",
      why: "ok",
      ref: "owner#1",
    });
  });
  it("validator: targetLane from lane-u is an unauthorised emitter", () => {
    const fl = raw(
      files(),
      "lane-u.jsonl",
      line("lane-u", 5, "2026-01-10T10:01:00Z", "task.next", "agent", {
        task: "RF-3",
        targetLane: "lane-b",
      }),
    );
    const errors = run(fl, ctx());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lane-u.jsonl", line: 5 });
    expect(errors[0].reason).toMatch(/unauthori[sz]ed emitter/i);
  });
});

describe("8. ref is pinned to {feature?, bug?, issue?, deferred?}", () => {
  const mint = (ref: unknown) =>
    raw(
      files(),
      "lead.jsonl",
      line("lead", 9, "2026-01-09T08:20:00Z", "task.created", "agent", {
        id: "RF-50",
        title: "acme: ref pin",
        kind: "chore",
        ref,
      }),
    );
  it("an unknown ref key is an error", () => {
    const errors = run(mint({ foo: 1 }), ctx());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lead.jsonl", line: 9 });
    expect(errors[0].reason).toMatch(/ref/);
  });
  it("a bad ref value is an error", () => {
    expect(run(mint({ feature: "nope" }), ctx())).toHaveLength(1);
  });
  it("a valid ref passes", () => {
    expect(run(mint({ feature: "F-01", bug: null, issue: 2775, deferred: "D-01" }), ctx())).toEqual(
      [],
    );
  });
});

describe("9. task.lane updates the tracked holder", () => {
  const base = () => ({
    tasks: [
      {
        id: "F-01",
        title: "t",
        kind: "feature",
        status: "planned",
        priority: "P2",
        release: null,
        areas: [],
        dependsOn: [],
        related: [],
        lane: null,
        phase: null,
      },
    ],
    releases: [],
  });
  const ev = (lane: string, seq: number, ts: string, type: string, extra = {}, by = "agent") => ({
    seq,
    ts,
    lane,
    type,
    by,
    ...extra,
  });
  const T = (hhmm: string) => `2026-01-10T${hhmm}:00Z`;
  it("fold: after task.lane, the new lane's task.started is legal", () => {
    const s = F.fold(
      base(),
      {
        "lane-u": [ev("lane-u", 1, T("09:00"), "task.started", { task: "F-01" })],
        owner: [
          ev("owner", 1, T("09:10"), "task.lane", { task: "F-01", toLane: "lane-b" }, "owner"),
        ],
        "lane-b": [ev("lane-b", 1, T("09:20"), "task.started", { task: "F-01" })],
      },
      null,
      null,
      "2026-01-12T10:00:00Z",
    );
    expect(s.warnings).toEqual([]);
    expect(s.tasks["F-01"].lane.value).toBe("lane-b");
  });
  it("validator: same sequence passes", () => {
    let fl = raw(
      files(),
      "owner.jsonl",
      line("owner", 4, "2026-01-10T11:20:00Z", "task.lane", "owner", {
        task: "RF-3",
        toLane: "lane-b",
      }),
    );
    fl = raw(
      fl,
      "lane-b.jsonl",
      line("lane-b", 5, "2026-01-10T11:30:00Z", "task.started", "agent", { task: "RF-3" }),
    );
    expect(run(fl, ctx())).toEqual([]);
  });
});

describe("10. targetLane is owner-only", () => {
  it("lead emitting targetLane is an unauthorised emitter", () => {
    const fl = raw(
      files(),
      "lead.jsonl",
      line("lead", 9, "2026-01-09T08:20:00Z", "task.next", "agent", {
        task: "RF-1",
        targetLane: "lane-u",
      }),
    );
    const errors = run(fl, ctx());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "lead.jsonl", line: 9 });
    expect(errors[0].reason).toMatch(/unauthori[sz]ed emitter/i);
  });
  it("owner emitting targetLane passes", () => {
    const fl = raw(
      files(),
      "owner.jsonl",
      line("owner", 4, "2026-01-10T11:20:00Z", "task.next", "owner", {
        task: "RF-1",
        targetLane: "lane-u",
      }),
    );
    expect(run(fl, ctx())).toEqual([]);
  });
});
