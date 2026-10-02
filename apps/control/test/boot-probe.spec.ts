/**
 * Server-token PR, boot policy: enforceReadOnly decides whether the process may start, from the
 * probe outcome of the product repo and then the state repo. The probe and the sleep are injected,
 * so no network and no real waiting.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const P = (): any => require("../src/sources/probe");

const TOKEN = "tok-FAKE-boot-0123456789";
const PRODUCT = "acme/acme";
const STATE = "acme/acme-control-state";

type Out = { result: "write" | "none" | "unknown"; detail: string };
const none: Out = { result: "none", detail: "403" };
const write: Out = { result: "write", detail: "200" };
const unk = (detail = "500"): Out => ({ result: "unknown", detail });

/** A probe that serves a scripted list of outcomes per repo and records every call. */
function scripted(plan: Record<string, Out[]>) {
  const calls: Array<{ repo: string; token: string }> = [];
  const left: Record<string, Out[]> = Object.fromEntries(
    Object.entries(plan).map(([k, v]) => [k, v.slice()]),
  );
  const probe = async (a: { token: string; repo: string }): Promise<Out> => {
    calls.push({ repo: a.repo, token: a.token });
    const next = left[a.repo]?.shift();
    if (!next) throw new Error(`unscripted probe for ${a.repo}`);
    return next;
  };
  return { probe, calls };
}
const run = (plan: Record<string, Out[]>, extra: Record<string, unknown> = {}) => {
  const s = scripted(plan);
  const lines: string[] = [];
  const sleeps: number[] = [];
  const p = P().enforceReadOnly({
    token: TOKEN,
    productRepo: PRODUCT,
    stateRepo: STATE,
    probe: s.probe,
    sleep: async (ms: number) => void sleeps.push(ms),
    log: (l: string) => lines.push(l),
    ...extra,
  });
  return { p, lines, sleeps, calls: s.calls };
};

describe("enforceReadOnly", () => {
  it("none on both repos: ok, product probed before state, one log line each with the status", async () => {
    const r = run({ [PRODUCT]: [none], [STATE]: [{ result: "none", detail: "404" }] });
    expect(await r.p).toEqual({ ok: true });
    expect(r.calls.map((c) => c.repo)).toEqual([PRODUCT, STATE]);
    expect(r.lines).toEqual([
      `control: probe ${PRODUCT} -> read-only (403)`,
      `control: probe ${STATE} -> read-only (404)`,
    ]);
  });

  it("product write: refused with the exact message, state not probed", async () => {
    const r = run({ [PRODUCT]: [write], [STATE]: [none] });
    expect(await r.p).toEqual({
      ok: false,
      message: `the token has write access to ${PRODUCT}; refusing to start. Use a read-only token (contents:read).`,
    });
    expect(r.calls.map((c) => c.repo)).toEqual([PRODUCT]);
  });

  it("state write: refused, naming the state repo", async () => {
    const r = run({ [PRODUCT]: [none], [STATE]: [write] });
    expect(await r.p).toEqual({
      ok: false,
      message: `the token has write access to ${STATE}; refusing to start. Use a read-only token (contents:read).`,
    });
  });

  it("a write result still logs its status line before refusing", async () => {
    const r = run({ [PRODUCT]: [write] });
    await r.p;
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain(PRODUCT);
    expect(r.lines[0]).toContain("200");
  });

  it("unknown three times: refused with the last reason, 3 tries, backoff 1 s then 2 s", async () => {
    const r = run({ [PRODUCT]: [unk("500"), unk("timeout"), unk("503")] });
    expect(await r.p).toEqual({
      ok: false,
      message: `could not verify the token is read-only on ${PRODUCT} (503); refusing to start`,
    });
    expect(r.calls).toHaveLength(3);
    expect(r.sleeps).toEqual([1000, 2000]);
  });

  it("unknown then none: retried and ok", async () => {
    const r = run({ [PRODUCT]: [unk(), none], [STATE]: [none] });
    expect(await r.p).toEqual({ ok: true });
    expect(r.calls.map((c) => c.repo)).toEqual([PRODUCT, PRODUCT, STATE]);
    expect(r.sleeps).toEqual([1000]);
  });

  it("unknown, unknown, none on the state repo: still ok on the third try", async () => {
    const r = run({ [PRODUCT]: [none], [STATE]: [unk(), unk("timeout"), none] });
    expect(await r.p).toEqual({ ok: true });
    expect(r.sleeps).toEqual([1000, 2000]);
  });

  it("unknown then write: refused as write, not retried further", async () => {
    const r = run({ [PRODUCT]: [unk(), write] });
    const out = await r.p;
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/has write access to acme\/acme;/);
    expect(r.calls).toHaveLength(2);
  });

  it("unknown on the state repo three times: refused naming the state repo", async () => {
    const r = run({ [PRODUCT]: [none], [STATE]: [unk(), unk(), unk("network error")] });
    expect((await r.p).message).toBe(
      `could not verify the token is read-only on ${STATE} (network error); refusing to start`,
    );
  });

  it("a probe that throws is treated as unknown (fail closed) and retried", async () => {
    const probe = async () => {
      throw new Error("kaboom " + TOKEN);
    };
    const out = await P().enforceReadOnly({
      token: TOKEN,
      productRepo: PRODUCT,
      stateRepo: STATE,
      probe,
      sleep: async () => undefined,
      log: () => undefined,
    });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/could not verify the token is read-only on acme\/acme/);
    expect(out.message).not.toContain(TOKEN);
  });

  it("backoff and tries are injectable", async () => {
    const r = run({ [PRODUCT]: [unk(), unk()] }, { maxTries: 2, backoffMs: [5] });
    expect((await r.p).ok).toBe(false);
    expect(r.calls).toHaveLength(2);
    expect(r.sleeps).toEqual([5]);
  });

  it("the token reaches the probe but never a log line or a message", async () => {
    const r = run({ [PRODUCT]: [none], [STATE]: [write] });
    const out = await r.p;
    expect(r.calls.every((c) => c.token === TOKEN)).toBe(true);
    expect(JSON.stringify([r.lines, out])).not.toContain(TOKEN);
  });

  it("with the real probe: a fake server answering 403 on both repos is ok", async () => {
    const http = require("http");
    const srv = http.createServer((_q: any, s: any) => {
      s.writeHead(403);
      s.end("no");
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const lines: string[] = [];
      const out = await P().enforceReadOnly({
        token: TOKEN,
        productRepo: PRODUCT,
        stateRepo: STATE,
        base,
        log: (l: string) => lines.push(l),
      });
      expect(out).toEqual({ ok: true });
      expect(lines).toEqual([
        `control: probe ${PRODUCT} -> read-only (403)`,
        `control: probe ${STATE} -> read-only (403)`,
      ]);
    } finally {
      await new Promise<void>((ok) => srv.close(() => ok()));
    }
  });
});
