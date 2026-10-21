import { startServer, PASSWORD } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { loginPage } from "../src/http/auth";

/**
 * Row 684: the login form must work under the page's own referrer policy. A same-origin form POST under
 * `Referrer-Policy: no-referrer` carries `Origin: null`, so an Origin-equals-host check refused EVERY login.
 * The rule (as the Ops Monitor's): `Referrer-Policy: same-origin`; `Origin: null` is accepted only with
 * `Sec-Fetch-Site: same-origin`; anything the browser marks cross-site is refused; a refusal is a real 403 page.
 */
const form = (pw: string) => ({
  "content-type": "application/x-www-form-urlencoded",
  body: `password=${encodeURIComponent(pw)}`,
});
const post = (h: Harness, path: string, headers: Record<string, string>, pw = PASSWORD) =>
  h.req("POST", path, { headers: { ...form(pw), ...headers }, body: form(pw).body });

describe("row 684: control login under the page's referrer policy", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startServer();
  });
  afterEach(async () => {
    await h.close();
  });

  it("serves Referrer-Policy: same-origin, so a same-origin form POST keeps its real Origin", async () => {
    const r = await h.req("GET", "/login");
    expect(r.headers["referrer-policy"]).toBe("same-origin");
  });

  it("REG: Origin null with Sec-Fetch-Site same-origin signs in (303 to / with a session cookie)", async () => {
    const r = await post(h, "/login", { origin: "null", "sec-fetch-site": "same-origin" });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/");
    expect(String(r.headers["set-cookie"] ?? "")).not.toBe("");
  });

  it("the real same-origin Origin still signs in", async () => {
    const r = await post(h, "/login", { origin: h.origin, "sec-fetch-site": "same-origin" });
    expect(r.status).toBe(303);
  });

  it.each([
    ["Origin null with no Sec-Fetch-Site", { origin: "null" }],
    ["Origin null marked cross-site", { origin: "null", "sec-fetch-site": "cross-site" }],
    [
      "Origin null marked same-site (a sibling subdomain)",
      { origin: "null", "sec-fetch-site": "same-site" },
    ],
    ["a foreign Origin", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["no Origin but the browser says cross-site", { "sec-fetch-site": "cross-site" }],
    [
      "a foreign Origin with no Sec-Fetch-Site (the origin-mismatch branch alone)",
      { origin: "https://evil.example" },
    ],
  ])("%s is refused with a 403 page and no session", async (_label, headers) => {
    const r = await post(h, "/login", headers as Record<string, string>);
    expect(r.status).toBe(403);
    expect(String(r.headers["content-type"])).toMatch(/^text\/html/);
    expect(r.text).toMatch(/This sign-in was blocked/);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("a non-browser client with neither header is still allowed (SameSite=Strict covers browsers)", async () => {
    const r = await post(h, "/login", {});
    expect(r.status).toBe(303);
  });

  it("logout follows the same rule: Origin null + same-origin is accepted, cross-site refused", async () => {
    const login = await post(h, "/login", { origin: "null", "sec-fetch-site": "same-origin" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const bad = await h.req("POST", "/logout", {
      headers: { cookie, origin: "null", "sec-fetch-site": "cross-site" },
    });
    expect(bad.status).toBe(403);
    const ok = await h.req("POST", "/logout", {
      headers: { cookie, origin: "null", "sec-fetch-site": "same-origin" },
    });
    expect(ok.status).toBe(303);
  });

  it("review nit: a refused logout is a plain 403, never the sign-in page (the session is still valid)", async () => {
    const login = await post(h, "/login", { origin: h.origin, "sec-fetch-site": "same-origin" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const r = await h.req("POST", "/logout", {
      headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(r.status).toBe(403);
    expect(String(r.headers["content-type"])).toMatch(/^text\/plain/);
    expect(r.text).toMatch(/sign-out was blocked/i);
    expect(r.text).not.toMatch(/action="\/login"/);
  });
});

describe("review nit: loginPage escapes its message", () => {
  it("HTML in the error is escaped, never rendered", () => {
    const page = loginPage('<img src=x onerror="alert(1)">');
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;img");
  });
});
