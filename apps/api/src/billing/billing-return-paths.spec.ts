import { InternalServerErrorException, Logger } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import {
  BILLING_CANCEL_PATH,
  BILLING_PORTAL_RETURN_PATH,
  BILLING_RETURN_PATHS,
} from "@routeflow/types";
import {
  API_BILLING_CANCEL_PATH,
  API_BILLING_PORTAL_RETURN_PATH,
  API_BILLING_RETURN_PATHS,
  assertBillingReturnUrl,
  billingReturnUrl,
} from "./billing-return-paths";
import { withCheckoutPolicy } from "./checkout-session-params";
import { StripeService } from "./stripe.service";
import { webBaseUrl } from "../config/web-base-url";

// SA-1146 B-1 (B446): one home for every Checkout success / cancel / return address.

describe("billing return paths: the API copy equals the shared allowlist", () => {
  // Compiled API code cannot value-import @routeflow/types (no-runtime-types-import.spec), so the API keeps a
  // local copy; this spec is what keeps the two from drifting.
  it("the three return paths are the shared ones, key for key", () => {
    expect(API_BILLING_RETURN_PATHS).toEqual(BILLING_RETURN_PATHS);
  });
  it("the portal return is its own constant in both copies, and NOT a Checkout return path", () => {
    expect(API_BILLING_PORTAL_RETURN_PATH).toBe(BILLING_PORTAL_RETURN_PATH);
    expect(API_BILLING_PORTAL_RETURN_PATH).toBe("/settings/billing");
    expect(Object.values(BILLING_RETURN_PATHS)).not.toContain(BILLING_PORTAL_RETURN_PATH);
    expect(Object.values(API_BILLING_RETURN_PATHS)).not.toContain(API_BILLING_PORTAL_RETURN_PATH);
  });
  it("the cancel path is the shared one", () => {
    expect(API_BILLING_CANCEL_PATH).toBe(BILLING_CANCEL_PATH);
    expect(API_BILLING_CANCEL_PATH).toBe("/settings/billing?checkout=cancelled");
  });
  it("joins a path to the web base without a doubled slash", () => {
    expect(billingReturnUrl("https://app.test/", API_BILLING_RETURN_PATHS.plan)).toBe(
      "https://app.test/settings/billing?checkout=success",
    );
    expect(billingReturnUrl("https://app.test", API_BILLING_CANCEL_PATH)).toBe(
      "https://app.test/settings/billing?checkout=cancelled",
    );
  });
});

/** Every non-spec .ts under `dir`, recursively. */
function scan(dir: string): { f: string; text: string }[] {
  const out: { f: string; text: string }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...scan(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts"))
      out.push({
        f: path.relative(SRC, full).split(path.sep).join("/"),
        text: fs.readFileSync(full, "utf8"),
      });
  }
  return out;
}
const SRC = path.resolve(__dirname, "..");
const sources = scan(SRC);
const HOME = "billing/billing-return-paths.ts";

describe("billing return paths: no literal Checkout return address outside the one home", () => {
  it("there are sources to scan, and the home file exists", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.f === HOME)).toBe(true);
  });

  it("no `/billing/success` or `/billing/cancel` anywhere (those were never pages)", () => {
    const hits = sources
      .filter((s) => /\/billing\/(success|cancel)\b/.test(s.text))
      .map((s) => s.f);
    expect(hits).toEqual([]);
  });
});

// P4 above scans the raw text of every non-spec source under apps/api/src (testing/ included), nothing stripped.
// The ONE named exclusion: an allow-list KEY that is the path of a web file, not an address (count-pinned).
const P4_EXCLUSIONS: { file: string; reason: string }[] = [
  {
    file: "common/no-hand-typed-enum-mirrors.allow.ts",
    reason: "a key naming a web source FILE (the Billing page's page.tsx), not an address",
  },
];

