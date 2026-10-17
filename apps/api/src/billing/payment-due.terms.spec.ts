import { ValidationPipe } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { PaymentDuePayDto } from "./dto/payment-due-pay.dto";
import { PaymentDueService } from "./payment-due.service";

/**
 * Row 542c (SA-806 follow-up, the SA-796 precondition pattern): `pay` re-plans at the click, so a banner loaded before
 * D = A - 72 h but clicked after it would open Checkout on the NEW terms. The client sends the terms the banner showed;
 * the server COMPARES them with the fresh plan (the same read that decides eligibility) and refuses a mismatch with
 * 409 PAYMENT_TERMS_CHANGED, creating, releasing and claiming nothing. The client value is only compared, never charged.
 * Real planner, real service, real claim; only the database and Stripe are stand-ins.
 */
const NOW = new Date("2026-10-09T10:00:00Z");
const NOV_1 = "2026-11-01T12:00:00.000Z";
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
    catchup,
    setPrice: (p: number) => {
      price = p;
    },
  };
}

const TERMS_CHANGED = { response: { code: API_ERROR_CODES.PAYMENT_TERMS_CHANGED } };

/** Nothing was created, claimed, released, audited or locked. */
function expectUntouched(t: ReturnType<typeof make>) {
  expect(t.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  expect(t.stripe.calls).toEqual([]);
  expect(t.db.subs[0].catchupState).toBeNull();
  expect(t.db.audits).toHaveLength(0);
  expect(t.db.locks).toHaveLength(0);
}

const quoteOf = (v: {
  amountCents: number;
  periodStart: string | null;
  cardBy: string | null;
}) => ({
  amountCents: v.amountCents,
  periodStart: v.periodStart,
  cardBy: v.cardBy,
});

describe("542c R1: a card-add banner loaded before D, clicked after D", () => {
  it("is 409 PAYMENT_TERMS_CHANGED with zero sessions created and the claim untouched", async () => {
    const t = make();
    // the page loaded at A - 73 h showed the $0 card add
    expect(await t.svc.get("t1", BEFORE_D)).toMatchObject({ cardNeeded: true, cardBy: OCT_29 });
    // one second after D the planner quotes next month's bill instead
    await expect(t.svc.pay("t1", AFTER_D, CARD_QUOTE)).rejects.toMatchObject(TERMS_CHANGED);
    expectUntouched(t);
  });

  it("the new banner then shows the new terms, and paying THAT quote works", async () => {
    const t = make();
    const fresh = await t.svc.get("t1", AFTER_D);
    expect(fresh).toMatchObject({ due: true, amountCents: 31000, periodStart: NOV_1 });
    const out = await t.svc.pay("t1", AFTER_D, quoteOf(fresh));
    expect(out.checkoutUrl).toMatch(/^https:\/\/pay\.test\//);
  });
});

describe("542c R2: a 'Pay $X' banner whose figure changed at the click", () => {
  it("a changed price is 409, nothing created", async () => {
    const t = make([OCT_OPEN]);
    const shown = await t.svc.get("t1", NOW);
    expect(shown.due).toBe(true);
    t.setPrice(400);
    await expect(t.svc.pay("t1", NOW, quoteOf(shown))).rejects.toMatchObject(TERMS_CHANGED);
    expectUntouched(t);
  });

  it("a different period is 409 even at the same amount", async () => {
    const t = make([OCT_OPEN]);
    const shown = await t.svc.get("t1", NOW);
    await expect(
      t.svc.pay("t1", NOW, { ...quoteOf(shown), periodStart: "2026-09-01T12:00:00.000Z" }),
    ).rejects.toMatchObject(TERMS_CHANGED);
    expectUntouched(t);
  });

  it("a 'Pay $X' banner clicked after the tenant became card-needed is 409 (the kind changed)", async () => {
    const t = make([OCT_OPEN]);
    const shown = await t.svc.get("t1", NOW);
    // the October bill is paid elsewhere: the planner now quotes the $0 card add
    t.db.invoices.splice(0, t.db.invoices.length, OCT_PAID);
    await expect(t.svc.pay("t1", NOW, quoteOf(shown))).rejects.toMatchObject(TERMS_CHANGED);
    expectUntouched(t);
  });

  it("nothing due any more stays PAYMENT_NOT_DUE (the eligibility refusal wins over the quote)", async () => {
    const t = make([OCT_PAID], 0);
    await expect(
      t.svc.pay("t1", NOW, { amountCents: 100, periodStart: null, cardBy: null }),
    ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.PAYMENT_NOT_DUE } });
  });
});

