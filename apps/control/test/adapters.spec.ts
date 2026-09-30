/**
 * T7 (R3) + data side of T27 (R14) — register adapters.
 *
 * Contract under test (chosen by the test author; see the WP4 report):
 *   src/domain/adapters.ts (pure, never mutate their input):
 *     featuresAsTasks(rows) / bugsAsTasks(rows) / deferredAsTasks(rows) -> BaseTask[]
 *       BaseTask = {id,title,kind,status,priority,release,areas,dependsOn,related,lane,phase,pr?,
 *                   sensitive?,sensitiveFor?}
 *     releasesFromRegister(rows) -> {id,name,shipDate,status,goal}[]
 *     locationAreas(location: string) -> string[]       (spec §3 regex, verbatim)
 *     registerTasks(tasks) -> {id,status,release}[]     (validator input)
 *   src/sources/registers.ts:
 *     loadJsonl(path) -> any[]                          (missing file -> [])
 *     loadRegisters({fixtureDir?}) -> {tasks, releases, registerTasks}
 *       fixtureDir defaults to env CONTROL_FIXTURE; reads <dir>/registers/{features,bugs,deferred,releases}.jsonl
 */
import * as fs from "fs";
import * as path from "path";

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const ad = tryRequire(() => require("../src/domain/adapters"));
const src = tryRequire(() => require("../src/sources/registers"));

