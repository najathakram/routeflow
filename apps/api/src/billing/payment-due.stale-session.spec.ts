import { API_ERROR_CODES } from "../common/api-error-codes";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { PaymentDueService } from "./payment-due.service";

/**
 * Row 542d: the STORED session is the stale one. `pay` compares the banner with the fresh plan (542c) and that
 * passes, but a live, unexpired Checkout session created BEFORE the terms changed still carries the old terms. Real
 * planner, real service, real claim; only the database and Stripe are stand-ins. A live session is reused only when
 * its stub cents, shape, catchup_from (S) and catchup_to (A) equal the fresh plan's; otherwise Stripe expires it, the
 * claim is released only after that, and ONE new session is priced on the fresh plan.
 */
const NOW = new Date("2026-10-09T10:00:00Z");
const NOV_1 = "2026-11-01T12:00:00.000Z";
const DEC_1 = "2026-12-01T12:00:00.000Z";
const OCT_29 = "2026-10-29T12:00:00.000Z";
const HOUR = 3600_000;
const AFTER_D = new Date(Date.parse(OCT_29) + 1000);
const BEFORE_D = new Date(Date.parse(NOV_1) - 73 * HOUR);
const OCT_PAID = {
  id: "inv_oct",
  tenantId: "t1",
  status: "PAID",
  number: "RF-1",
  periodStart: new Date("2026-10-01T12:00:00Z"),
  periodEnd: new Date("2026-11-01T12:00:00Z"),
  periodKey: "k1",
};
const OCT_OPEN = { ...OCT_PAID, id: "inv_oct_open", status: "OPEN", periodKey: "k2" };
const CARD_QUOTE = { amountCents: 0, periodStart: null, cardBy: OCT_29 };

function make(invoices: Record<string, unknown>[] = [OCT_PAID], monthly = 310) {
  const db = fakeCatchupDb({ subs: [{ tenantId: "t1", planKey: "GROWTH" }], invoices });
  const prisma: any = {
    ...db.prisma,
    // the planner checks the billable ROWS against the lines the card will bill (MF1): they mirror each other here
    tenantAddon: {
      findMany: jest.fn(async () =>
        addons.lineItems.map((li: any) => ({
          sku: li.price_data.product_data.metadata.addonSku,
          addonKey: null,
          quantity: li.quantity,
          priceSnapshot: li.price_data.unit_amount / 100,
        })),
      ),
    },
    tenantConfig: { findUnique: jest.fn(async () => ({ timezone: "America/New_York" })) },
    tenant: {
      findUnique: jest.fn(async () => ({
        id: "t1",
        slug: "qa-acme",
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
      })),
    },
  };
  const stripe = fakeStripeCatchup();
  let price = monthly;
  let planKey = "GROWTH";
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => ({
      planKey,
      monthly: price,
      source: "catalog",
      currency: "usd",
    })),
    checkoutPriceData: jest.fn(async () => ({
      currency: "usd",
      unit_amount: Math.round(price * 100),
      recurring: { interval: "month" },
      product_data: { name: "RouteFlow Growth" },
    })),
  };
  let addons: { lineItems: any[]; skus: string[]; invalid: any[] } = {
    lineItems: [],
    skus: [],
    invalid: [],
  };
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => addons),
    recordInvalidCatalogAddons: jest.fn(async () => undefined),
  };
  const claim = new CatchupClaimService(prisma, stripe as any, { emit: jest.fn() } as any);
  const billing: any = { ensureStripeCustomer: jest.fn(async () => "cus_1") };
  const catchup = new CatchupCheckoutService(
    prisma,
    stripe as any,
    pricing,
    mutations,
    claim,
    billing,
  );
  const svc = new PaymentDueService(prisma, catchup, claim, stripe as any);
  return {
    svc,
    db,
    stripe,
    claim,
    catchup,
    setAddons: (lineItems: any[], skus: string[]) => {
      addons = { lineItems, skus, invalid: [] };
    },
    setPrice: (p: number) => {
      price = p;
    },
    setPlanKey: (k: string) => {
      planKey = k;
    },
  };
}

type Harness = ReturnType<typeof make>;

const quoteOf = (v: {
  amountCents: number;
  periodStart: string | null;
  cardBy: string | null;
}) => ({
  amountCents: v.amountCents,
  periodStart: v.periodStart,
  cardBy: v.cardBy,
});

