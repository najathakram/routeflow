/**
 * SA-733r3 N2 — the catch-up CLAIM against real Postgres (DB lane). What the in-memory spec cannot prove:
 *   - the claim's CAS and the Tenant row lock actually serialise: two concurrent `openClaim` => exactly one wins;
 *   - a `markPaid` that was ALREADY waiting on the Tenant lock when the claim committed is refused (409), i.e. the
 *     claim is read AFTER the lock - not from the row read before it (the "under the RfInvoice lock" row);
 *   - the paid path voids with the real unique (tenantId, periodKey) index and the real `periodKey` suffix;
 *   - a release walks the real columns (stripeSubId null, externalPayment true, ids kept until Step 4).
 * Stripe is the stateful fake (no network). Throwaway `qa-*` tenants.
 */
import { randomUUID } from "crypto";
import { Client, Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { CatchupClaimService } from "./catchup-claim.service";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { ADMIN_AUDIT_ENTITY } from "../platform-admin/audit-actions.constant";
import { BillingEventService } from "./billing-event.service";
import { RfInvoicesAdminService } from "../platform-admin/rf-invoices.service";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";
import { API_ERROR_CODES } from "../common/api-error-codes";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-733r3 N2 catch-up claim (real Postgres)", () => {
  let url: string;
  let pool: Pool;
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });

  afterAll(async () => {
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
    await pool.end();
  });

  async function tenant(tag: string, sub: Record<string, unknown> = {}) {
    const slug = assertTestTenant(`qa-cu-${tag}-${run}`, "catchup-claim.db.spec.ts");
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({
      data: { tenantId: t.id, planKey: "GROWTH", externalPayment: true, ...sub },
    });
    return t.id;
  }

  async function rfInvoice(tenantId: string, start: string, end: string, status = "OPEN") {
    const periodKey = new Date(start).toISOString();
    return prisma.rfInvoice.create({
      data: {
        tenantId,
        number: `RF-2099-${run}-${++seq}`,
        amount: 149,
        status,
        periodStart: new Date(start),
        periodEnd: new Date(end),
        periodKey,
        dueDate: new Date(start),
      },
    });
  }

  const sub = (tenantId: string) =>
    prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
  const svcWith = (stripe = fakeStripeCatchup()) =>
    ({
      stripe,
      svc: new CatchupClaimService(
        prisma as any,
        stripe as any,
        new BillingEventService(prisma as any),
      ),
    }) as const;

  it("two concurrent openClaim: exactly one wins (CAS under the Tenant lock), the loser gets the coded 409", async () => {
    const id = await tenant("race");
    const { svc } = svcWith();
    const results = await Promise.allSettled([
      svc.openClaim(id),
      svc.openClaim(id),
      svc.openClaim(id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason.getResponse()).toMatchObject({
        code: API_ERROR_CODES.CATCHUP_SESSION_OPEN,
      });
    }
    expect((await sub(id)).catchupState).toBe("SESSION_OPEN");
  });

  it("a tenant with a Stripe subscription, or one not on manual invoicing, cannot open a claim", async () => {
    const withSub = await tenant("hassub", { stripeSubId: "sub_x" });
    const card = await tenant("card", { externalPayment: false });
    const { svc } = svcWith();
    await expect(svc.openClaim(withSub)).rejects.toMatchObject({ status: 409 });
    await expect(svc.openClaim(card)).rejects.toMatchObject({ status: 409 });
    expect((await sub(withSub)).catchupState).toBeNull();
  });

  it("markPaid that is WAITING on the Tenant lock when the claim commits is refused (the claim is read after the lock)", async () => {
    const id = await tenant("lock");
    const inv = await rfInvoice(id, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const admin = new RfInvoicesAdminService(
      prisma as any,
      {} as any,
      {} as any,
      new CatchupClaimService(prisma as any, {} as any, new BillingEventService(prisma as any)),
    );

    // T2 plays openClaim: it holds the Tenant lock and has NOT written the claim yet.
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    await t2.query("BEGIN");
    await t2.query('SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE', [id]);

    const pay = admin.markPaid(inv.id, { method: "CASH" }, "sa-1", new Date());
    pay.catch(() => undefined);

    // markPaid must be BLOCKED behind T2's lock (asserted, not timed): poll pg_locks until a waiter appears.
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const q = await pool.query(
        `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.query ILIKE '%FROM "Tenant"%FOR UPDATE%'`,
      );
      blocked = q.rowCount! > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 25));
    }
    expect(blocked).toBe(true);

    // T2 writes the claim and commits: markPaid proceeds, re-reads the claim under the lock, and refuses.
    await t2.query(
      `UPDATE "TenantSubscription" SET "catchupState" = 'SESSION_OPEN' WHERE "tenantId" = $1`,
      [id],
    );
    await t2.query("COMMIT");
    await t2.end();

    await expect(pay).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_SESSION_OPEN },
    });
    const after = await prisma.rfInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe("OPEN");
  });

  it("with no claim, markPaid records the payment", async () => {
    const id = await tenant("nopaid");
    const inv = await rfInvoice(id, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const admin = new RfInvoicesAdminService(
      prisma as any,
      {} as any,
      {} as any,
      new CatchupClaimService(prisma as any, {} as any, new BillingEventService(prisma as any)),
    );
    await expect(
      admin.markPaid(inv.id, { method: "CASH" }, "sa-1", new Date()),
    ).resolves.toMatchObject({
      status: "PAID",
    });
  });

  it("the paid path voids the OPEN invoices with the real periodKey suffix, leaves the PAID one, clears the claim once", async () => {
    const id = await tenant("paid", {
      stripeSubId: "sub_paid",
      externalPayment: false,
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupSessionId: "cs_paid",
      catchupInvoiceId: "in_paid",
    });
    const oct = await rfInvoice(id, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const nov = await rfInvoice(id, "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z");
    const stripe = fakeStripeCatchup({
      sessions: {
        cs_paid: {
          id: "cs_paid",
          subscription: "sub_paid",
          status: "complete",
          // SA-733r10 MF-A: settle voids from the session's own S (never a recompute of paid coverage)
          metadata: {
            catchup_from: "2026-10-01T12:00:00.000Z",
            catchup_to: "2026-12-01T12:00:00.000Z",
          },
        },
      },
    });
    const { svc } = svcWith(stripe);

    await svc.onInvoicePaid({
      id: "in_paid",
      amount_paid: 14900,
      parent: { subscription_details: { subscription: "sub_paid" } },
    });

    const rows = await prisma.rfInvoice.findMany({
      where: { tenantId: id },
      orderBy: { periodStart: "asc" },
    });
    expect(rows.map((r) => r.status)).toEqual(["VOID", "VOID"]);
    expect(rows[0].periodKey).toBe(`${oct.periodKey}:void:${oct.id}`);
    expect(rows[1].periodKey).toBe(`${nov.periodKey}:void:${nov.id}`);
    expect(await sub(id)).toMatchObject({
      catchupState: null,
      catchupSessionId: null,
      catchupInvoiceId: null,
    });

    // a replay finds no claim: nothing more is written
    await svc.onInvoicePaid({
      id: "in_paid",
      amount_paid: 14900,
      parent: { subscription_details: { subscription: "sub_paid" } },
    });
    const audits = await prisma.auditLog.count({
      where: { tenantId: id, action: "RF_INVOICE_VOIDED" },
    });
    expect(audits).toBe(2);
  });

  it("a release walks the real columns in order and leaves the RfInvoices untouched", async () => {
    const id = await tenant("rel", {
      stripeSubId: "sub_rel",
      externalPayment: false,
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupSessionId: "cs_rel",
      catchupInvoiceId: "in_rel",
    });
    const oct = await rfInvoice(id, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const stripe = fakeStripeCatchup({
      invoices: [
        {
          id: "in_rel",
          status: "open",
          subscription: "sub_rel",
          amountDue: 14900,
          attemptCount: 4,
          nextPaymentAttempt: null,
        },
      ],
      sessions: { cs_rel: { id: "cs_rel", subscription: "sub_rel", status: "complete" } },
      // the release cancels a LIVE subscription exactly once; a subscription Stripe does not know (the fake's
      // default) is "gone" and is rightly never cancelled, so the fixture must seed it
      subs: { sub_rel: { id: "sub_rel", customer: "cus_rel", status: "active" } },
    });
    const { svc } = svcWith(stripe);
    const seen: unknown[] = [];
    stripe.voidInvoice.mockImplementationOnce(async (invId: string) => {
      seen.push(await sub(id)); // the DB as Stripe is asked to void
      stripe.invoices.get(invId)!.status = "void";
      return { id: invId, status: "void" };
    });

    expect(await svc.release(id, { sessionId: "cs_rel", reason: "db-test" })).toBe("released");

    expect(seen[0]).toMatchObject({
      stripeSubId: null,
      externalPayment: true,
      catchupState: "RELEASING",
      catchupSessionId: "cs_rel",
      catchupInvoiceId: "in_rel",
    });
    expect(await sub(id)).toMatchObject({
      stripeSubId: null,
      externalPayment: true,
      catchupState: null,
      catchupSessionId: null,
      catchupInvoiceId: null,
    });
    expect(stripe.cancelSubscription).toHaveBeenCalledTimes(1);
    expect((await prisma.rfInvoice.findUniqueOrThrow({ where: { id: oct.id } })).status).toBe(
      "OPEN",
    );
  });

  it("b2b review: the release resets the coupon columns through coupon-state.ts (couponFull/couponId/couponEndsAt)", async () => {
    const id = await tenant("cpn", {
      stripeSubId: "sub_cpn",
      externalPayment: false,
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupSessionId: "cs_cpn",
      catchupInvoiceId: "in_cpn",
      couponFull: true,
      couponId: "co_100",
      couponEndsAt: new Date("2027-01-01T00:00:00Z"),
    });
    const stripe = fakeStripeCatchup({
      invoices: [
        {
          id: "in_cpn",
          status: "open",
          subscription: "sub_cpn",
          amountDue: 100,
          attemptCount: 4,
          nextPaymentAttempt: null,
        },
      ],
      sessions: { cs_cpn: { id: "cs_cpn", subscription: "sub_cpn", status: "complete" } },
      subs: { sub_cpn: { id: "sub_cpn", customer: "cus_cpn", status: "active" } },
    });
    const { svc } = svcWith(stripe);
    expect(await svc.release(id, { sessionId: "cs_cpn", reason: "db-test" })).toBe("released");
    expect(await sub(id)).toMatchObject({
      stripeSubId: null,
      externalPayment: true,
      couponFull: false,
      couponId: null,
      couponEndsAt: null,
    });
  });

  it("SA-733r5: trial_one_time settle voids every OPEN invoice ending after paid-through (October + November), PAID September kept", async () => {
    const id = await tenant("r5", {
      stripeSubId: "sub_r5",
      externalPayment: false,
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupSessionId: "cs_r5",
      catchupInvoiceId: "in_r5",
    });
    const sep = await rfInvoice(id, "2026-09-01T12:00:00Z", "2026-10-01T12:00:00Z", "PAID");
    const oct = await rfInvoice(id, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const nov = await rfInvoice(id, "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z");
    const { svc } = svcWith(
      fakeStripeCatchup({
        sessions: {
          cs_r5: {
            id: "cs_r5",
            subscription: "sub_r5",
            status: "complete",
            // settle reads S from the session: Sep is PAID (kept), so S = Oct 1
            metadata: {
              catchup_from: "2026-10-01T12:00:00.000Z",
              catchup_to: "2026-12-01T12:00:00.000Z",
            },
          },
        },
      }),
    );
    await svc.onInvoicePaid({
      id: "in_r5",
      amount_paid: 31000,
      parent: { subscription_details: { subscription: "sub_r5" } },
    });
    const byId = async (rid: string) =>
      (await prisma.rfInvoice.findUniqueOrThrow({ where: { id: rid } })).status;
    expect(await byId(sep.id)).toBe("PAID");
    expect(await byId(oct.id)).toBe("VOID");
    expect(await byId(nov.id)).toBe("VOID");
    expect((await sub(id)).catchupState).toBeNull();
  });

  it("Opus B1 (real SQL): SESSION_OPEN + an ORDINARY subscription's paid first invoice voids nothing and adopts nothing", async () => {
    const id = await tenant("b1", {
      stripeSubId: "sub_ord",
      externalPayment: true,
      catchupState: "SESSION_OPEN",
      catchupSessionId: "cs_b1",
    });
    const oct = await rfInvoice(id, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const { svc } = svcWith(
      fakeStripeCatchup({
        sessions: { cs_b1: { id: "cs_b1", subscription: "sub_catchup", status: "open" } },
      }),
    );
    await svc.onInvoicePaid({
      id: "in_ord",
      amount_paid: 12000,
      billing_reason: "subscription_create",
      parent: { subscription_details: { subscription: "sub_ord" } },
    });
    expect((await prisma.rfInvoice.findUniqueOrThrow({ where: { id: oct.id } })).status).toBe(
      "OPEN",
    );
    expect(await sub(id)).toMatchObject({
      catchupState: "SESSION_OPEN",
      catchupSessionId: "cs_b1",
      catchupInvoiceId: null,
      externalPayment: true,
    });
  });

  it("expiry releases only the matching SESSION_OPEN claim; a completed claim is never released by it", async () => {
    const open = await tenant("exp1", { catchupState: "SESSION_OPEN", catchupSessionId: "cs_exp" });
    const done = await tenant("exp2", {
      stripeSubId: "sub_d",
      externalPayment: false,
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupSessionId: "cs_done",
    });
    const { svc } = svcWith();
    await svc.onSessionExpired({ id: "cs_exp", metadata: { tenantId: open, catchup: "period" } });
    await svc.onSessionExpired({ id: "cs_done", metadata: { tenantId: done, catchup: "period" } });
    expect((await sub(open)).catchupState).toBeNull();
    expect((await sub(done)).catchupState).toBe("AWAITING_FIRST_PAYMENT");
    expect((await sub(done)).stripeSubId).toBe("sub_d");
  });

  it("the CHECK constraint refuses an unknown state", async () => {
    const id = await tenant("chk");
    await expect(
      prisma.tenantSubscription.update({ where: { tenantId: id }, data: { catchupState: "DONE" } }),
    ).rejects.toThrow();
  });

  it("SA-733r10 MF-A (real SQL): activation [Oct 12, Nov 11) + PAID [Nov 11, Dec 1) (Zelle) - S = A = Dec 1 at creation; settle at completion voids the OPEN [Dec 1, Jan 1) ONCE from the session's catchup_from and leaves both PAID rows alone", async () => {
    const id = await tenant("mfa");
    const START = "2026-10-12T04:08:24Z";
    const MID = "2026-11-11T04:08:24Z";
    // the activation: marker (with the recorded period) + the post-commit trail row seconds later
    await prisma.auditLog.createMany({
      data: [
        {
          tenantId: id,
          action: "TENANT_MANUAL_ACTIVATION_MARKER",
          entityType: ADMIN_AUDIT_ENTITY,
          entityId: id,
          meta: { periodStart: START, periodEnd: MID },
          createdAt: new Date(START),
        },
        {
          tenantId: id,
          action: "TENANT_SUBSCRIPTION_ACTIVATED",
          entityType: ADMIN_AUDIT_ENTITY,
          entityId: id,
          meta: { periodEnd: MID },
          createdAt: new Date(new Date(START).getTime() + 3000),
        },
      ],
    });
    const paidActivation = await rfInvoice(id, START, MID, "PAID");
    const paidZelle = await rfInvoice(id, MID, "2026-12-01T12:00:00Z", "PAID");
    const openDec = await rfInvoice(id, "2026-12-01T12:00:00Z", "2027-01-01T12:00:00Z");

    const stripe = fakeStripeCatchup({
      subs: {
        sub_mfa: {
          id: "sub_mfa",
          customer: "cus_mfa",
          status: "trialing",
          latest_invoice: null,
          default_payment_method: "pm_mfa",
        },
      },
    });
    const claim = new CatchupClaimService(
      prisma as any,
      stripe as any,
      new BillingEventService(prisma as any),
    );
    const checkout = new CatchupCheckoutService(
      prisma as any,
      stripe as any,
      {
        resolveTenantPricing: async () => ({
          planKey: "GROWTH",
          monthly: 100,
          source: "override",
          currency: "usd",
        }),
        checkoutPriceData: async () => ({
          currency: "usd",
          unit_amount: 10000,
          recurring: { interval: "month" },
          product_data: { name: "RouteFlow Growth - monthly" },
        }),
      } as any,
      { checkoutAddonLines: async () => ({ lineItems: [], skus: [] }) } as any,
      claim,
      { ensureStripeCustomer: async () => "cus_mfa" } as any,
    );

    // creation: paid through Dec 1 12:00Z (one walk over the activation + the PAID RfInvoice), S = A = Dec 1
    const now = new Date("2026-11-20T10:00:00Z");
    const report = await checkout.plan(id, now);
    expect(report.plan).toMatchObject({ ok: true, shape: "trial" });
    if (!report.plan.ok) throw new Error("unreachable");
    expect(report.plan.stub.from.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(report.plan.stub.to.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(report.plan.stub.totalCents).toBe(0);
    const out = await checkout.open(id, { now, expectedStubCents: 0 });
    const params = stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.metadata.catchup_from).toBe("2026-12-01T12:00:00.000Z");
    expect(params.metadata.catchup_to).toBe("2026-12-01T12:00:00.000Z");

    // completion: the ordinary handler stored the subscription; the claim service settles AT COMPLETION
    await prisma.tenantSubscription.update({
      where: { tenantId: id },
      data: { stripeSubId: "sub_mfa" },
    });
    stripe.sessions[out.sessionId] = {
      ...stripe.sessions[out.sessionId],
      status: "complete",
      subscription: "sub_mfa",
      customer: "cus_mfa",
      payment_status: "no_payment_required",
      expires_at: Math.floor(new Date("2026-11-21T10:00:00Z").getTime() / 1000),
    };
    await claim.onSessionCompleted(stripe.sessions[out.sessionId]);

    const status = async (rid: string) =>
      (await prisma.rfInvoice.findUniqueOrThrow({ where: { id: rid } })).status;
    expect(await status(openDec.id)).toBe("VOID");
    expect(await status(paidActivation.id)).toBe("PAID");
    expect(await status(paidZelle.id)).toBe("PAID");
    expect(await sub(id)).toMatchObject({ catchupState: null, externalPayment: false });
    expect(
      await prisma.auditLog.count({ where: { tenantId: id, action: "RF_INVOICE_VOIDED" } }),
    ).toBe(1);
    // a redelivery changes nothing more
    await claim.onSessionCompleted(stripe.sessions[out.sessionId]);
    expect(
      await prisma.auditLog.count({ where: { tenantId: id, action: "RF_INVOICE_VOIDED" } }),
    ).toBe(1);
  });
});