describe("P4: the literal scan (raw text, all non-spec apps/api/src)", () => {
  it("no `/settings/billing` text outside the home, except the named, count-pinned exclusion", () => {
    const hits = sources
      .filter((s) => s.f !== HOME && s.text.includes("/settings/billing"))
      .map((s) => s.f)
      .sort();
    expect(hits).toEqual(P4_EXCLUSIONS.map((e) => e.file).sort());
    expect(P4_EXCLUSIONS).toHaveLength(1);
  });
});

describe("P1 / P2: where the boundary check and the portal create live", () => {
  // A call, not a mention: comments are cut first, so a commented-out call does not count.
  const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const callers = (needle: string) =>
    sources
      .filter((s) => s.f !== HOME && code(s.text).includes(needle))
      .map((s) => s.f)
      .sort();

  it("P1: `assertBillingReturnUrl(` is called in exactly checkout-session-params.ts and stripe.service.ts", () => {
    expect(callers("assertBillingReturnUrl(")).toEqual([
      "billing/checkout-session-params.ts",
      "billing/stripe.service.ts",
    ]);
  });

  it("P2: `billingPortal.sessions.create(` occurs once in non-spec apps/api/src, in stripe.service.ts", () => {
    expect(callers("billingPortal.sessions.create(")).toEqual(["billing/stripe.service.ts"]);
    const n = sources
      .filter((s) => s.f === "billing/stripe.service.ts")
      .reduce((a, s) => a + code(s.text).split("billingPortal.sessions.create(").length - 1, 0);
    expect(n).toBe(1);
  });
});

