/**
 * T29, T31, T32, T34, T34b (R16): POST /api/event write-back. Wire format is what the WP6 client
 * sends: a flat JSON body `{type, ...eventFields, expectedVersion}` with X-Control-Token + Origin.
 */
import { startServer } from "./helpers/start-server";
import type { Harness, Session } from "./helpers/start-server";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));
/* eslint-disable @typescript-eslint/no-explicit-any */

let h: Harness;
let s: Session;
beforeEach(async () => {
  h = await startServer({ writeback: true });
  s = await h.session();
});
afterEach(() => h?.close());

const prio = (st: any, id = "RF-1"): string => st.tasks[id].priority.value;
const other = (p: string): string => (p === "P1" ? "P2" : "P1");
const ev = (st: any, over: Record<string, unknown> = {}) => {
  const prev = prio(st);
  return {
    type: "task.priority",
    task: "RF-1",
    priority: other(prev),
    prev,
    expectedVersion: st.version,
    ...over,
  };
};

describe("T29 a valid write is appended to owner.jsonl, pushed, and answered {seq, version}", () => {
  it("200 {seq, version}; the remote owner lane gains exactly one line; the state version moves", async () => {
    const st = (await h.stateJson(s)).state;
    const before = h.ownerLines().length;
    const r = await h.postEvent(s, ev(st));
    expect(r.status).toBe(200);
    const j = r.json();
    expect(typeof j.seq).toBe("number");
    expect(typeof j.version).toBe("string");
    expect(j.version).not.toBe(st.version);
    const after = h.ownerLines();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toMatchObject({
      type: "task.priority",
      task: "RF-1",
      lane: "owner",
      by: "owner",
      seq: j.seq,
    });
    const now = (await h.stateJson(s)).state;
    expect(now.version).toBe(j.version);
    expect(prio(now)).toBe(other(prio(st)));
  });
  it("writes only to events/owner.jsonl (no other lane file changes)", async () => {
    const st = (await h.stateJson(s)).state;
    const laneBefore = h.world.remoteLines("lane-u").length;
    const leadBefore = h.world.remoteLines("lead").length;
    expect((await h.postEvent(s, ev(st))).status).toBe(200);
    expect(h.world.remoteLines("lane-u").length).toBe(laneBefore);
    expect(h.world.remoteLines("lead").length).toBe(leadBefore);
  });
  it("the expectedVersion is not stored on the event line", async () => {
    const st = (await h.stateJson(s)).state;
    await h.postEvent(s, ev(st));
    const last = h.ownerLines().pop();
    expect(last.expectedVersion).toBeUndefined();
  });
});

describe("T31 no session → 401 and nothing appended", () => {
  it("POST without a cookie", async () => {
    const st = (await h.stateJson(s)).state;
    const tip = h.world.remoteHead();
    const { cookie: _c, ...noCookie } = s.write();
    const r = await h.req("POST", "/api/event", {
      headers: noCookie,
      body: JSON.stringify(ev(st)),
    });
    expect(r.status).toBe(401);
    expect(h.world.remoteHead()).toBe(tip);
  });
});

