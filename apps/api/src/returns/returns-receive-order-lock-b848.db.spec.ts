/**
 * B848 (a sibling of SA-737): a STANDARD `receive()` takes the ORDER row lock, after its Return claim and before the restock and
 * the regulated-ledger reversal (house order Return -> Order). Real Postgres, the barrier pattern of
 * invoice-send-void-race.db.spec.ts: a raw `pg` client holds the Order lock, receive() starts, and the case waits until Postgres
 * reports it BLOCKED before the holder commits.
 *
 *   B1  a void or cancel that holds the Order lock: receive() WAITS, then completes (red before: it never waited, so it could
 *       read the ledger balances a concurrent writer was about to change).
 *   B2  a receive and a refund of two returns on one order, and two receives on one order: they serialise on the Order, no 40P01.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`. Every tenant is a throwaway
 * `qa-b848-<run>-<n>` slug approved by `assertTestTenant`.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "./returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg");

const RUN = randomUUID().slice(0, 8);

type Outcome = { ok: true; v: any } | { ok: false; e: any };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
const deadlocked = (o: Outcome): boolean =>
  !o.ok &&
  (o.e?.meta?.driverAdapterError?.cause?.originalCode === "40P01" ||
    /40P01|deadlock detected/i.test(String(o.e?.message)));

describeDb("B848 receive() takes the Order row lock — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let returns: ReturnsService;
  let ctl: any;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    ctl = new Client({ connectionString: url });
    await ctl.connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        ReturnsService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: RouteFlowGateway, useValue: anyMethod },
        {
          provide: NumberingService,
          useValue: {
            reserveNext: jest.fn().mockImplementation(async () => `CN-B848-${RUN}-${++seq}`),
          },
        },
      ],
    }).compile();
    returns = mod.get(ReturnsService);
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.returnItem.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await ctl?.end().catch(swallow);
    await prisma?.$disconnect();
  }, 120_000);

  /** One order with one paid-in-full invoice and `returnCount` IN_TRANSIT STANDARD returns of 2 pieces each. */
  async function seed(label: string, returnCount = 1) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b848-${RUN}-${seq}-${label}`,
      "returns-receive-order-lock-b848.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `b848 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `P ${slug}`, unit: "each", pricePerUnit: 10 } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-B848-${RUN}-${seq}`,
        subtotal: 100,
        tax: 0,
        total: 100,
        status: "PENDING",
      } as any,
    });
    const orderItem = await prisma.orderItem.create({
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
        invoiceNumber: `INV-B848-${RUN}-${seq}`,
        status: "PAID",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        orderItemId: orderItem.id,
        productId: product.id,
        description: "line",
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
      } as any,
    });
    await prisma.invoicePayment.create({
      data: { tenantId, invoiceId: invoice.id, amount: 100, method: "CASH", status: "PAID" },
    });
    const returnIds: string[] = [];
    for (let i = 0; i < returnCount; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ret = await prisma.return.create({
        data: {
          tenantId,
          orderId: order.id,
          customerId: customer.id,
          reason: "DAMAGED",
          status: "IN_TRANSIT",
          returnNumber: `RTN-B848-${RUN}-${seq}-${i}`,
          items: { create: [{ tenantId, productId: product.id, qty: 2 }] },
        } as any,
      });
      returnIds.push(ret.id);
    }
    return { tenantId, userId: user.id, orderId: order.id, invoiceId: invoice.id, returnIds };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const receive = (s: Seed, returnId: string) =>
    settle(
      tenantCtx.run(s.tenantId, () =>
        // restock:false keeps the case on the lock and the ledger reversal (no stock rows to clean up)
        returns.receive(returnId, s.userId, { restock: false }),
      ),
    );
  const statusOf = (returnId: string) =>
    prisma.return.findUniqueOrThrow({ where: { id: returnId } }).then((r) => r.status);

  async function waitForWaiters(n: number, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const r = await ctl.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
      );
      if (r.rows[0].n >= n) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((x) => setTimeout(x, 25));
    }
    return false;
  }

  async function holdOrder(s: Seed, alsoInvoice = false) {
    const c = new Client({ connectionString: process.env.DATABASE_URL as string });
    await c.connect();
    await c.query("BEGIN");
    await c.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [s.orderId]);
    if (alsoInvoice)
      await c.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [s.invoiceId]);
    return {
      c,
      commit: async () => {
        await c.query("COMMIT");
        await c.end();
      },
    };
  }

  it("B1: receive() waits for a writer that holds the Order lock, then completes", async () => {
    const s = await seed("b1");
    const h = await holdOrder(s, true); // a void/cancel: Order, then Invoice
    const pending = receive(s, s.returnIds[0]);
    const blocked = await waitForWaiters(1);
    // while it waits, the claim has not committed: the return is still IN_TRANSIT to every other reader
    const during = await statusOf(s.returnIds[0]);
    await h.c.query(`UPDATE "Invoice" SET status = 'VOID' WHERE id = $1`, [s.invoiceId]);
    await h.commit();
    const out = await pending;

    expect(blocked).toBe(true); // red before: receive() never took the Order lock, so nothing blocked it
    expect(during).toBe("IN_TRANSIT");
    expect(out.ok).toBe(true);
    expect(await statusOf(s.returnIds[0])).toBe("RECEIVED");
  });

  it("B2a: two receives of two returns on one order serialise on the Order: both land, no 40P01", async () => {
    const s = await seed("b2a", 2);
    const h = await holdOrder(s);
    const a = receive(s, s.returnIds[0]);
    const b = receive(s, s.returnIds[1]);
    const blocked = await waitForWaiters(2);
    await h.commit();
    const outs = await Promise.all([a, b]);

    expect(blocked).toBe(true);
    expect(outs.some(deadlocked)).toBe(false);
    expect(outs.every((o) => o.ok)).toBe(true);
    expect(await statusOf(s.returnIds[0])).toBe("RECEIVED");
    expect(await statusOf(s.returnIds[1])).toBe("RECEIVED");
  });

  it("B2b: a receive of one return beside a refund of another on the same order: no 40P01, the refund is not stranded", async () => {
    const s = await seed("b2b", 2);
    // the second return is already received, so it can be refunded
    await prisma.return.update({ where: { id: s.returnIds[1] }, data: { status: "RECEIVED" } });
    const h = await holdOrder(s);
    const rec = receive(s, s.returnIds[0]);
    const ref = settle(
      tenantCtx.run(s.tenantId, () =>
        returns.processRefund(
          s.returnIds[1],
          { method: "EXTERNAL_REFUND" } as any,
          {
            sub: s.userId,
            role: "OPERATOR",
          } as any,
        ),
      ),
    );
    const blocked = await waitForWaiters(2);
    await h.commit();
    const outs = await Promise.all([rec, ref]);

    expect(blocked).toBe(true);
    expect(outs.some(deadlocked)).toBe(false);
    expect(outs[0].ok).toBe(true);
    expect(await statusOf(s.returnIds[0])).toBe("RECEIVED");
  });
});