/** Stripe's live session: the fake carries no url or expiry of its own, a real open session has both. */
function goLive(t: Harness, at: Date, url: string): string {
  const id = String(t.db.subs[0].catchupSessionId);
  const live = (t.stripe as any).sessions[id];
  live.url = url;
  live.expires_at = Math.floor(at.getTime() / 1000) + 23 * 3600;
  return id;
}

const createCalls = (t: Harness) =>
  (t.stripe.client.checkout.sessions.create as jest.Mock).mock.calls;

const expireCalls = (t: Harness) =>
  t.stripe.calls.filter((c) => c.startsWith("expireCheckoutSession"));

describe("542d R1: the Oct 29 card-add session, clicked at D + 1 s", () => {
  it("expires the old $0 session, releases the claim only after, then creates ONE session priced on next month's stub", async () => {
    const t = make();
    const realRelease = t.claim.onSessionExpired.bind(t.claim);
    const release = jest.spyOn(t.claim, "onSessionExpired").mockImplementation(async (s: any) => {
      t.stripe.calls.push(`release:${s.id}`);
      return realRelease(s);
    });
    // created at A - 73 h: the $0 trial-shape card add, catchup_to = Nov 1
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    expect(createCalls(t)[0][0].metadata).toMatchObject({
      catchup_stub_cents: "0",
      catchup_shape: "trial",
      catchup_to: NOV_1,
    });

    // one second after D the planner quotes next month's bill; the banner the admin sees is the fresh one
    const fresh = await t.svc.get("t1", AFTER_D);
    expect(fresh).toMatchObject({ due: true, amountCents: 31000, periodStart: NOV_1 });
    const out = await t.svc.pay("t1", AFTER_D, quoteOf(fresh));

    // never the old session's url
    expect(out.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(createCalls(t)).toHaveLength(2);
    expect(expireCalls(t)).toEqual([`expireCheckoutSession:${oldId}`]);
    // order: create(old) ... expire(old) -> release(old) -> create(new)
    const log = t.stripe.calls.filter(
      (c) => c === "sessions.create" || c.startsWith("expire") || c.startsWith("release"),
    );
    expect(log).toEqual([
      "sessions.create",
      `expireCheckoutSession:${oldId}`,
      `release:${oldId}`,
      "sessions.create",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect((t.stripe as any).sessions[oldId].status).toBe("expired");

    // the new session carries the fresh plan's terms
    const params = createCalls(t)[1][0];
    expect(params.metadata).toMatchObject({
      catchup_stub_cents: "31000",
      catchup_shape: "trial_one_time",
      catchup_from: NOV_1,
      catchup_to: DEC_1,
    });
    expect(params.success_url).toMatch(/\/settings\/billing\?paid=1$/);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
    expect(t.db.subs[0].catchupSessionId).not.toBe(oldId);
    expect(out.checkoutUrl).toMatch(new RegExp(`/${t.db.subs[0].catchupSessionId}$`));
  });
});

describe("542d R2: an open 'Pay $X' session whose figure no longer matches", () => {
  it("is expired and replaced by ONE session at the fresh price", async () => {
    const t = make([OCT_OPEN]);
    const first = await t.svc.pay("t1", NOW);
    const oldId = goLive(t, NOW, first.checkoutUrl);
    expect(createCalls(t)[0][0].metadata.catchup_stub_cents).toBe("31000");

    t.setPrice(400); // the tenant's price changed after the session was opened
    const fresh = await t.svc.get("t1", NOW);
    expect(fresh.amountCents).toBe(40000);
    const out = await t.svc.pay("t1", NOW, quoteOf(fresh));

    expect(out.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(expireCalls(t)).toEqual([`expireCheckoutSession:${oldId}`]);
    expect(createCalls(t)).toHaveLength(2);
    expect(createCalls(t)[1][0].metadata.catchup_stub_cents).toBe("40000");
    expect(t.db.subs[0].catchupSessionId).not.toBe(oldId);
  });
});

describe("542d R3: a session whose terms still match is reused untouched", () => {
  it("card add: no expire, no release, no second create", async () => {
    const t = make([OCT_PAID]);
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    goLive(t, BEFORE_D, first.checkoutUrl);
    expect(await t.svc.pay("t1", BEFORE_D, CARD_QUOTE)).toEqual(first);
    expect(createCalls(t)).toHaveLength(1);
    expect(expireCalls(t)).toEqual([]);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
  });

  it("stub bill: no expire, no release, no second create", async () => {
    const t = make([OCT_OPEN]);
    const first = await t.svc.pay("t1", NOW);
    goLive(t, NOW, first.checkoutUrl);
    expect(await t.svc.pay("t1", NOW)).toEqual(first);
    expect(createCalls(t)).toHaveLength(1);
    expect(expireCalls(t)).toEqual([]);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
  });
});

describe("542d R4: the old session completes first -> the claim's refusal, never a second session", () => {
  it("the expire is rejected (paid in the gap), the re-read says complete: AWAITING_FIRST_PAYMENT, claim untouched", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    // the admin pays the OLD session in the gap between our read and our expire
    (t.stripe.expireCheckoutSession as jest.Mock).mockImplementationOnce(async () => {
      t.stripe.calls.push(`expireCheckoutSession:${oldId}`);
      (t.stripe as any).sessions[oldId].status = "complete";
      throw new Error("This Checkout Session is not in an open state.");
    });
    const fresh = await t.svc.get("t1", AFTER_D);
    await expect(t.svc.pay("t1", AFTER_D, quoteOf(fresh))).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_PENDING },
    });
    expect(createCalls(t)).toHaveLength(1);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
    expect(t.db.subs[0].catchupSessionId).toBe(oldId);
  });
});

