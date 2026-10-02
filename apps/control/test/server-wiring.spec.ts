/**
 * LANE-NOTES carry-overs WP7 must satisfy (one describe each), observed through spies on the
 * modules the server must call: domain/validate, domain/fold, sources/compact, child_process.
 * The server must call them through their module exports (not a destructured copy captured
 * before the spy), which is how every other house spec observes a seam.
 */
import cp = require("child_process");
import { startServer } from "./helpers/start-server";
import type { Harness, Session } from "./helpers/start-server";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
const V: any = require("../src/domain/validate");
const F: any = require("../src/domain/fold");
const C: any = require("../src/sources/compact");

let h: Harness;
let s: Session;
afterEach(async () => {
  jest.restoreAllMocks();
  await h?.close();
});
const boot = async (opts: Parameters<typeof startServer>[0] = {}) => {
  h = await startServer({ writeback: true, ...opts }); // these specs exercise the write path
  s = await h.session();
};
const doWrite = async (): Promise<any> => {
  const st = (await h.stateJson(s)).state;
  const prev = st.tasks["RF-1"].priority.value;
  return h.postEvent(s, {
    type: "task.priority",
    task: "RF-1",
    priority: prev === "P1" ? "P2" : "P1",
    prev,
    expectedVersion: st.version,
  });
};
const findKey = (v: any, key: string, out: any[] = []): any[] => {
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === key) out.push(x);
      findKey(x, key, out);
    }
  }
  return out;
};

describe("carry-over 1: write-back validates with ctx.tasks (status + release), never bare taskIds", () => {
  it("validateEvents is called on a write with tasks[{id,status,release}] from registerTasks", async () => {
    await boot();
    const spy = jest.spyOn(V, "validateEvents");
    expect((await doWrite()).status).toBe(200);
    expect(spy).toHaveBeenCalled();
    for (const [, ctx] of spy.mock.calls as any[]) {
      expect(Array.isArray(ctx.tasks)).toBe(true);
      expect(ctx.tasks.length).toBeGreaterThan(0);
      for (const t of ctx.tasks) {
        expect(typeof t.id).toBe("string");
        expect(typeof t.status).toBe("string");
        expect("release" in t).toBe(true);
      }
      expect(ctx.tasks.map((t: any) => t.id)).toContain("F-01"); // a register task from the fixture
      expect(Array.isArray(ctx.releaseIds)).toBe(true);
    }
  });
  it("the status in ctx.tasks is the register's own (an adapted done task reads done)", async () => {
    await boot();
    const spy = jest.spyOn(V, "validateEvents");
    await doWrite();
    const ctx: any = (spy.mock.calls as any[])[0][1];
    const statuses = new Set(ctx.tasks.map((t: any) => t.status));
    expect(statuses.size).toBeGreaterThan(1); // not "everything planned" (the taskIds legacy default)
  });
});

describe("carry-over 2: compactDue after appends and ticks; compact when due; snapshotWarning surfaced", () => {
  const RES = {
    compacted: true,
    archived: [],
    snapshotWarning: "snapshot.json is 1200 KB (> 1024 KB): wiring-test-warning",
  };
  it("not due: compactDue is consulted after a write and after a tick, compact never runs", async () => {
    await boot();
    const due = jest.spyOn(C, "compactDue").mockReturnValue(false);
    const run = jest.spyOn(C, "compact").mockResolvedValue(RES);
    await doWrite();
    const afterWrite = due.mock.calls.length;
    expect(afterWrite).toBeGreaterThanOrEqual(1);
    expect(typeof due.mock.calls[0][0]).toBe("string"); // the clone dir
    await h.app.tick();
    expect(due.mock.calls.length).toBeGreaterThan(afterWrite);
    expect(run).not.toHaveBeenCalled();
  });
  it("due after a write: compact runs once with the state-branch env", async () => {
    await boot();
    jest.spyOn(C, "compactDue").mockReturnValue(true);
    const run = jest.spyOn(C, "compact").mockResolvedValue(RES);
    expect((await doWrite()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ origin: h.world.originUrl });
  });
  it("due on a tick: compact runs", async () => {
    await boot();
    jest.spyOn(C, "compactDue").mockReturnValue(true);
    const run = jest.spyOn(C, "compact").mockResolvedValue(RES);
    await h.app.tick();
    expect(run).toHaveBeenCalled();
  });
  it("a failing compact does not fail the write or the tick", async () => {
    await boot();
    jest.spyOn(C, "compactDue").mockReturnValue(true);
    jest.spyOn(C, "compact").mockRejectedValue(new Error("push lost"));
    expect((await doWrite()).status).toBe(200);
    await expect(h.app.tick()).resolves.not.toThrow();
  });
  it("the snapshot warning is surfaced to the owner (health or state)", async () => {
    await boot();
    jest.spyOn(C, "compactDue").mockReturnValue(true);
    jest.spyOn(C, "compact").mockResolvedValue(RES);
    jest.spyOn(C, "snapshotWarning").mockReturnValue(RES.snapshotWarning);
    await doWrite();
    await h.app.tick();
    const health = await h.req("GET", "/api/health", { headers: { cookie: s.cookie } });
    const state = await h.req("GET", "/api/state.json", { headers: { cookie: s.cookie } });
    expect(health.text + state.text).toContain("wiring-test-warning");
  });
});

