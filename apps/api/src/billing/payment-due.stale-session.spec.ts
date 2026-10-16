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
    tenantAddon: { findMany: jest.fn(async () => []) },
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
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => ({
      planKey: "GROWTH",
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
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => ({ lineItems: [], skus: [], invalid: [] })),
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
    setPrice: (p: number) => {
      price = p;
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
