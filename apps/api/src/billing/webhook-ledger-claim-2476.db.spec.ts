/**
 * #2476 / SA-472 / SA-472a — real Postgres. Both Stripe webhook ledgers insert with one raw
 * INSERT … ON CONFLICT DO NOTHING and take a redelivered event EXCLUSIVELY with one raw UPDATE
 * (common/webhook-ledger-claim.ts): an "error:" row at once, a NULL (in-flight) row only once its
 * 5-minute lease has expired — processedAt and the lease both on the DATABASE clock. The outcome write
 * is fenced on the holder's processedAt token, so a worker whose lease was taken over cannot overwrite. Not claimed: a completed row is a 200 duplicate;
 * one still in flight elsewhere is a 503 that never runs the handler.
 *
 * The controllers run for real on a real PrismaClient, and each delivery gets its own pool connection.
 * The concurrency cases hold delivery A INSIDE its handler (a gate) while delivery B arrives — the entry
 * condition is asserted (A's handler has started and not finished), never timed. The payment_failed
 * case uses the real BillingService: A is held at the admin email, AFTER its failedPaymentCount
 * increment, and B's redelivery must not increment again.
 *
 * Throwaway `qa-*` tenants (assertTestTenant); afterAll deletes what it made. DB lane — run by F2.
 */