describe("carry-over 3: the server fetches refs/pull/N/head so W5 works", () => {
  const pullCalls: string[] = [];
  const spawnSpy = (failPull: boolean) => {
    const real = cp.spawnSync;
    pullCalls.length = 0;
    return jest.spyOn(cp, "spawnSync").mockImplementation(((cmd: string, args: any, o: any) => {
      const line = [cmd, ...(Array.isArray(args) ? args : [])].join(" ");
      if (/refs\/pull\//.test(line)) {
        pullCalls.push(line);
        if (failPull) {
          return {
            status: 1,
            stdout: "",
            stderr: "fatal: couldn't find remote ref refs/pull/305/head",
            pid: 0,
            output: [],
            signal: null,
          } as any;
        }
      }
      return (real as any)(cmd, args, o);
    }) as any);
  };
  it("a tick fetches refs/pull/<n>/head for the closed-unmerged PR (305), by argv, never a shell", async () => {
    await boot();
    spawnSpy(false);
    await h.app.tick();
    expect(pullCalls.some((l) => /refs\/pull\/305\/head/.test(l))).toBe(true);
    expect(pullCalls.every((l) => l.startsWith("git "))).toBe(true);
  });
  it("only integer PR numbers from the GitHub payload are interpolated into the refspec", async () => {
    await boot({
      depsOver: {
        github: {
          poll: async () => ({
            prs: [
              {
                number: 305,
                state: "CLOSED",
                mergedAt: null,
                headRefName: "x",
                headRefOid: "a".repeat(40),
              },
              {
                number: "1; rm -rf /",
                state: "CLOSED",
                mergedAt: null,
                headRefName: "y",
                headRefOid: "b".repeat(40),
              },
            ],
            branches: [],
            files: {},
          }),
          state: { rateLimit: { remaining: 4000, resetAt: null } },
        },
      },
    });
    spawnSpy(false);
    await h.app.tick();
    expect(pullCalls.join("\n")).not.toMatch(/rm -rf/);
  });
  it("with the pull fetch failing: a source warning, and NO W5 for that PR", async () => {
    await boot();
    spawnSpy(true);
    await h.app.tick();
    const state = (await h.stateJson(s)).state;
    const health = await h.req("GET", "/api/health", { headers: { cookie: s.cookie } });
    const surfaced = JSON.stringify(state.warnings) + JSON.stringify(state.sources) + health.text;
    expect(surfaced).toMatch(/refs\/pull|pull ref|pull\/305|#305/i);
    expect(state.waste.some((w: any) => w.rule === "W5" && /305/.test(String(w.subject)))).toBe(
      false,
    );
  });
});

describe("carry-over 4: project() receives reconcile inputs", () => {
  it("inferred.reportedAt (reportedStatusAt) and per-service watchPatterns from apps/<svc>/railway.toml", async () => {
    await boot();
    const spy = jest.spyOn(F, "project");
    await h.app.tick();
    expect(spy).toHaveBeenCalled();
    const calls = spy.mock.calls as any[];
    const wp = calls.flatMap((c) => findKey(c, "watchPatterns"));
    expect(wp.length).toBeGreaterThan(0);
    expect(wp[wp.length - 1].api).toContain("apps/api/**");
    expect(wp[wp.length - 1].web).toContain("apps/web/**");
    const ra = calls.flatMap((c) => findKey(c, "reportedAt"));
    expect(ra.length).toBeGreaterThan(0);
    const last = ra[ra.length - 1];
    expect(Object.keys(last).length).toBeGreaterThan(0);
    for (const v of Object.values(last))
      expect(String(v)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  });
  it("reportedAt equals fold.reportedStatusAt of the events the server folded", async () => {
    await boot();
    const rsa = jest.spyOn(F, "reportedStatusAt");
    const spy = jest.spyOn(F, "project");
    await h.app.tick();
    if (rsa.mock.calls.length === 0) return; // computed elsewhere: the shape test above covers it
    const want = rsa.mock.results[rsa.mock.results.length - 1].value;
    const got = (spy.mock.calls as any[]).flatMap((c) => findKey(c, "reportedAt")).pop();
    expect(got).toEqual(want);
  });
});

describe("carry-over 5: state.json serves header lines + banners with the fragments", () => {
  it("has {state, fragments, header, banners, version} and the fragments carry every panel", async () => {
    await boot();
    const r = await h.req("GET", "/api/state.json", { headers: { cookie: s.cookie } });
    expect(r.status).toBe(200);
    const j = r.json();
    expect(typeof (j.version ?? j.state?.version)).toBe("string");
    expect(j.state).toBeDefined();
    for (const k of [
      "lanes",
      "blockers",
      "waste",
      "release",
      "queue",
      "bugs",
      "prs",
      "overlap",
      "piggyback",
      "phases",
      "timeline",
      "sources",
    ]) {
      expect(typeof j.fragments?.[k]).toBe("string");
    }
    expect(j.header).toBeDefined();
    expect(JSON.stringify(j.header).length).toBeGreaterThan(10);
    expect(j.banners).toBeDefined();
  });
  it("the header lines equal what GET / renders (one renderer, two surfaces)", async () => {
    await boot();
    const j = (await h.req("GET", "/api/state.json", { headers: { cookie: s.cookie } })).json();
    const page = (await h.req("GET", "/", { headers: { cookie: s.cookie } })).text;
    const lines: string[] = Array.isArray(j.header) ? j.header : [String(j.header)];
    for (const l of lines) expect(page).toContain(l);
  });
  it("supports If-None-Match: a repeat with the ETag is 304", async () => {
    await boot();
    const a = await h.req("GET", "/api/state.json", { headers: { cookie: s.cookie } });
    const etag = String(a.headers.etag);
    expect(etag).not.toBe("undefined");
    const b = await h.req("GET", "/api/state.json", {
      headers: { cookie: s.cookie, "if-none-match": etag },
    });
    expect(b.status).toBe(304);
  });
  it("the page embeds the csrf token and the same version as state.json", async () => {
    await boot();
    const j = (await h.req("GET", "/api/state.json", { headers: { cookie: s.cookie } })).json();
    const page = (await h.req("GET", "/", { headers: { cookie: s.cookie } })).text;
    expect(page).toContain(`name="control-version" content="${j.version ?? j.state.version}"`);
    expect(s.csrf.length).toBeGreaterThan(20);
  });
});

describe("carry-over 6: state carries PR facts for the PRs lanes work on (for `ctl next`)", () => {
  it("state.prs has ci/review/mergeable per PR and the PR linked to a task is attached to it", async () => {
    await boot();
    await h.app.tick();
    const st = (await h.stateJson(s)).state;
    const pr = st.prs.find((p: any) => p.pr === 301);
    expect(pr).toBeDefined();
    for (const k of ["ci", "review", "mergeable"]) expect(pr[k]).toBeDefined();
    expect(pr.links?.task ?? st.tasks["RF-2"]?.pr?.value).toBeTruthy();
  });
});
