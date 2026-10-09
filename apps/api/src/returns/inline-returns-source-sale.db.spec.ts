/**
 * SA-740 §1 (row 190) - real-Postgres proof of what the mocked unit suites cannot: the walk-in source-sale pin end to end, and
 * that a capture whose source sale is NOT its carrying order takes BOTH order locks (id-sorted, tenant-bound, the set and order
 * `refund()` takes), so a capture and a refund on the same source serialize and never deadlock (red test 8).
 *
 * Every case builds a throwaway `qa-sa740-<run>-<n>` tenant (approved by `assertTestTenant`): a walk-in customer and TWO
 * sales, each a DELIVERED order + invoice + one 10-piece, $10.00 line + a payment of $100.00. Sale A is the NEWEST, sale B
 * is older, so the pre-SA-740 customer-scoped matching would have allocated a return from B's receipt to A.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Written WITHOUT being run in the authoring environment (no DB
 * lane there): the first run must be on the compose Postgres.
 */
import { randomUUID } from "crypto";
import { Client } from "pg";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { IdempotencyService } from "../common/idempotency.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-740 walk-in source sale + capture locks, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let inline: any;
  const tenantIds: string[] = [];
  let seq = 0;
  let numSeq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const numbering = {
      reserveNext: jest.fn().mockImplementation(async () => `N-SA740-${RUN}-${++numSeq}`),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: RouteFlowGateway, useValue: anyMethod },
        { provide: NumberingService, useValue: numbering },
      ],
    }).compile();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    inline = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: anyMethod,
      ledger: mod.get(RegulatedLedgerService),
      creditNotes: mod.get(CreditNotesService),
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
      idempotency: new IdempotencyService(),
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.returnItem.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** A walk-in with two counter sales of the same product: A (newest) and B (older). */
  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa740-${RUN}-${seq}-${label}`,
      "inline-returns-source-sale.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `sa740 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `walk-in ${label}`,
        contactName: `walk-in ${label}`,
        tenantId,
        isWalkIn: true,
      } as any,
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `Widget ${slug}`,
        unit: "each",
        pricePerUnit: 10,
        currentStock: 0,
      } as any,
    });
    const sale = async (tag: "A" | "B", daysAgo: number) => {
      const issueDate = new Date(Date.now() - daysAgo * 86_400_000);
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-SA740-${RUN}-${seq}-${tag}`,
          subtotal: 100,
          tax: 0,
          total: 100,
          status: "DELIVERED",
          counterSale: true,
        } as any,
      });
      await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
        } as any,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-SA740-${RUN}-${seq}-${tag}`,
          status: "PAID",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          issueDate,
        } as any,
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          productId: product.id,
          description: "Widget",
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
        },
      });
      await prisma.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          amount: 100,
          method: "CASH",
          status: "PAID",
        } as any,
      });
      return order.id;
    };
    const orderA = await sale("A", 0);
    const orderB = await sale("B", 3);
    return {
      tenantId,
      userId: user.id,
      customerId: customer.id,
      productId: product.id,
      orderA,
      orderB,
    };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const staff = (s: Seed) => ({
    sub: s.userId,
    username: "operator",
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId: s.tenantId,
    tenantSlug: "x",
  });
  const inTenant = (s: Seed, fn: () => Promise<any>): Promise<any> =>
    tenantCtx.run(s.tenantId, fn) as Promise<any>;
  let keySeq = 0;
  const capture = (
    s: Seed,
    pieces: number,
    over: { orderId: string; sourceOrderId?: string; resolution?: "STORE_CREDIT" | "REFUND" },
  ) =>
    inTenant(s, () =>
      inline.capture(
        {
          customerId: s.customerId,
          orderId: over.orderId,
          items: [{ productId: s.productId, qty: pieces, boxes: 0, pieces }],
          returnKey: `sa740-${RUN}-${++keySeq}`,
          ...(over.sourceOrderId ? { sourceOrderId: over.sourceOrderId } : {}),
          ...(over.resolution ? { resolution: over.resolution } : {}),
        },
        staff(s),
      ),
    );
  const codeOf = (e: any) => e?.getResponse?.()?.code;
  const fail = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e) => e,
    );
  const items = (returnId: string) => prisma.returnItem.findMany({ where: { returnId } });

  it("1. a walk-in return carried on B (no sourceOrderId) is sourced on B, never on the newest sale A", async () => {
    const s = await seed("default-source");
    const r = await capture(s, 2, { orderId: s.orderB });
    const rows = await items(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceOrderId).toBe(s.orderB);
    expect(Number(r.creditSubtotal)).toBe(20);
  }, 60_000);

  it("2. an explicit sourceOrderId different from the carrying order is honoured: carried on A, sourced on B", async () => {
    const s = await seed("explicit-source");
    const r = await capture(s, 3, { orderId: s.orderA, sourceOrderId: s.orderB });
    const rows = await items(r.id);
    expect(rows.map((i) => i.sourceOrderId)).toEqual([s.orderB]);
    expect(r.orderId).toBe(s.orderA);
  }, 60_000);

  it("3. a walk-in return of more than the sale had is 409 RETURN_EXCEEDS_SALE and writes nothing", async () => {
    const s = await seed("exceeds");
    const err = await fail(capture(s, 11, { orderId: s.orderB }));
    expect(err?.getStatus?.()).toBe(409);
    expect(codeOf(err)).toBe("RETURN_EXCEEDS_SALE");
    expect(await prisma.return.count({ where: { tenantId: s.tenantId } })).toBe(0);
    expect(
      Number((await prisma.product.findUniqueOrThrow({ where: { id: s.productId } })).currentStock),
    ).toBe(0);
  }, 60_000);

  it("4. a source of another customer's / a missing order is a 400 SOURCE_SALE_INVALID", async () => {
    const s = await seed("invalid");
    const err = await fail(capture(s, 1, { orderId: s.orderA, sourceOrderId: "no-such-order" }));
    expect(err?.getStatus?.()).toBe(400);
    expect(codeOf(err)).toBe("SOURCE_SALE_INVALID");
  }, 60_000);

  // NOTE on proof strength: test 8 is the REAL red pin (it holds B's row lock on a raw session, shows the capture queued behind
  // it through pg_blocking_pids, and fails on the old carrying-only lock). Test 8b is only a SMOKE race (two calls crossing the
  // same two orders, asserting no deadlock text): it can pass by timing luck, so do NOT count it as proof of the lock order.
  it("8. a capture sourced on B (carried on A) WAITS for another transaction holding B's row lock: it takes the source order lock too", async () => {
    const s = await seed("source-lock");
    const url = requireLocalDatabaseUrl();
    const holder = new Client({ connectionString: url });
    const poller = new Client({ connectionString: url });
    await holder.connect();
    await poller.connect();
    let settled: Promise<any> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [s.orderB]);
      const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      settled = capture(s, 1, { orderId: s.orderA, sourceOrderId: s.orderB }).then(
        (v) => ({ ok: v }),
        (e) => ({ err: e }),
      );
      let blocked = 0;
      for (let i = 0; i < 100 && blocked === 0; i++) {
        const r = await poller.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        );
        blocked = Number(r.rows[0].n);
        if (blocked === 0) await new Promise((res) => setTimeout(res, 50));
      }
      expect(blocked).toBeGreaterThan(0); // the capture is queued behind the SOURCE order's lock
      await holder.query("ROLLBACK");
      const outcome = await settled;
      expect(outcome.err).toBeUndefined();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      if (settled) await settled;
      await holder.end().catch(() => undefined);
      await poller.end().catch(() => undefined);
    }
  }, 60_000);

  it("8b. a capture and a refund that cross the same two orders serialize: neither deadlocks (no 40P01)", async () => {
    const s = await seed("crossing");
    // R1: carried on B, sourced on A (a pending refund) - refund() locks [A, B]
    const pending = await capture(s, 2, {
      orderId: s.orderB,
      sourceOrderId: s.orderA,
      resolution: "REFUND",
    });
    // C: carried on A, sourced on B - captureInTx locks [A, B] the same sorted way
    const results = await Promise.allSettled([
      inTenant(s, () =>
        inline.refund(pending.id, { tender: "CASH", expectedAmount: 20 }, staff(s)),
      ),
      capture(s, 1, { orderId: s.orderA, sourceOrderId: s.orderB }),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        const text = `${(r.reason as any)?.code ?? ""} ${(r.reason as any)?.message ?? ""}`;
        expect(text).not.toMatch(/40P01|deadlock/i);
      }
    }
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