import { randomUUID } from "crypto";
import { Prisma, PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { HttpStatus } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { WEBHOOK_CLAIM_LEASE_MS } from "../common/webhook-ledger-claim";
import { BillingWebhookController } from "./billing-webhook.controller";
import { BillingService } from "./billing.service";
import { BillingEventService } from "./billing-event.service";
import { ConnectWebhookController } from "../payment-requests/connect-webhook.controller";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2476 webhook ledger exclusive claim on redelivery (real Postgres, SA-472)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const billingIds: string[] = [];
  const connectIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });

  afterAll(async () => {
    await prisma.stripeBillingEvent.deleteMany({ where: { id: { in: billingIds } } });
    await prisma.stripeConnectEvent.deleteMany({ where: { id: { in: connectIds } } });
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
    await pool.end();
  });

  /** A deferred the test resolves to let a held handler finish. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    return { open, opened };
  }

  function res() {
    const out: { status?: number; body?: unknown } = {};
    const r = {
      status: (s: number) => {
        out.status = s;
        return { json: (b: unknown) => (out.body = b) };
      },
    };
    return { r, out };
  }
  const req = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };

  /** The billing controller over real Prisma with a controllable handler. */
  function billingController(event: { id: string; type: string }, handle: () => Promise<void>) {
    billingIds.push(event.id);
    const stripe = {
      isConfigured: true,
      constructWebhookEvent: () => ({ ...event, created: 1_700_000_000 }),
    };
    const calls = { n: 0 };
    const billing = {
      handleWebhookEvent: async () => {
        calls.n += 1;
        await handle();
      },
    };
    return {
      ctl: new BillingWebhookController(stripe as any, billing as any, prisma as any),
      calls,
    };
  }

  /** Seeds a ledger row whose claim is `ageMs` old on the DATABASE clock (the clock the lease reads). */
  async function seedBillingRow(id: string, outcome: string | null, ageMs: number) {
    billingIds.push(id);
    await prisma.$executeRaw(Prisma.sql`INSERT INTO "StripeBillingEvent"
      ("id", "type", "createdAt", "processedAt", "outcome")
      VALUES (${id}, 'invoice.paid', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - ${`${ageMs} milliseconds`}::interval, ${outcome})`);
  }

  /** Ages an existing row's claim to `ageMs` on the database clock. */
  async function ageBillingRow(id: string, ageMs: number) {
    await prisma.$executeRaw(Prisma.sql`UPDATE "StripeBillingEvent"
      SET "processedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - ${`${ageMs} milliseconds`}::interval
      WHERE "id" = ${id}`);
  }

  async function dbNowUtc(): Promise<Date> {
    const [r] = await prisma.$queryRaw<{ now: Date }[]>(
      Prisma.sql`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS "now"`,
    );
    return r.now;
  }

  it("two concurrent deliveries ⇒ exactly one handler run, the other 503, one ledger row", async () => {
    const id = `evt_2476_conc_${run}`;
    const g = gate();
    let startedA = false;
    const { ctl, calls } = billingController({ id, type: "invoice.paid" }, async () => {
      startedA = true;
      await g.opened;
    });
    const a = res();
    const pA = ctl.handleWebhook(req as any, a.r as any);
    for (let i = 0; i < 400 && !startedA; i++) await new Promise((x) => setTimeout(x, 10));
    expect(startedA).toBe(true); // ENTRY: A holds the row, in flight

    const b = res();
    await ctl.handleWebhook(req as any, b.r as any);
    g.open();
    await pA;

    const row = await prisma.stripeBillingEvent.findUniqueOrThrow({ where: { id } });
    expect({ runs: calls.n, a: a.out.status, b: b.out.status, outcome: row.outcome }).toEqual({
      runs: 1,
      a: HttpStatus.OK,
      b: HttpStatus.SERVICE_UNAVAILABLE,
      outcome: "processed",
    });
    expect(await prisma.stripeBillingEvent.count({ where: { id } })).toBe(1);
  });

  it.each([
    [
      "NULL older than the lease (a crashed worker)",
      null,
      WEBHOOK_CLAIM_LEASE_MS + 60_000,
      1,
      HttpStatus.OK,
    ],
    ["NULL younger than the lease (in flight)", null, 60_000, 0, HttpStatus.SERVICE_UNAVAILABLE],
    ['an "error:" row (claimable at once)', "error:boom", 1_000, 1, HttpStatus.OK],
    ['a "processed" row (a duplicate)', "processed", 1_000, 0, HttpStatus.OK],
  ])(
    "billing redelivery onto %s (outcome %s, age %i ms) ⇒ handler runs %i time(s), status %i",
    async (_l, outcome, age, runs, status) => {
      const id = `evt_2476_${String(outcome).replace(/[^a-z]/gi, "")}_${age}_${run}`;
      await seedBillingRow(id, outcome as string | null, age as number);
      const { ctl, calls } = billingController({ id, type: "invoice.paid" }, async () => undefined);
      const o = res();
      await ctl.handleWebhook(req as any, o.r as any);
      expect({ runs: calls.n, status: o.out.status }).toEqual({ runs, status });
    },
  );

  it("SA-472a: the first delivery's processedAt is the DATABASE clock (UTC), and the createdAt round-trips", async () => {
    const id = `evt_2476_dbclock_${run}`;
    const { ctl } = billingController({ id, type: "invoice.paid" }, async () => undefined);
    const before = await dbNowUtc();
    const o = res();
    await ctl.handleWebhook(req as any, o.r as any);
    const after = await dbNowUtc();
    const row = await prisma.stripeBillingEvent.findUniqueOrThrow({ where: { id } });
    expect(o.out.status).toBe(HttpStatus.OK);
    expect(row.processedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.processedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(row.createdAt.toISOString()).toBe("2023-11-14T22:13:20.000Z"); // created 1_700_000_000
    expect(row.outcome).toBe("processed");
  });

  it("SA-472a FENCE: a worker whose lease was taken over cannot overwrite the new holder's outcome", async () => {
    const id = `evt_2476_fence_${run}`;
    const g = gate();
    let startedA = false;
    let n = 0;
    // A: held, then FAILS. B (after A's lease expires): succeeds.
    const { ctl, calls } = billingController({ id, type: "invoice.paid" }, async () => {
      n += 1;
      if (n === 1) {
        startedA = true;
        await g.opened;
        throw new Error("A failed late");
      }
    });
    const a = res();
    const pA = ctl.handleWebhook(req as any, a.r as any);
    for (let i = 0; i < 400 && !startedA; i++) await new Promise((x) => setTimeout(x, 10));
    expect(startedA).toBe(true); // ENTRY: A holds the row, in flight

    await ageBillingRow(id, WEBHOOK_CLAIM_LEASE_MS + 60_000); // A's lease expires (DB clock)
    const b = res();
    await ctl.handleWebhook(req as any, b.r as any); // B re-claims and completes
    g.open();
    await pA; // A's fenced write must match 0 rows

    const row = await prisma.stripeBillingEvent.findUniqueOrThrow({ where: { id } });
    expect({ runs: calls.n, a: a.out.status, b: b.out.status, outcome: row.outcome }).toEqual({
      runs: 2,
      a: HttpStatus.INTERNAL_SERVER_ERROR,
      b: HttpStatus.OK,
      outcome: "processed", // B's result stands; A's late "error:" never lands
    });
  });

  // SA-472b: on a session whose time zone is NOT UTC, a bare now() stored in the TIMESTAMP(3) column
  // would be New York wall time (hours off the UTC convention). The one fragment keeps it UTC.
  it("SA-472b: on a SET TIME ZONE 'America/New_York' session, insert → claim stays on UTC and the fence matches", async () => {
    const nyPool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 2 });
    nyPool.on("connect", (c) => {
      void c.query("SET TIME ZONE 'America/New_York'");
    });
    const ny = new PrismaClient({ adapter: new PrismaPg(nyPool) });
    try {
      const [{ TimeZone: tz }] = await ny.$queryRaw<{ TimeZone: string }[]>(
        Prisma.sql`SHOW TIME ZONE`,
      );
      expect(tz).toBe("America/New_York"); // ENTRY: the session really is non-UTC

      /** The DB's UTC now, TZ-independent (epoch), not via the fragment under test. */
      const utcNowMs = async () => {
        const [r] = await ny.$queryRaw<{ e: number }[]>(
          Prisma.sql`SELECT extract(epoch FROM CURRENT_TIMESTAMP)::float8 AS "e"`,
        );
        return r.e * 1000;
      };

      const id = `evt_2476_ny_${run}`;
      billingIds.push(id);
      let n = 0;
      const stripe = {
        isConfigured: true,
        constructWebhookEvent: () => ({ id, type: "invoice.paid", created: 1_700_000_000 }),
      };
      const billing = {
        handleWebhookEvent: async () => {
          n += 1;
          if (n === 1) throw new Error("first attempt fails"); // leaves an error: row to claim
        },
      };
      const ctl = new BillingWebhookController(stripe as any, billing as any, ny as any);

      const a = res();
      await ctl.handleWebhook(req as any, a.r as any); // INSERT on the NY session
      const inserted = await prisma.stripeBillingEvent.findUniqueOrThrow({ where: { id } });
      expect(Math.abs(inserted.processedAt.getTime() - (await utcNowMs()))).toBeLessThan(2_000);
      expect(inserted.outcome).toBe("error:first attempt fails"); // the fence matched on the insert token

      const b = res();
      await ctl.handleWebhook(req as any, b.r as any); // CLAIM on the NY session
      const claimed = await prisma.stripeBillingEvent.findUniqueOrThrow({ where: { id } });
      expect(Math.abs(claimed.processedAt.getTime() - (await utcNowMs()))).toBeLessThan(2_000);
      expect({ a: a.out.status, b: b.out.status, runs: n, outcome: claimed.outcome }).toEqual({
        a: HttpStatus.INTERNAL_SERVER_ERROR,
        b: HttpStatus.OK,
        runs: 2,
        outcome: "processed", // the fenced write on the claim token matched 1 row
      });
    } finally {
      await ny.$disconnect();
      await nyPool.end();
    }
  });

  describe("Connect webhook — the same claim", () => {
    function connectController(eventId: string, settle: () => Promise<{ handled: boolean }>) {
      connectIds.push(eventId);
      const provider = {
        isConfigured: true,
        verifyEvent: () => ({
          type: "payment_intent.succeeded",
          eventId,
          accountRef: "acct_2476",
          created: new Date(),
          paymentIntentId: "pi_2476",
          amountDollars: 1,
          currency: "USD",
          methodKind: "card",
          metadata: {},
        }),
      };
      const calls = { n: 0 };
      const payments = {
        settleByPaymentIntent: async () => {
          calls.n += 1;
          return settle();
        },
      };
      const ctl = new ConnectWebhookController(
        provider as any,
        {} as any,
        payments as any,
        prisma as any,
        { log: async () => undefined } as any,
        { server: { to: () => ({ emit: () => undefined }) } } as any,
      );
      return { ctl, calls };
    }
    const creq = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };

    it("two concurrent deliveries ⇒ one settle, the other 503", async () => {
      const id = `evt_2476_cconc_${run}`;
      const g = gate();
      let startedA = false;
      const { ctl, calls } = connectController(id, async () => {
        startedA = true;
        await g.opened;
        return { handled: true };
      });
      const a = res();
      const pA = ctl.handle(creq as any, a.r as any);
      for (let i = 0; i < 400 && !startedA; i++) await new Promise((x) => setTimeout(x, 10));
      expect(startedA).toBe(true);
      const b = res();
      await ctl.handle(creq as any, b.r as any);
      g.open();
      await pA;
      expect({ runs: calls.n, a: a.out.status, b: b.out.status }).toEqual({
        runs: 1,
        a: HttpStatus.OK,
        b: HttpStatus.SERVICE_UNAVAILABLE,
      });
    });

    it("a NULL row older than the lease is re-claimed and settled once", async () => {
      const id = `evt_2476_cstale_${run}`;
      connectIds.push(id);
      await prisma.$executeRaw(Prisma.sql`INSERT INTO "StripeConnectEvent"
        ("id", "accountRef", "type", "createdAt", "processedAt", "outcome")
        VALUES (${id}, 'acct_2476', 'payment_intent.succeeded', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - ${`${WEBHOOK_CLAIM_LEASE_MS + 60_000} milliseconds`}::interval,
          NULL)`);
      const { ctl, calls } = connectController(id, async () => ({ handled: true }));
      const o = res();
      await ctl.handle(creq as any, o.r as any);
      expect({ runs: calls.n, status: o.out.status }).toEqual({ runs: 1, status: HttpStatus.OK });
    });
  });

  it("a payment_failed redelivered while the first is in flight ⇒ failedPaymentCount 1", async () => {
    const slug = assertTestTenant(`qa-b2476-pf-${run}`, "webhook-ledger-claim-2476.db.spec.ts");
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(tenant.id);
    const subId = `sub_2476_${run}`;
    const cusId = `cus_2476_${run}`;
    await prisma.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        planKey: "STARTER",
        basePriceSnapshot: 99,
        discount: 0,
        stripeSubId: subId,
        stripeCustomerId: cusId,
      },
    });
    await prisma.user.create({
      data: {
        email: `qa-b2476-${run}@example.invalid`,
        username: `qa-b2476-${run}`,
        role: "TENANT_ADMIN",
        tenantId: tenant.id,
      },
    });

    // Delivery A is held at the admin email — AFTER its increment.
    const g = gate();
    let emailing = false;
    const email = {
      send: async () => {
        emailing = true;
        await g.opened;
        return {};
      },
    };
    const planTransition = {
      isEnabled: () => Promise.resolve(false),
      prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
      onPlanChange: () => Promise.resolve({ action: "none" }),
      transactionOptions: () => undefined,
      invalidateCaches: () => undefined,
    };
    const billingSvc = new BillingService(
      prisma as any,
      {
        isConfigured: true,
        createBillingPortalSession: async () => ({ url: "https://billing.stripe.test/p/s" }),
      } as any,
      email as any,
      { invalidate: () => undefined } as any,
      new BillingEventService(prisma as any),
      {} as any,
      { notifyCancelled: async () => undefined, notifySuspended: async () => undefined } as any,
      planTransition as any,
      {
        checkoutAddonLines: async () => ({ lineItems: [], skus: [] }),
        adoptCheckoutAddons: async () => undefined,
      } as any, // mutations (SA-690)
    );
    const eventId = `evt_2476_pf_${run}`;
    billingIds.push(eventId);
    const event = {
      id: eventId,
      type: "invoice.payment_failed",
      created: 1_700_000_000,
      data: {
        object: { customer: cusId, parent: { subscription_details: { subscription: subId } } },
      },
    };
    const ctl = new BillingWebhookController(
      { isConfigured: true, constructWebhookEvent: () => event } as any,
      billingSvc,
      prisma as any,
    );

    const a = res();
    const pA = ctl.handleWebhook(req as any, a.r as any);
    for (let i = 0; i < 400 && !emailing; i++) await new Promise((x) => setTimeout(x, 10));
    expect(emailing).toBe(true); // ENTRY: A has incremented and is held at the email

    const b = res();
    await ctl.handleWebhook(req as any, b.r as any);
    g.open();
    await pA;

    const sub = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect({ count: sub.failedPaymentCount, a: a.out.status, b: b.out.status }).toEqual({
      count: 1,
      a: HttpStatus.OK,
      b: HttpStatus.SERVICE_UNAVAILABLE,
    });
  }, 30_000);
});