describe("assertBillingReturnUrl: the runtime check at the Stripe boundary (SA-1146 B-1 pin b)", () => {
  const BASE = "https://app.test";
  const U = (p: string, b = BASE) => billingReturnUrl(b, p);
  const SID = "&session_id={CHECKOUT_SESSION_ID}";
  let logged: jest.SpyInstance;
  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => logged.mockRestore());

  const okSuccess = Object.values(API_BILLING_RETURN_PATHS).flatMap((p) => [U(p), U(p) + SID]);

  it.each(okSuccess)("success and embedded_return accept %s", (url) => {
    expect(() => assertBillingReturnUrl("success", url, BASE)).not.toThrow();
    expect(() => assertBillingReturnUrl("embedded_return", url, BASE)).not.toThrow();
  });
  it("cancel accepts exactly the cancel address; portal exactly the portal address", () => {
    expect(() => assertBillingReturnUrl("cancel", U(API_BILLING_CANCEL_PATH), BASE)).not.toThrow();
    expect(() =>
      assertBillingReturnUrl("portal", U(API_BILLING_PORTAL_RETURN_PATH), BASE),
    ).not.toThrow();
  });
  it("a base that ends in a slash joins without a doubled slash (webBaseUrl() may end in /)", () => {
    const joined = billingReturnUrl("https://app.test/", API_BILLING_RETURN_PATHS.pay);
    expect(() => assertBillingReturnUrl("success", joined, BASE)).not.toThrow();
  });

  const evil = "https://evil.test";
  const bad: [string, string][] = [
    ["S1 literal with a query", `${BASE}/settings/billing?x=1`],
    ["S3 another path", `${BASE}/billing/success`],
    ["S6 split template", `${BASE}/settings/${"billing"}?checkout=other`],
    ["S7 joined array", [BASE, "settings", "billing"].join("/") + "?checkout=success&x=1"],
    ["S8 concatenation with the constant", evil + API_BILLING_RETURN_PATHS.plan],
    ["S9 the right path on a different base", U(API_BILLING_RETURN_PATHS.plan, evil)],
    ["S10 an extra query", U(API_BILLING_RETURN_PATHS.plan) + "&x=1"],
    ["S10b the suffix plus an extra query", U(API_BILLING_RETURN_PATHS.plan) + SID + "&x=1"],
    ["S16 the helper with a literal path", billingReturnUrl(BASE, "/settings/billing?x=1")],
    ["empty", ""],
  ];
  it.each(bad)("%s is refused for every kind, and logged", (_n, url) => {
    for (const kind of ["success", "embedded_return", "cancel", "portal"] as const) {
      expect(() => assertBillingReturnUrl(kind, url, BASE)).toThrow(InternalServerErrorException);
    }
    expect(logged).toHaveBeenCalled();
  });
  it("S7 as written: the joined array of the bare Billing page is refused for every kind but the portal", () => {
    const url = [BASE, "settings", "billing"].join("/");
    expect(() => assertBillingReturnUrl("success", url, BASE)).toThrow();
    expect(() => assertBillingReturnUrl("cancel", url, BASE)).toThrow();
    expect(() => assertBillingReturnUrl("embedded_return", url, BASE)).toThrow();
    expect(() => assertBillingReturnUrl("portal", url, BASE)).not.toThrow(); // the portal's own, right address
  });
  it("each kind refuses the other kinds' addresses", () => {
    expect(() =>
      assertBillingReturnUrl("cancel", U(API_BILLING_RETURN_PATHS.plan), BASE),
    ).toThrow();
    expect(() => assertBillingReturnUrl("success", U(API_BILLING_CANCEL_PATH), BASE)).toThrow();
    expect(() => assertBillingReturnUrl("portal", U(API_BILLING_RETURN_PATHS.pay), BASE)).toThrow();
    expect(() =>
      assertBillingReturnUrl("success", U(API_BILLING_PORTAL_RETURN_PATH), BASE),
    ).toThrow();
  });
  it("S11 a local alias of the constant is a correct value, and passes", () => {
    const P = API_BILLING_RETURN_PATHS.plan;
    expect(() => assertBillingReturnUrl("success", billingReturnUrl(BASE, P), BASE)).not.toThrow();
  });
  it("a mismatch logs ONE ERROR line: code, kind, the address received, the allowed list, the tenant; the client sees a plain 500", () => {
    let err: any;
    try {
      assertBillingReturnUrl("success", "https://evil.test/", BASE, "tenant_9");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(err.message).toBe("Billing return address is not allowed.");
    expect(JSON.stringify(err.getResponse())).not.toContain("evil.test");
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0][0]);
    expect(line).toContain("BILLING_RETURN_URL_MISMATCH");
    expect(line).toContain("kind=success");
    expect(line).toContain("received=https://evil.test/");
    expect(line).toContain("tenant=tenant_9");
    for (const ok of okSuccess) expect(line).toContain(ok);
    expect(line.includes(String.fromCharCode(10))).toBe(false);
  });
  it("the log redacts a concrete session_id and keeps the {CHECKOUT_SESSION_ID} template", () => {
    expect(() =>
      assertBillingReturnUrl(
        "success",
        U(API_BILLING_RETURN_PATHS.plan) + "&session_id=cs_live_SECRET&x=1",
        BASE,
      ),
    ).toThrow();
    const line = String(logged.mock.calls[0][0]);
    expect(line).toContain(
      "received=https://app.test/settings/billing?checkout=success&session_id=<redacted>&x=1",
    );
    expect(line).not.toContain("cs_live_SECRET");
    // the allowed list still shows the literal template
    expect(line).toContain("session_id={CHECKOUT_SESSION_ID}");
    logged.mockClear();
    expect(() =>
      assertBillingReturnUrl("success", U(API_BILLING_RETURN_PATHS.plan) + SID + "&x=1", BASE),
    ).toThrow();
    expect(String(logged.mock.calls[0][0])).toContain(
      "received=https://app.test/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}&x=1",
    );
  });
  it("the line carries no customer id and no payment value", () => {
    expect(() => assertBillingReturnUrl("portal", "https://evil.test/", BASE, "t1")).toThrow();
    expect(String(logged.mock.calls[0][0])).not.toMatch(/cus_|pm_|card/i);
  });
});