describe("T32 each missing guard → its 4xx, remote tip unchanged", () => {
  let st: any;
  let tip: string;
  beforeEach(async () => {
    st = (await h.stateJson(s)).state;
    tip = h.world.remoteHead();
  });
  afterEach(() => expect(h.world.remoteHead()).toBe(tip));

  it("foreign Origin → 403", async () => {
    const r = await h.postEvent(s, ev(st), { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });
  it("missing Origin → 403", async () => {
    const hd = s.write();
    delete hd.origin;
    const r = await h.req("POST", "/api/event", { headers: hd, body: JSON.stringify(ev(st)) });
    expect(r.status).toBe(403);
  });
  it("missing X-Control-Token → 403", async () => {
    const hd = s.write();
    delete hd["x-control-token"];
    const r = await h.req("POST", "/api/event", { headers: hd, body: JSON.stringify(ev(st)) });
    expect(r.status).toBe(403);
  });
  it("wrong X-Control-Token → 403", async () => {
    const r = await h.postEvent(s, ev(st), { "x-control-token": "AAAA" + s.csrf.slice(4) });
    expect(r.status).toBe(403);
  });
  it("text/plain → 415", async () => {
    const r = await h.postEvent(s, ev(st), { "content-type": "text/plain" });
    expect(r.status).toBe(415);
  });
  it("17 KB body → 413", async () => {
    const big = JSON.stringify({ ...ev(st), pad: "x".repeat(17 * 1024) });
    const r = await h.req("POST", "/api/event", { headers: s.write(), body: big });
    expect(r.status).toBe(413);
  });
  it("exactly 16 KB is not rejected for size", async () => {
    const base = JSON.stringify({ ...ev(st), pad: "" });
    const pad = "x".repeat(16 * 1024 - Buffer.byteLength(base));
    const body = JSON.stringify({ ...ev(st), pad });
    expect(Buffer.byteLength(body)).toBe(16 * 1024);
    const r = await h.req("POST", "/api/event", { headers: s.write(), body });
    expect(r.status).not.toBe(413);
  });
  it("a type that is not owner-allowed (task.started) → 422", async () => {
    const r = await h.postEvent(s, {
      type: "task.started",
      task: "RF-1",
      expectedVersion: st.version,
    });
    expect(r.status).toBe(422);
  });
  it.each([
    "task.done",
    "task.blocked",
    "task.progress",
    "bug.fixed",
    "segment",
    "constructor",
    "__proto__",
  ])("agent/unknown type %s → 422", async (type) => {
    const r = await h.postEvent(s, { type, task: "RF-1", expectedVersion: st.version });
    expect(r.status).toBe(422);
  });
  it("malformed JSON → 400 or 422", async () => {
    const r = await h.req("POST", "/api/event", { headers: s.write(), body: "{not json" });
    expect([400, 422]).toContain(r.status);
  });
  it("a payload that fails schema (priority P9) → 422", async () => {
    const r = await h.postEvent(s, ev(st, { priority: "P9" }));
    expect(r.status).toBe(422);
  });
  it("an unknown task id → 422", async () => {
    const r = await h.postEvent(s, ev(st, { task: "RF-99999" }));
    expect(r.status).toBe(422);
  });
  it("a stale expectedVersion → 409 {conflict:true, version: current}", async () => {
    const r = await h.postEvent(s, ev(st, { expectedVersion: "0".repeat(64) }));
    expect(r.status).toBe(409);
    const j = r.json();
    expect(j.conflict).toBe(true);
    expect(j.version).toBe(st.version);
  });
  it("a missing expectedVersion → 409 or 422, never an append", async () => {
    const e: any = ev(st);
    delete e.expectedVersion;
    const r = await h.postEvent(s, e);
    expect([409, 422]).toContain(r.status);
  });
  it("GET /api/event is not a route (404 or 405)", async () => {
    const r = await h.req("GET", "/api/event", { headers: { cookie: s.cookie } });
    expect([404, 405]).toContain(r.status);
  });
});

describe("T34 undo = a compensating event", () => {
  it("applying then the inverse restores the field; both are on the timeline; history grows by 2", async () => {
    const st0 = (await h.stateJson(s)).state;
    const p0 = prio(st0);
    const hist0 = (st0.tasks["RF-1"].history ?? []).length;
    const tl0 = st0.timeline.length;
    const a = await h.postEvent(s, ev(st0));
    expect(a.status).toBe(200);
    const st1 = (await h.stateJson(s)).state;
    const b = await h.postEvent(s, {
      type: "task.priority",
      task: "RF-1",
      priority: p0,
      prev: prio(st1),
      expectedVersion: st1.version,
    });
    expect(b.status).toBe(200);
    const st2 = (await h.stateJson(s)).state;
    expect(prio(st2)).toBe(p0);
    expect(st2.timeline.length).toBe(tl0 + 2);
    expect(Array.isArray(st2.tasks["RF-1"].history)).toBe(true);
    expect(st2.tasks["RF-1"].history.length).toBe(hist0 + 2);
  });
});

describe("T34b property: apply + inverse leaves the field equal to before (history +2)", () => {
  const P = ["P0", "P1", "P2", "P3"];
  const pairs: Array<[string, string]> = [];
  for (const a of P) for (const b of P) if (a !== b) pairs.push([a, b]);
  it.each(pairs.slice(0, 6))("%s then %s then back", async (x, y) => {
    let st = (await h.stateJson(s)).state;
    const orig = prio(st);
    const send = async (to: string) => {
      const cur = (await h.stateJson(s)).state;
      const r = await h.postEvent(s, {
        type: "task.priority",
        task: "RF-1",
        priority: to,
        prev: prio(cur),
        expectedVersion: cur.version,
      });
      expect(r.status).toBe(200);
    };
    const hist0 = (st.tasks["RF-1"].history ?? []).length;
    await send(x === orig ? y : x);
    await send(orig);
    st = (await h.stateJson(s)).state;
    expect(prio(st)).toBe(orig);
    expect(st.tasks["RF-1"].history.length).toBe(hist0 + 2);
  });
});
