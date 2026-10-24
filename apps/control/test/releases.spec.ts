/** WP2 release readiness (spec 5.9, E35: due within 3 d with > 25 % open). Module missing (RED). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const R: any = require("../src/domain/releases");

const d = <T>(value: T) => ({ value, source: "register" as const, ref: null });
const task = (id: string, release: string | null, status: string) => ({
  id,
  status: d(status),
  release: d(release),
});
const rel = (id: string, shipDate: string | null, status = "planned", history: any[] = []) => ({
  id,
  name: id,
  status: d(status),
  shipDate: d(shipDate),
  goal: null,
  history,
});
const state = (releases: any[], tasks: any[]) => ({
  releases: Object.fromEntries(releases.map((r) => [r.id, r])),
  tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
});
const NOW = "2026-09-30T00:00:00.000Z";
const mkTasks = (release: string, open: number, total: number) =>
  Array.from({ length: total }, (_, i) =>
    task(`RF-${i + 1}`, release, i < open ? "in-progress" : "code-complete"),
  );
const read = (shipDate: string | null, open: number, total: number, status = "planned") =>
  R.releaseReadiness(state([rel("R1", shipDate, status)], mkTasks("R1", open, total)), "R1", NOW);

describe("release readiness constants", () => {
  it("are 3 days and .25", () => {
    expect(R.AT_RISK_DUE_SOON_DAYS).toBe(3);
    expect(R.OPEN_RATIO).toBe(0.25);
  });
});

describe("release readiness", () => {
  it("READY when every counted task is code-complete or released", () => {
    const r = read("2026-10-20", 0, 4);
    expect(r).toMatchObject({ state: "READY", total: 4, done: 4, open: 0, openRatio: 0 });
  });
  it("IN PROGRESS when far from the date, regardless of open ratio", () => {
    expect(read("2026-10-20", 3, 4)).toMatchObject({
      state: "IN PROGRESS",
      open: 3,
      openRatio: 0.75,
    });
  });
  it("AT RISK: due in exactly 3 days with open ratio > .25", () => {
    expect(read("2026-10-03", 3, 10).state).toBe("AT RISK");
  });
  it("boundary: 4 days out is not at risk; 3 days out at exactly .25 open is not at risk", () => {
    expect(read("2026-10-04", 9, 10).state).toBe("IN PROGRESS");
    expect(read("2026-10-03", 1, 4).state).toBe("IN PROGRESS");
    expect(read("2026-10-03", 1, 4).openRatio).toBe(0.25);
    expect(read("2026-10-03", 2, 7).state).toBe("AT RISK"); // 2/7 = .2857
    expect(read("2026-10-03", 2, 9).state).toBe("IN PROGRESS"); // .222
  });
  it("overdue with > 25 % open is AT RISK; due today too", () => {
    expect(read("2026-09-28", 5, 10).state).toBe("AT RISK");
    expect(read("2026-09-30", 5, 10).state).toBe("AT RISK");
  });
  it("READY beats AT RISK when nothing is open even if the date is tomorrow", () => {
    expect(read("2026-10-01", 0, 3).state).toBe("READY");
  });
  it("no ship date is never AT RISK", () => {
    expect(read(null, 9, 10).state).toBe("IN PROGRESS");
  });
  it("shipped releases are SHIPPED; dropped tasks are not counted; released counts as done", () => {
    expect(read("2026-09-01", 2, 4, "shipped").state).toBe("SHIPPED");
    const tasks = [
      task("RF-1", "R1", "released"),
      task("RF-2", "R1", "dropped"),
      task("RF-3", "R1", "in-progress"),
      task("RF-4", "R2", "planned"),
    ];
    const r = R.releaseReadiness(state([rel("R1", "2026-10-20")], tasks), "R1", NOW);
    expect(r).toMatchObject({ total: 2, done: 1, open: 1, openRatio: 0.5 });
  });
  it("an empty release is IN PROGRESS with openRatio 0", () => {
    const r = R.releaseReadiness(state([rel("R1", "2026-10-20")], []), "R1", NOW);
    expect(r).toMatchObject({ state: "IN PROGRESS", total: 0, openRatio: 0 });
  });
  it("MOVED is surfaced from the latest release.moved history entry", () => {
    const history = [
      {
        ref: "lane-l#3",
        ts: "2026-09-20T00:00:00Z",
        type: "release.moved",
        task: null,
        from: "2026-10-01",
        to: "2026-10-03",
      },
    ];
    const r = R.releaseReadiness(
      state([rel("R1", "2026-10-03", "planned", history)], mkTasks("R1", 1, 4)),
      "R1",
      NOW,
    );
    expect(r.moved).toEqual({ from: "2026-10-01", to: "2026-10-03" });
    expect(read("2026-10-20", 1, 4).moved).toBeNull();
  });
});