describe("542d R5: a mismatch whose expiry Stripe cannot confirm is a 503, nothing touched", () => {
  it("the expire fails on the network and the re-read still says open", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    (t.stripe.expireCheckoutSession as jest.Mock).mockRejectedValueOnce(new Error("ECONNRESET"));
    const fresh = await t.svc.get("t1", AFTER_D);
    await expect(t.svc.pay("t1", AFTER_D, quoteOf(fresh))).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN },
    });
    expect(createCalls(t)).toHaveLength(1);
    expect(t.db.subs[0].catchupSessionId).toBe(oldId);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
  });
});

describe("542d R6: a live session with no readable terms is unknown, never guessed", () => {
  it("503 PAYMENT_STATE_UNKNOWN, Stripe not told to expire, claim and session untouched", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    (t.stripe as any).sessions[oldId].metadata = { tenantId: "t1", catchup: "prepaid" };
    await expect(t.svc.pay("t1", BEFORE_D, CARD_QUOTE)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN },
    });
    expect(expireCalls(t)).toEqual([]);
    expect(createCalls(t)).toHaveLength(1);
    expect(t.db.subs[0].catchupSessionId).toBe(oldId);
  });
});

const ADDON_LINE = {
  price_data: {
    currency: "usd",
    unit_amount: 2500,
    recurring: { interval: "month" },
    product_data: { name: "Scan", metadata: { addonSku: "scan" } },
  },
  quantity: 1,
};

