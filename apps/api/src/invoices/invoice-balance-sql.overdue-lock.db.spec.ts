/**
 * CM2a / OVERDUE-LOCK — the overdue sweep must read the balance AFTER it holds the invoice row lock.
 *
 * The race (real Postgres, READ COMMITTED): a payment path takes `lockInvoicesForPayment`
 * (`SELECT ... FOR UPDATE`) and, still holding it, writes a confirmed payment that covers the invoice.
 * The sweep starts meanwhile and blocks on that row lock. When the payment commits, a single
 * `UPDATE ... WHERE <balance test>` re-checks only the NEW Invoice row version; its correlated
 * InvoicePayment subquery keeps the statement snapshot, so the balance test still sees "unpaid" and the
 * just-paid invoice is flipped to OVERDUE. P-3 leaves an invoice at SENT when a payment covers it, so no
 * status re-check hides this any more. The fix is lock-first: lock the candidate ids, THEN update with
 * the balance read after the lock (a new statement, a new snapshot).
 *
 * Deterministic: two PrismaService pools (payer, sweeper); the test waits until Postgres reports a
 * backend blocked on a Lock (pg_stat_activity) before it lets the payer commit. Every wait is bounded.
 *
 * Collected only by `jest.db.config.js`; throwaway tenant slug `qa-cm2a-<run>-...` (assertTestTenant).
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { markOverdueForTenant } from "./overdue-sweep.service";
import { lockInvoicesForPayment } from "./invoice-send-guard";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const WAIT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, what: string, ms = WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

describeDb("markOverdueForTenant — lock-first against a concurrent payment (CM2a)", () => {
  let admin: PrismaService;
  let payer: PrismaService;
  let sweeper: PrismaService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    admin = new PrismaService(new TenantContextService());
    payer = new PrismaService(new TenantContextService());
    sweeper = new PrismaService(new TenantContextService());
    await Promise.all([admin.$connect(), payer.$connect(), sweeper.$connect()]);
  }, 30_000);

  afterAll(async () => {
    for (const tenantId of [...tenantIds].reverse()) {
      await (async () => {
        await admin.invoicePayment.deleteMany({ where: { tenantId } });
        await admin.invoice.deleteMany({ where: { tenantId } });
        await admin.tenantConfig.deleteMany({ where: { tenantId } });
        await admin.customer.deleteMany({ where: { tenantId } });
        await admin.user.deleteMany({ where: { tenantId } });
        await admin.tenant.delete({ where: { id: tenantId } });
      })().catch((e) => console.warn(`overdue-lock.db.spec: cleanup of ${tenantId} failed: ${e}`));
    }
    await Promise.all([admin?.$disconnect(), payer?.$disconnect(), sweeper?.$disconnect()]);
  });

  async function seedSentPastDue(label: string, total: number) {
    const slug = assertTestTenant(
      `qa-cm2a-${RUN}-${label}`,
      "invoice-balance-sql.overdue-lock.db.spec.ts",
    );
    const tenant = await admin.tenant.create({ data: { slug, name: `CM2a ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await admin.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await admin.customer.create({
      data: {
        userId: user.id,
        businessName: `CM2a ${label}`,
        contactName: label,
        tenantId: tenant.id,
      },
    });
    const inv = await admin.invoice.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        invoiceNumber: `INV-CM2A-${RUN}-${label}`,
        status: "SENT",
        subtotal: total,
        total,
        dueDate: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    return { tenantId: tenant.id, invoiceId: inv.id };
  }

  /** Resolves once Postgres reports a backend (other than this one) blocked on a lock. */
  async function untilSomeoneWaitsOnALock(): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      const rows = await admin.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
      if ((rows[0]?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the sweep never blocked on the payer's row lock");
  }

  /**
   * The payer locks the invoice (as every payment path does), the sweep starts and blocks, then the payer
   * writes a confirmed payment of `paid` and commits. Returns the sweep's flipped-row count.
   */
  async function sweepWhilePaying(s: { tenantId: string; invoiceId: string }, paid: number) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));

    const payment = payer.$transaction(async (tx) => {
      await lockInvoicesForPayment(tx, [s.invoiceId]);
      locked();
      await gate;
      await tx.invoicePayment.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.invoiceId,
          amount: paid,
          method: "CASH",
          status: "PAID",
        },
      });
      // P-3: a covering payment leaves the invoice at SENT (status is NOT touched here).
    });
    // A failed payer must not leave the gate hanging.
    payment.catch(() => release());

    await withTimeout(holding, "the payer to take the invoice lock");
    const sweep = markOverdueForTenant(sweeper, s.tenantId, new Date("2026-10-02T12:00:00.000Z"));
    sweep.catch(() => undefined);
    try {
      await untilSomeoneWaitsOnALock();
    } finally {
      release();
    }
    await withTimeout(payment, "the payment to commit");
    return withTimeout(sweep, "the sweep to finish");
  }

  const status = async (id: string) =>
    (await admin.invoice.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  it("does NOT flip an invoice that a concurrent payment paid in full", async () => {
    const s = await seedSentPastDue("full", 100);
    const flipped = await sweepWhilePaying(s, 100);
    expect(await status(s.invoiceId)).toBe("SENT");
    expect(flipped).toBe(0);
  }, 60_000);

  it("does NOT flip an invoice that a concurrent payment overpaid", async () => {
    const s = await seedSentPastDue("over", 100);
    const flipped = await sweepWhilePaying(s, 130);
    expect(await status(s.invoiceId)).toBe("SENT");
    expect(flipped).toBe(0);
  }, 60_000);

  it("still flips an invoice whose concurrent payment leaves a balance", async () => {
    const s = await seedSentPastDue("partial", 100);
    const flipped = await sweepWhilePaying(s, 40);
    expect(await status(s.invoiceId)).toBe("OVERDUE");
    expect(flipped).toBe(1);
  }, 60_000);
});
