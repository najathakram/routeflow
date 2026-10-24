/** T53 (R24): POST /api/github-webhook, HMAC sha256 with CONTROL_WEBHOOK_SECRET. */
import { createHmac } from "crypto";
import { startServer, WEBHOOK_SECRET } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));

const sign = (body: string, secret = WEBHOOK_SECRET): string =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const hdr = (body: string, sig: string | undefined, extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-github-event": "pull_request",
  "x-github-delivery": "00000000-0000-0000-0000-000000000001",
  ...(sig ? { "x-hub-signature-256": sig } : {}),
  ...extra,
});
const BODY = JSON.stringify({ action: "closed", number: 301, pull_request: { number: 301 } });

let h: Harness;
beforeEach(async () => {
  h = await startServer({ webhook: true });
});
afterEach(() => h?.close());

describe("T53 webhook", () => {
  it("a valid HMAC → 202 and exactly one refresh scheduled, with no session cookie needed", async () => {
    const r = await h.req("POST", "/api/github-webhook", {
      headers: hdr(BODY, sign(BODY)),
      body: BODY,
    });
    expect(r.status).toBe(202);
    await new Promise((x) => setTimeout(x, 100));
    expect(h.refreshCalls).toBe(1);
  });
  it("a bad signature → 401 and no refresh", async () => {
    const r = await h.req("POST", "/api/github-webhook", {
      headers: hdr(BODY, sign(BODY, "another-secret")),
      body: BODY,
    });
    expect(r.status).toBe(401);
    await new Promise((x) => setTimeout(x, 100));
    expect(h.refreshCalls).toBe(0);
  });
  it("a missing signature header → 401", async () => {
    const r = await h.req("POST", "/api/github-webhook", {
      headers: hdr(BODY, undefined),
      body: BODY,
    });
    expect(r.status).toBe(401);
    expect(h.refreshCalls).toBe(0);
  });
  it("a signature for a different body (tampered payload) → 401", async () => {
    const r = await h.req("POST", "/api/github-webhook", {
      headers: hdr(BODY, sign(BODY)),
      body: BODY.replace("301", "302"),
    });
    expect(r.status).toBe(401);
    expect(h.refreshCalls).toBe(0);
  });
  it.each(["", "sha256=", "sha1=" + "a".repeat(40), "sha256=zz", "sha256=" + "0".repeat(10)])(
    "malformed signature %j → 401 (no throw on length mismatch)",
    async (sig) => {
      const r = await h.req("POST", "/api/github-webhook", {
        headers: { ...hdr(BODY, undefined), "x-hub-signature-256": sig },
        body: BODY,
      });
      expect(r.status).toBe(401);
      expect(h.refreshCalls).toBe(0);
    },
  );
  it("the body of a rejected delivery is ignored: state version unchanged, remote tip unchanged", async () => {
    const s = await h.session();
    const v0 = (await h.stateJson(s)).state.version;
    const tip = h.world.remoteHead();
    await h.req("POST", "/api/github-webhook", {
      headers: hdr(BODY, "sha256=" + "0".repeat(64)),
      body: BODY,
    });
    expect((await h.stateJson(s)).state.version).toBe(v0);
    expect(h.world.remoteHead()).toBe(tip);
  });
  it("GET on the webhook path is not a route (404/405)", async () => {
    const g = await h.req("GET", "/api/github-webhook");
    expect([404, 405]).toContain(g.status);
  });
  it("the old name /api/webhook/github is not a route", async () => {
    const r = await h.req("POST", "/api/webhook/github", {
      headers: hdr(BODY, sign(BODY)),
      body: BODY,
    });
    expect(r.status).toBe(404);
  });
});

describe("webhook without a configured secret", () => {
  it("never accepts: every delivery is refused and nothing refreshes", async () => {
    await h.close();
    h = await startServer({ webhook: false });
    const r = await h.req("POST", "/api/github-webhook", {
      headers: hdr(BODY, sign(BODY, "")),
      body: BODY,
    });
    expect([401, 404, 503]).toContain(r.status);
    expect(h.refreshCalls).toBe(0);
  });
});