describe("542c R3: matching terms work exactly as today", () => {
  it("the card add the banner showed: ONE session, and a second click reuses it", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const create = t.stripe.client.checkout.sessions.create as jest.Mock;
    expect(create).toHaveBeenCalledTimes(1);
    const id = String(t.db.subs[0].catchupSessionId);
    const live = (t.stripe as any).sessions[id];
    live.url = first.checkoutUrl;
    live.expires_at = Math.floor(BEFORE_D.getTime() / 1000) + 3600;
    expect(await t.svc.pay("t1", BEFORE_D, CARD_QUOTE)).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("the bill the banner showed pays, and the same instant in another ISO spelling still matches", async () => {
    const t = make([OCT_OPEN]);
    const shown = await t.svc.get("t1", NOW);
    const out = await t.svc.pay("t1", NOW, {
      ...quoteOf(shown),
      periodStart: new Date(shown.periodStart as string).toISOString().replace("Z", "+00:00"),
    });
    expect(out.checkoutUrl).toMatch(/^https:\/\/pay\.test\//);
  });

  it("no precondition (an older cached page): today's behaviour, for one release", async () => {
    const t = make();
    const out = await t.svc.pay("t1", NOW);
    expect(out.checkoutUrl).toMatch(/^https:\/\/pay\.test\//);
  });

  it("the quote is checked BEFORE an open session is reused: a stale quote never gets the old session's url", async () => {
    const t = make();
    const first = await t.svc.pay("t1", BEFORE_D, CARD_QUOTE);
    const id = String(t.db.subs[0].catchupSessionId);
    const live = (t.stripe as any).sessions[id];
    live.url = first.checkoutUrl;
    live.expires_at = Math.floor(AFTER_D.getTime() / 1000) + 3600;
    await expect(t.svc.pay("t1", AFTER_D, CARD_QUOTE)).rejects.toMatchObject(TERMS_CHANGED);
    expect(t.db.subs[0].catchupState).toBe("SESSION_OPEN"); // untouched: not released, not replaced
    expect(t.stripe.client.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });
});

describe("542c R6: the client value is compared, never charged", () => {
  it("open() still gets the planner's own stub total", async () => {
    const t = make([OCT_OPEN]);
    const shown = await t.svc.get("t1", NOW);
    const open = jest.spyOn(t.catchup, "open");
    await t.svc.pay("t1", NOW, quoteOf(shown));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][1].expectedStubCents).toBe(shown.amountCents);
    const params = (t.stripe.client.checkout.sessions.create as jest.Mock).mock.calls[0][0];
    expect(params.metadata.catchup_stub_cents).toBe(String(shown.amountCents));
  });

  it("a wrong amount cannot steer the price: it is refused and open() is never called", async () => {
    const t = make([OCT_OPEN]);
    const open = jest.spyOn(t.catchup, "open");
    await expect(
      t.svc.pay("t1", NOW, {
        amountCents: 1,
        periodStart: "2026-10-01T12:00:00.000Z",
        cardBy: null,
      }),
    ).rejects.toMatchObject(TERMS_CHANGED);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("542c R4: the body is validated (class-validator, whitelist, no extras)", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const run = (body: unknown) =>
    pipe.transform(body, { type: "body", metatype: PaymentDuePayDto, data: "" });

  it.each([
    ["an empty body (older pages)", {}],
    ["a card-add quote", { shown: CARD_QUOTE }],
    [
      "a bill quote",
      { shown: { amountCents: 31000, periodStart: "2026-11-01T12:00:00.000Z", cardBy: null } },
    ],
  ])("accepts %s", async (_n, body) => {
    await expect(run(body)).resolves.toBeDefined();
  });

  it.each([
    ["amount as a string", { shown: { ...CARD_QUOTE, amountCents: "0" } }],
    ["a fractional amount", { shown: { ...CARD_QUOTE, amountCents: 10.5 } }],
    ["a negative amount", { shown: { ...CARD_QUOTE, amountCents: -1 } }],
    ["no amount", { shown: { periodStart: null, cardBy: OCT_29 } }],
    ["cardBy not a date", { shown: { ...CARD_QUOTE, cardBy: "soon" } }],
    ["periodStart a number", { shown: { ...CARD_QUOTE, periodStart: 5 } }],
    ["periodStart omitted", { shown: { amountCents: 0, cardBy: OCT_29 } }],
    ["shown not an object", { shown: "0" }],
    ["an unknown key beside shown", { shown: CARD_QUOTE, price: 1 }],
    ["an unknown key inside shown", { shown: { ...CARD_QUOTE, tenantId: "t2" } }],
  ])("rejects %s with a 400", async (_n, body) => {
    await expect(run(body)).rejects.toMatchObject({ status: 400 });
  });
});
