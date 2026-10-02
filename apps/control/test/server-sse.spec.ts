/** T54 (R25): SSE `version` on every fold change, ping, retry header, cleanup, connection cap. */
import { startServer, openSse } from "./helpers/start-server";
import type { Harness, Session } from "./helpers/start-server";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));
/* eslint-disable @typescript-eslint/no-explicit-any */

let h: Harness;
let s: Session;
const write = async (): Promise<any> => {
  const st = (await h.stateJson(s)).state;
  const prev = st.tasks["RF-1"].priority.value;
  const r = await h.postEvent(s, {
    type: "task.priority",
    task: "RF-1",
    priority: prev === "P1" ? "P2" : "P1",
    prev,
    expectedVersion: st.version,
  });
  expect(r.status).toBe(200);
  return r.json();
};
afterEach(() => h?.close());

describe("T54 SSE", () => {
  beforeEach(async () => {
    h = await startServer({ pingMs: 100, writeback: true });
    s = await h.session();
  });

  it("requires a session (401 without)", async () => {
    const c = await openSse(h.port, {});
    expect([401, 302]).toContain(c.status);
    c.destroy();
  });

  it("answers text/event-stream with retry: 5000 and the security headers", async () => {
    const c = await openSse(h.port, { cookie: s.cookie });
    expect(c.status).toBe(200);
    expect(String(c.headers["content-type"])).toMatch(/text\/event-stream/);
    expect(c.headers["x-robots-tag"]).toMatch(/noindex/);
    expect(String(c.headers["cache-control"])).toMatch(/no-store|no-cache/);
    expect(await c.waitFor(/retry: 5000/, 1000)).toBe(true);
    c.destroy();
  });

  it("two clients each get one `event: version` within 1 s of an owner write", async () => {
    const a = await openSse(h.port, { cookie: s.cookie });
    const b = await openSse(h.port, { cookie: s.cookie });
    await a.waitFor(/retry:/, 1000);
    await b.waitFor(/retry:/, 1000);
    const ok = await write();
    const t0 = Date.now();
    expect(await a.waitFor(/event: version/, 1000)).toBe(true);
    expect(await b.waitFor(/event: version/, 1000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    for (const c of [a, b]) {
      const n = (c.text().match(/event: version/g) ?? []).length;
      expect(n).toBe(1);
      expect(c.text()).toContain(ok.version);
    }
    a.destroy();
    b.destroy();
  });

  it("a keep-alive `event: ping` arrives on the ping interval", async () => {
    const c = await openSse(h.port, { cookie: s.cookie });
    expect(await c.waitFor(/event: ping/, 2000)).toBe(true);
    c.destroy();
  });

  it("a client disconnect is cleaned up (the open-stream count returns to 0)", async () => {
    const c = await openSse(h.port, { cookie: s.cookie });
    await c.waitFor(/retry:/, 1000);
    expect(h.app.sseCount()).toBe(1);
    c.destroy();
    const t0 = Date.now();
    while (h.app.sseCount() !== 0 && Date.now() - t0 < 2000)
      await new Promise((r) => setTimeout(r, 25));
    expect(h.app.sseCount()).toBe(0);
  });

  it("a rejected write (409) emits no version event", async () => {
    const c = await openSse(h.port, { cookie: s.cookie });
    await c.waitFor(/retry:/, 1000);
    const st = (await h.stateJson(s)).state;
    const r = await h.postEvent(s, {
      type: "task.priority",
      task: "RF-1",
      priority: "P1",
      prev: "P2",
      expectedVersion: "0".repeat(64),
    });
    expect(r.status).toBe(409);
    await new Promise((r2) => setTimeout(r2, 300));
    expect(c.text()).not.toContain("event: version");
    expect(st.version).toBeDefined();
    c.destroy();
  });

  it("at most 20 concurrent streams: the 21st is refused", async () => {
    const open: Array<{ destroy(): void; status: number }> = [];
    for (let i = 0; i < 20; i++) open.push(await openSse(h.port, { cookie: s.cookie }));
    expect(open.every((c) => c.status === 200)).toBe(true);
    const extra = await openSse(h.port, { cookie: s.cookie });
    expect(extra.status).toBeGreaterThanOrEqual(429);
    extra.destroy();
    open.forEach((c) => c.destroy());
  });
});