const FIX = path.join(__dirname, "fixtures", "acme");
const jsonl = (p: string): any[] =>
  fs
    .readFileSync(path.join(FIX, p), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const needAd = () => {
  expect(ad).toBeDefined();
  return ad;
};
const needSrc = () => {
  expect(src).toBeDefined();
  return src;
};

describe("featuresAsTasks", () => {
  it("maps register status and fields exactly (done->released, at-risk->in-progress)", () => {
    const rows = jsonl("registers/features.jsonl");
    const t = needAd().featuresAsTasks(rows);
    expect(t.map((x: any) => x.id)).toEqual(["F-01", "F-02", "F-03", "F-04", "F-05", "F-06"]);
    expect(t.map((x: any) => x.status)).toEqual([
      "released",
      "in-progress",
      "in-progress",
      "planned",
      "planned",
      "in-progress",
    ]);
    expect(t[1]).toMatchObject({
      id: "F-02",
      title: "Acme feature 2",
      kind: "feature",
      status: "in-progress",
      priority: "P2",
      release: "R2",
      dependsOn: ["F-01"],
      lane: null,
      phase: null,
    });
    expect(t[0].release).toBe("R1");
  });
});

describe("bugsAsTasks", () => {
  const bugs = () => needAd().bugsAsTasks(jsonl("registers/bugs.jsonl"));
  const byId = (id: string) => bugs().find((x: any) => x.id === id);

  it("maps an open bug: planned, severity->priority, areas from location", () => {
    expect(byId("B01")).toMatchObject({
      id: "B01",
      title: "acme: invoice PDF date misaligned 01",
      kind: "bug",
      status: "planned",
      priority: "P3",
      release: null,
      areas: ["apps/api/src/invoices/invoice-pdf.ts"],
      lane: null,
    });
  });

  it("maps severity critical/high/medium/low to P0/P1/P2/P3", () => {
    const p = Object.fromEntries(bugs().map((b: any) => [b.id, b.priority]));
    expect([p.B04, p.B03, p.B06, p.B05]).toEqual(["P0", "P1", "P2", "P3"]);
  });

  it("strips :line from areas and carries sensitive/sensitiveFor", () => {
    const b = byId("B02");
    expect(b.areas).toEqual(["apps/web/app/(dashboard)/invoices/page.tsx"]);
    expect(b.sensitive).toBe(true);
    expect(b.sensitiveFor).toEqual(["tenancy"]);
    expect(byId("B01").sensitive).toBe(false);
  });

  it("maps 'Fixed · #101' to code-complete with pr 101", () => {
    expect(byId("B03")).toMatchObject({ status: "code-complete", pr: 101 });
  });

  it.each([
    ["Open", "planned"],
    ["open", "planned"],
    ["Open · partial", "planned"],
    ["Cleared", "dropped"],
    ["Cleared · intentional", "dropped"],
    ["Refuted", "dropped"],
    ["Already fixed", "dropped"],
    ["Duplicate · fixed by · 12", "dropped"],
  ])("register %j -> status %s", (register, status) => {
    const row = { id: "B90", title: "acme x", location: "", severity: "low", register };
    expect(needAd().bugsAsTasks([row])[0].status).toBe(status);
  });
});

describe("locationAreas (spec §3 regex)", () => {
  it("extracts path tokens, strips :line and (~n), dedupes, bare directory -> /**", () => {
    const { locationAreas } = needAd();
    expect(locationAreas("Invoices · API apps/api/src/a.ts:12")).toEqual(["apps/api/src/a.ts"]);
    expect(locationAreas("apps/api/src/a.ts(~40)")).toEqual(["apps/api/src/a.ts"]);
    expect(locationAreas("apps/api/src/invoices/")).toEqual(["apps/api/src/invoices/**"]);
    expect(
      locationAreas(
        "packages/pricing/src/x.ts and scripts/roadmap/r.mjs; packages/pricing/src/x.ts:3",
      ),
    ).toEqual(["packages/pricing/src/x.ts", "scripts/roadmap/r.mjs"]);
    expect(locationAreas("no paths here")).toEqual([]);
  });
});

describe("deferredAsTasks", () => {
  it("open -> reconsider, closed -> dropped, kind deferred", () => {
    const t = needAd().deferredAsTasks(jsonl("registers/deferred.jsonl"));
    expect(t.map((x: any) => [x.id, x.status])).toEqual([
      ["D-01", "reconsider"],
      ["D-02", "reconsider"],
      ["D-03", "reconsider"],
      ["D-04", "dropped"],
    ]);
    expect(t[0]).toMatchObject({ id: "D-01", title: "Acme deferral 1", kind: "deferred" });
  });
});

describe("releasesFromRegister", () => {
  it("passes releases straight through", () => {
    const r = needAd().releasesFromRegister(jsonl("registers/releases.jsonl"));
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({
      id: "R1",
      name: "Release 1",
      shipDate: "2026-01-05",
      status: "done",
      goal: "Acme baseline: invoices and routes.",
    });
    expect(r.map((x: any) => x.id)).toEqual(["R1", "R2", "R3"]);
  });
});

describe("T7 — adapters never mutate their input", () => {
  it("deep-equal before/after, identical output on a second call", () => {
    const a = needAd();
    const inputs = {
      f: jsonl("registers/features.jsonl"),
      b: jsonl("registers/bugs.jsonl"),
      d: jsonl("registers/deferred.jsonl"),
      r: jsonl("registers/releases.jsonl"),
    };
    const before = structuredClone(inputs);
    const run = () => ({
      f: a.featuresAsTasks(inputs.f),
      b: a.bugsAsTasks(inputs.b),
      d: a.deferredAsTasks(inputs.d),
      r: a.releasesFromRegister(inputs.r),
    });
    const first = run();
    const second = run();
    expect(inputs).toEqual(before);
    expect(second).toEqual(first);
  });
});

describe("registerTasks", () => {
  it("projects {id,status,release} for the validator", () => {
    const a = needAd();
    const tasks = a.featuresAsTasks(jsonl("registers/features.jsonl"));
    expect(a.registerTasks(tasks)[1]).toEqual({ id: "F-02", status: "in-progress", release: "R2" });
  });
});

describe("loadJsonl / loadRegisters", () => {
  it("loadJsonl reads a file and returns [] for a missing one", () => {
    const s = needSrc();
    expect(s.loadJsonl(path.join(FIX, "registers", "releases.jsonl"))).toHaveLength(3);
    expect(s.loadJsonl(path.join(FIX, "registers", "nope.jsonl"))).toEqual([]);
  });

  it("loadRegisters({fixtureDir}) returns 22 tasks in register order, 3 releases, feeding both consumers", () => {
    const r = needSrc().loadRegisters({ fixtureDir: FIX });
    expect(r.tasks).toHaveLength(22);
    expect(r.tasks.map((t: any) => t.id)).toEqual([
      "F-01",
      "F-02",
      "F-03",
      "F-04",
      "F-05",
      "F-06",
      "B01",
      "B02",
      "B03",
      "B04",
      "B05",
      "B06",
      "B07",
      "B08",
      "B09",
      "B10",
      "B11",
      "B12",
      "D-01",
      "D-02",
      "D-03",
      "D-04",
    ]);
    expect(r.releases.map((x: any) => x.id)).toEqual(["R1", "R2", "R3"]);
    expect(r.registerTasks).toHaveLength(22);
    expect(r.registerTasks[0]).toEqual({ id: "F-01", status: "released", release: "R1" });
    expect(r.registerTasks.find((t: any) => t.id === "B03")).toEqual({
      id: "B03",
      status: "code-complete",
      release: null,
    });
  });

  it("loadRegisters() falls back to env CONTROL_FIXTURE", () => {
    const prev = process.env.CONTROL_FIXTURE;
    process.env.CONTROL_FIXTURE = FIX;
    try {
      expect(needSrc().loadRegisters().tasks).toHaveLength(22);
    } finally {
      if (prev === undefined) delete process.env.CONTROL_FIXTURE;
      else process.env.CONTROL_FIXTURE = prev;
    }
  });
});