describe("per-site rows: the real withCheckoutPolicy and StripeService, a fake client", () => {
  const saved = process.env.WEB_URL;
  const savedUi = process.env.BILLING_CHECKOUT_UI;
  beforeEach(() => {
    process.env.WEB_URL = "https://app.test";
    delete process.env.BILLING_CHECKOUT_UI;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WEB_URL;
    else process.env.WEB_URL = saved;
    if (savedUi === undefined) delete process.env.BILLING_CHECKOUT_UI;
    else process.env.BILLING_CHECKOUT_UI = savedUi;
  });
  const base = () => webBaseUrl();
  const params = (success_url: string, cancel_url: string) => ({
    mode: "subscription" as const,
    customer: "cus_1",
    line_items: [{ price: "price_1", quantity: 1 }],
    success_url,
    cancel_url,
  });
  const cancel = () => billingReturnUrl(base(), API_BILLING_CANCEL_PATH);

  it.each([
    ["plan Checkout (tenant self / super-admin / platform-admin)", API_BILLING_RETURN_PATHS.plan],
    ["catch-up pay", API_BILLING_RETURN_PATHS.pay],
    ["catch-up card add", API_BILLING_RETURN_PATHS.cardAdd],
  ])("hosted %s: the session carries the Billing address and the cancel address", (_n, p) => {
    const out = withCheckoutPolicy(params(billingReturnUrl(base(), p), cancel()), {
      surface: "ADMIN_LINK",
    }) as any;
    expect(out.success_url).toBe(`https://app.test${p}`);
    expect(out.cancel_url).toBe("https://app.test/settings/billing?checkout=cancelled");
  });

  it.each([
    ["plan Checkout", API_BILLING_RETURN_PATHS.plan],
    ["catch-up pay", API_BILLING_RETURN_PATHS.pay],
    ["catch-up card add", API_BILLING_RETURN_PATHS.cardAdd],
  ])("embedded %s: return_url is the Billing address plus the one session_id", (_n, p) => {
    process.env.BILLING_CHECKOUT_UI = "embedded";
    const out = withCheckoutPolicy(params(billingReturnUrl(base(), p), cancel()), {
      surface: "TENANT_SELF",
    }) as any;
    expect(out.return_url).toBe(`https://app.test${p}&session_id={CHECKOUT_SESSION_ID}`);
    expect(out).not.toHaveProperty("success_url");
  });

  it.each([
    ["hosted", undefined],
    ["embedded", "embedded"],
  ])("S6 planted in a site's success address (%s): refused, nothing reaches Stripe", (_m, ui) => {
    if (ui) process.env.BILLING_CHECKOUT_UI = ui;
    const page = "billing";
    const planted = `${base()}/settings/${page}?checkout=wrong`;
    expect(() => withCheckoutPolicy(params(planted, cancel()), { surface: "TENANT_SELF" })).toThrow(
      InternalServerErrorException,
    );
  });
  it("hosted: a planted cancel address is refused too", () => {
    expect(() =>
      withCheckoutPolicy(
        params(
          billingReturnUrl(base(), API_BILLING_RETURN_PATHS.plan),
          `${base()}/settings/billing?x=1`,
        ),
        { surface: "ADMIN_LINK" },
      ),
    ).toThrow(InternalServerErrorException);
  });

  function stripeWithFake() {
    const create = jest.fn(async () => ({ url: "https://billing.stripe.test/p/s" }));
    const svc = new StripeService({ get: () => undefined } as never);
    (svc as any).stripe = { billingPortal: { sessions: { create } } };
    return { svc, create };
  }
  it("portal: the fake receives the Billing page address", async () => {
    const { svc, create } = stripeWithFake();
    await svc.createBillingPortalSession({
      customerId: "cus_1",
      returnUrl: billingReturnUrl(base(), API_BILLING_PORTAL_RETURN_PATH),
    });
    expect((create.mock.calls[0] as any[])[0].return_url).toBe("https://app.test/settings/billing");
  });
  it("portal: a planted address is refused BEFORE the client is called", async () => {
    const { svc, create } = stripeWithFake();
    await expect(
      svc.createBillingPortalSession({ customerId: "cus_1", returnUrl: "https://evil.test/x" }),
    ).rejects.toThrow(InternalServerErrorException);
    expect(create).not.toHaveBeenCalled();
  });
});
