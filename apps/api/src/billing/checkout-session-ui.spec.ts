import { Logger } from "@nestjs/common";
import {
  CHECKOUT_PAYMENT_METHODS_ENV,
  CHECKOUT_UI_ENV,
  CheckoutPolicyViolation,
  checkoutStartFromSession,
  checkoutUiMode,
  withCheckoutPolicy,
} from "./checkout-session-params";

/**
 * SA-1139 PR-1, cases 1-9: the ops switch BILLING_CHECKOUT_UI and the required `surface` of withCheckoutPolicy.
 * Pure params in, params out: no Stripe client, no network.
 */
const BASE = {
  mode: "subscription" as const,
  customer: "cus_1",
  line_items: [{ price: "price_1", quantity: 1 }],
  metadata: { tenantId: "t1" },
  subscription_data: { trial_end: 1_800_000_000 },
};
const WITH_RETURN = {
  ...BASE,
  success_url: "https://app.test/settings/billing?checkout=success",
  cancel_url: "https://app.test/settings/billing?checkout=cancelled",
};
const HOSTED_OUT = { ...WITH_RETURN, managed_payments: { enabled: false } };

describe("withCheckoutPolicy x BILLING_CHECKOUT_UI (SA-1139 R1)", () => {
  const prior = process.env[CHECKOUT_UI_ENV];
  const priorPm = process.env[CHECKOUT_PAYMENT_METHODS_ENV];
  beforeEach(() => {
    delete process.env[CHECKOUT_UI_ENV];
    delete process.env[CHECKOUT_PAYMENT_METHODS_ENV];
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[CHECKOUT_UI_ENV];
    else process.env[CHECKOUT_UI_ENV] = prior;
    if (priorPm === undefined) delete process.env[CHECKOUT_PAYMENT_METHODS_ENV];
    else process.env[CHECKOUT_PAYMENT_METHODS_ENV] = priorPm;
  });

  it("case 1: switch unset -> exactly today's params, key for key (success_url and cancel_url, no ui_mode)", () => {
    const out = withCheckoutPolicy(WITH_RETURN, { surface: "TENANT_SELF" });
    expect(out).toEqual(HOSTED_OUT);
    expect(Object.keys(out).sort()).toEqual(
      [...Object.keys(WITH_RETURN), "managed_payments"].sort(),
    );
    expect(out).not.toHaveProperty("ui_mode");
    expect(out).not.toHaveProperty("return_url");
    expect(out).not.toHaveProperty("redirect_on_completion");
    expect(checkoutUiMode("TENANT_SELF")).toBe("hosted");
  });

  it("case 2: switch embedded, TENANT_SELF -> embedded_page, if_required, return_url, no success_url or cancel_url", () => {
    process.env[CHECKOUT_UI_ENV] = "embedded";
    const out = withCheckoutPolicy(WITH_RETURN, { surface: "TENANT_SELF" });
    expect(out.ui_mode).toBe("embedded_page");
    expect(out.redirect_on_completion).toBe("if_required");
    expect(out.return_url).toBe(
      "https://app.test/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
    );
    expect(out).not.toHaveProperty("success_url");
    expect(out).not.toHaveProperty("cancel_url");
    expect(checkoutUiMode("TENANT_SELF")).toBe("embedded");
  });

  it("case 2: a success_url that already carries session_id gets no second one; no query string gets ?", () => {
    process.env[CHECKOUT_UI_ENV] = "embedded";
    const has = withCheckoutPolicy(
      { ...BASE, success_url: "https://app.test/billing/success?session_id={CHECKOUT_SESSION_ID}" },
      { surface: "TENANT_SELF" },
    );
    expect(has.return_url).toBe(
      "https://app.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
    );
    const bare = withCheckoutPolicy(
      { ...BASE, success_url: "https://app.test/billing/success" },
      { surface: "TENANT_SELF" },
    );
    expect(bare.return_url).toBe(
      "https://app.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
    );
  });

  it("case 5: switch embedded, ADMIN_LINK -> hosted, the same params as unset", () => {
    process.env[CHECKOUT_UI_ENV] = "embedded";
    expect(withCheckoutPolicy(WITH_RETURN, { surface: "ADMIN_LINK" })).toEqual(HOSTED_OUT);
    expect(checkoutUiMode("ADMIN_LINK")).toBe("hosted");
  });

  it("case 6: switch embedded -> managed_payments off and payment_method_types exactly as hosted", () => {
    process.env[CHECKOUT_UI_ENV] = "embedded";
    process.env[CHECKOUT_PAYMENT_METHODS_ENV] = "card_and_bank";
    const emb = withCheckoutPolicy(WITH_RETURN, { surface: "TENANT_SELF" });
    const host = withCheckoutPolicy(WITH_RETURN, { surface: "ADMIN_LINK" });
    expect(emb.managed_payments).toEqual({ enabled: false });
    expect(emb.payment_method_types).toEqual(["card", "us_bank_account"]);
    expect(emb.payment_method_types).toEqual(host.payment_method_types);
  });

  it("case 7: embedded differs from hosted ONLY in the return keys (anchor, expires_at, items, metadata identical)", () => {
    const full = {
      ...WITH_RETURN,
      expires_at: 1_790_000_000,
      subscription_data: {
        billing_cycle_anchor: 1_793_000_000,
        proration_behavior: "create_prorations" as const,
        metadata: { tenantId: "t1" },
      },
      line_items: [
        { price_data: { currency: "usd", unit_amount: 9900 }, quantity: 1 },
        { price_data: { currency: "usd", unit_amount: 1900 }, quantity: 1 },
      ],
    };
    const hosted: Record<string, unknown> = {
      ...withCheckoutPolicy(full, { surface: "TENANT_SELF" }),
    };
    process.env[CHECKOUT_UI_ENV] = "embedded";
    const emb: Record<string, unknown> = {
      ...withCheckoutPolicy(full, { surface: "TENANT_SELF" }),
    };
    for (const k of ["success_url", "cancel_url"]) delete hosted[k];
    for (const k of ["ui_mode", "return_url", "redirect_on_completion"]) delete emb[k];
    expect(emb).toEqual(hosted);
  });

  it.each([
    ["Embedded ", "embedded_page"],
    ["EMBEDDED", "embedded_page"],
    ["hosted", undefined],
    ["", undefined],
    ["   ", undefined],
  ])("case 8: switch %j -> ui_mode %s, no warning", (raw, want) => {
    process.env[CHECKOUT_UI_ENV] = raw;
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      expect(withCheckoutPolicy(WITH_RETURN, { surface: "TENANT_SELF" }).ui_mode).toBe(want);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("case 8: an unknown value is hosted and warns ONCE per value", () => {
    process.env[CHECKOUT_UI_ENV] = "popup";
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const first = withCheckoutPolicy(WITH_RETURN, { surface: "TENANT_SELF" });
      withCheckoutPolicy(WITH_RETURN, { surface: "TENANT_SELF" });
      expect(first).toEqual(HOSTED_OUT);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("popup");
    } finally {
      warn.mockRestore();
    }
  });

  it("case 9: a missing or unknown surface throws (a JS caller; TypeScript refuses it at compile time)", () => {
    const loose = withCheckoutPolicy as unknown as (p: unknown, o?: unknown) => unknown;
    expect(() => loose(WITH_RETURN)).toThrow(CheckoutPolicyViolation);
    expect(() => loose(WITH_RETURN, {})).toThrow(CheckoutPolicyViolation);
    expect(() => loose(WITH_RETURN, { surface: "tenant" })).toThrow(CheckoutPolicyViolation);
  });

  it("embedded without a success_url throws: a redirect-based method could not return", () => {
    process.env[CHECKOUT_UI_ENV] = "embedded";
    expect(() => withCheckoutPolicy(BASE, { surface: "TENANT_SELF" })).toThrow(
      CheckoutPolicyViolation,
    );
  });
});

describe("checkoutStartFromSession (SA-1139 R3)", () => {
  const savedWeb = process.env.WEB_URL;
  beforeEach(() => {
    process.env.WEB_URL = "https://app.test";
  });
  afterEach(() => {
    if (savedWeb === undefined) delete process.env.WEB_URL;
    else process.env.WEB_URL = savedWeb;
  });

  it("a hosted session -> uiMode hosted, checkoutUrl set, clientSecret null", () => {
    expect(checkoutStartFromSession({ id: "cs_1", url: "https://pay.test/cs_1" })).toEqual({
      uiMode: "hosted",
      sessionId: "cs_1",
      checkoutUrl: "https://pay.test/cs_1",
      clientSecret: null,
      returnPath: null,
    });
  });

  it("an embedded session -> uiMode embedded, clientSecret set, checkoutUrl null", () => {
    expect(
      checkoutStartFromSession({
        id: "cs_2",
        url: null,
        ui_mode: "embedded_page",
        client_secret: "cs_2_secret_test",
        return_url: "https://app.test/settings/billing?paid=1&session_id={CHECKOUT_SESSION_ID}",
      }),
    ).toEqual({
      uiMode: "embedded",
      sessionId: "cs_2",
      checkoutUrl: null,
      clientSecret: "cs_2_secret_test",
      returnPath: "/settings/billing?paid=1",
    });
  });

  it("an embedded session that came back without a client_secret throws", () => {
    expect(() =>
      checkoutStartFromSession({
        id: "cs_3",
        url: null,
        ui_mode: "embedded_page",
        client_secret: null,
      }),
    ).toThrow(/client_secret/);
  });

  it("a hosted session that came back without a url throws", () => {
    expect(() => checkoutStartFromSession({ id: "cs_4", url: null })).toThrow(/url/);
  });
});

describe("checkoutStartFromSession x returnPath (SA-1154)", () => {
  const saved = { web: process.env.WEB_URL, front: process.env.FRONTEND_URL };
  beforeEach(() => {
    process.env.WEB_URL = "https://app.test";
    delete process.env.FRONTEND_URL;
  });
  afterEach(() => {
    if (saved.web === undefined) delete process.env.WEB_URL;
    else process.env.WEB_URL = saved.web;
    if (saved.front === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = saved.front;
  });

  const embedded = (returnUrl: unknown) => ({
    id: "cs_r",
    url: null,
    ui_mode: "embedded_page",
    client_secret: "cs_r_secret_test",
    return_url: returnUrl as string | null | undefined,
  });

  it.each([
    ["plan", "https://app.test/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}"],
    ["pay", "https://app.test/settings/billing?paid=1&session_id={CHECKOUT_SESSION_ID}"],
    [
      "card add",
      "https://app.test/settings/billing?paid=1&card=1&session_id={CHECKOUT_SESSION_ID}",
    ],
  ])("an embedded %s session -> its own return_url without session_id", (name, url) => {
    const out = checkoutStartFromSession(embedded(url));
    const expected = {
      plan: "/settings/billing?checkout=success",
      pay: "/settings/billing?paid=1",
      "card add": "/settings/billing?paid=1&card=1",
    }[name];
    expect(out).toMatchObject({ uiMode: "embedded", returnPath: expected });
  });

  it("a session_id that Stripe already filled in is removed too", () => {
    const out = checkoutStartFromSession(
      embedded("https://app.test/settings/billing?paid=1&card=1&session_id=cs_r"),
    );
    expect(out).toMatchObject({ returnPath: "/settings/billing?paid=1&card=1" });
  });

  it("a hosted session answers returnPath null (Stripe's own redirect carries the return)", () => {
    const out = checkoutStartFromSession({
      id: "cs_h",
      url: "https://pay.test/cs_h",
      success_url: "https://app.test/settings/billing?paid=1",
    } as Parameters<typeof checkoutStartFromSession>[0]);
    expect(out).toMatchObject({ uiMode: "hosted", returnPath: null });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    [
      "another origin",
      "https://evil.example/settings/billing?paid=1&session_id={CHECKOUT_SESSION_ID}",
    ],
    [
      "a look-alike origin",
      "https://app.test.evil.example/settings/billing?paid=1&session_id={CHECKOUT_SESSION_ID}",
    ],
    ["a scheme-relative address", "//evil.example/x"],
  ])("O9: an embedded session whose return_url is %s throws", (_label, url) => {
    expect(() => checkoutStartFromSession(embedded(url))).toThrow(/return_url/);
  });

  it("O9: the refusal never echoes the client secret", () => {
    try {
      checkoutStartFromSession(embedded(undefined));
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret_test");
    }
  });
});