describe("542d nit 1 (SA-800c): the session reuse check signs EVERY term (price, add-ons, forgiven line)", () => {
  it("(a) a $310 card add, then the operator sets $100: the unchanged banner no longer reuses it; ONE new session at the $100 recurring", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    expect(createCalls(t)[0][0].line_items[0].price_data.unit_amount).toBe(31000);

    t.setPrice(100);
    // the banner is unchanged (still the $0 card add): the quote check passes
    expect(await t.svc.get("t1", BEFORE_D)).toMatchObject({ cardNeeded: true, cardBy: OCT_29 });
    const out = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);

    expect(out.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(expireCalls(t)).toEqual([`expireCheckoutSession:${oldId}`]);
    expect(createCalls(t)).toHaveLength(2);
    const params = createCalls(t)[1][0];
    expect(params.line_items[0].price_data.unit_amount).toBe(10000);
    expect(params.metadata.catchup_terms_sig).toMatch(/^[0-9a-f]{64}$/);
    expect(params.metadata.catchup_terms_sig).not.toBe(
      createCalls(t)[0][0].metadata.catchup_terms_sig,
    );
    expect(t.db.subs[0].catchupSessionId).not.toBe(oldId);
  });

  it("(b) a forgiven line whose forgiven cents change is replaced too", async () => {
    const t = make([], 0.1); // October unpaid at 10 cents: forgiven (under $0.50), a $0-now card add
    const shown = await t.svc.get("t1", NOW);
    expect(shown).toMatchObject({ due: false, cardNeeded: true });
    const first = await t.svc.pay("t1", NOW, quoteOf(shown));
    const oldId = goLive(t, NOW, first.checkoutUrl);
    expect(createCalls(t)[0][0].metadata.catchup_forgiven_cents).toBe("10");

    t.setPrice(0.2);
    const out = await t.svc.pay("t1", NOW, quoteOf(await t.svc.get("t1", NOW)));
    expect(out.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(expireCalls(t)).toEqual([`expireCheckoutSession:${oldId}`]);
    expect(createCalls(t)).toHaveLength(2);
    expect(createCalls(t)[1][0].metadata.catchup_forgiven_cents).toBe("20");
  });

  it.each([
    ["an add-on added after the session was opened", false],
    ["an add-on removed after the session was opened", true],
  ])("(c) %s", async (_n, startWithAddon) => {
    const t = make();
    if (startWithAddon) t.setAddons([ADDON_LINE], ["scan"]);
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);

    if (startWithAddon) t.setAddons([], []);
    else t.setAddons([ADDON_LINE], ["scan"]);
    const out = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);

    expect(out.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(expireCalls(t)).toEqual([`expireCheckoutSession:${oldId}`]);
    expect(createCalls(t)).toHaveLength(2);
    const lines = createCalls(t)[1][0].line_items;
    expect(lines).toHaveLength(startWithAddon ? 1 : 2);
  });

  it("(f, C1) a live session with NO signature (created before it existed) is never reused: Stripe-confirmed expire, release, ONE new SIGNED session", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    delete (t.stripe as any).sessions[oldId].metadata.catchup_terms_sig;
    const out = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    expect(out.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(expireCalls(t)).toEqual([`expireCheckoutSession:${oldId}`]);
    expect((t.stripe as any).sessions[oldId].status).toBe("expired");
    expect(createCalls(t)).toHaveLength(2);
    expect(createCalls(t)[1][0].metadata.catchup_terms_sig).toMatch(/^[0-9a-f]{64}$/);
    expect(t.db.subs[0].catchupSessionId).not.toBe(oldId);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
  });

  it("(SA-800d a) an unsigned session open BEFORE the deploy is expired and a SIGNED one created; the NEXT click reuses that one (no second expire)", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    const old = (t.stripe as any).sessions[oldId];
    delete old.metadata.catchup_terms_sig;
    old.created = Math.floor(Date.parse("2026-10-16T00:00:00Z") / 1000); // before SIGNING_SINCE

    const second = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    expect(second.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(expireCalls(t)).toEqual([`expireCheckoutSession:${oldId}`]);
    expect(createCalls(t)).toHaveLength(2);
    expect(createCalls(t)[1][0].metadata.catchup_terms_sig).toMatch(/^[0-9a-f]{64}$/);

    goLive(t, BEFORE_D, second.checkoutUrl);
    expect(await t.svc.pay("t1", BEFORE_D, CARD_QUOTE)).toEqual(second);
    expect(expireCalls(t)).toHaveLength(1); // no second expire
    expect(createCalls(t)).toHaveLength(2);
  });

  it("(SA-800d b) an unsigned session that has already COMPLETED: AWAITING_FIRST_PAYMENT, no expire, no release, no second session", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    const old = (t.stripe as any).sessions[oldId];
    delete old.metadata.catchup_terms_sig;
    old.status = "complete";
    const release = jest.spyOn(t.claim, "onSessionExpired");
    await expect(t.svc.pay("t1", BEFORE_D, CARD_QUOTE)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_PENDING },
    });
    expect(expireCalls(t)).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(createCalls(t)).toHaveLength(1);
    expect(t.db.subs[0].catchupSessionId).toBe(oldId);
  });

  it("(SA-800d b) an unsigned session paid in the gap (the expire is refused as complete): AWAITING_FIRST_PAYMENT, no release, no second session", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    delete (t.stripe as any).sessions[oldId].metadata.catchup_terms_sig;
    (t.stripe.expireCheckoutSession as jest.Mock).mockImplementationOnce(async () => {
      t.stripe.calls.push(`expireCheckoutSession:${oldId}`);
      (t.stripe as any).sessions[oldId].status = "complete";
      throw new Error("This Checkout Session is not in an open state.");
    });
    const release = jest.spyOn(t.claim, "onSessionExpired");
    await expect(t.svc.pay("t1", BEFORE_D, CARD_QUOTE)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_PENDING },
    });
    expect(release).not.toHaveBeenCalled();
    expect(createCalls(t)).toHaveLength(1);
    expect(t.db.subs[0].catchupSessionId).toBe(oldId);
  });

  it("(SA-800d d / N5) a plan KEY change at the same name and price recreates the session", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    expect(createCalls(t)[0][0].metadata.planKey).toBe("GROWTH");
    t.setPlanKey("PRO");
    const out = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    expect(out.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(expireCalls(t)).toEqual([`expireCheckoutSession:${oldId}`]);
    expect(createCalls(t)).toHaveLength(2);
    expect(createCalls(t)[1][0].metadata.planKey).toBe("PRO");
    expect(createCalls(t)[1][0].line_items).toEqual(createCalls(t)[0][0].line_items);
  });

  it("(f, C1) a MALFORMED signature is unknown: 503, Stripe not told to expire, claim untouched", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const oldId = goLive(t, BEFORE_D, first.checkoutUrl);
    (t.stripe as any).sessions[oldId].metadata.catchup_terms_sig = "not-a-hash";
    await expect(t.svc.pay("t1", BEFORE_D, CARD_QUOTE)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN },
    });
    expect(expireCalls(t)).toEqual([]);
    expect(createCalls(t)).toHaveLength(1);
    expect(t.db.subs[0].catchupSessionId).toBe(oldId);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
  });

  it.each([
    ["a card add", [OCT_PAID], NOW, CARD_QUOTE],
    ["a stub bill", [OCT_OPEN], NOW, undefined],
  ] as const)(
    "(N8) %s created at one instant and reused 20 h later (inside its 23 h life, terms unchanged): reused, no expire",
    async (_n, invoices, at, quote) => {
      const t = make([...invoices]);
      const first = await t.svc.pay("t1", at, quote);
      goLive(t, at, first.checkoutUrl);
      const later = new Date(at.getTime() + 20 * HOUR);
      // the banner has not changed; only `now` moved, and the expected side must not depend on it
      expect(await t.svc.pay("t1", later, quote)).toEqual(first);
      expect(expireCalls(t)).toEqual([]);
      expect(createCalls(t)).toHaveLength(1);
      expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
    },
  );

  it("(c-guard) nothing changed, add-on included: the session is reused, no expire", async () => {
    const t = make();
    t.setAddons([ADDON_LINE], ["scan"]);
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    goLive(t, BEFORE_D, first.checkoutUrl);
    expect(await t.svc.pay("t1", BEFORE_D, CARD_QUOTE)).toEqual(first);
    expect(expireCalls(t)).toEqual([]);
    expect(createCalls(t)).toHaveLength(1);
  });
});

describe("542d nit 2: the lost-race path never expires a FRESHER winner", () => {
  afterEach(() => jest.useRealTimers());

  /** Only Date is faked: promises, timers and the event loop run for real. */
  const clockAt = (d: Date) =>
    jest.useFakeTimers({
      now: d,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });

  it("click A planned before D loses the claim to click B planned after D: A returns B's url, no expire", async () => {
    const t = make();
    const realOpen = t.catchup.open.bind(t.catchup);
    let bUrl = "";
    jest.spyOn(t.catchup, "open").mockImplementationOnce(async (...args: any[]) => {
      // click B (after D) wins the claim between A's read and A's create
      const b = await t.svc.pay("t1", AFTER_D, quoteOf(await t.svc.get("t1", AFTER_D)));
      bUrl = b.checkoutUrl;
      goLive(t, AFTER_D, bUrl);
      return (realOpen as any)(...args); // A's create now loses to the held claim
    });
    clockAt(AFTER_D); // the re-plan inside A's race path reads the wall clock
    const out = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    expect(out).toEqual({ checkoutUrl: bUrl });
    expect(createCalls(t)).toHaveLength(1); // B's session only
    expect(expireCalls(t)).toEqual([]);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN");
  });
});
