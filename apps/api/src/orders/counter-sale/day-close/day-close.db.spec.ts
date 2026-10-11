/**
 * SA-750r3 - the counter DAY CLOSE on real Postgres (the part no mock can prove):
 *   - an in-flight SHARED-lock writer racing the EXCLUSIVE close lands in exactly ONE window: the close queues behind the writer,
 *     reads its cutoff after the grant, and the writer's payment (stamped from the database clock under the lock) is inside it and
 *     inside no other; a payment after the close is in the next window only;
 *   - two closes of one day racing: one wins, the other is a 409 DAY_ALREADY_CLOSED; the unique (tenant, register, windowStart)
 *     key is real (a duplicate insert is a P2002 / 23505);
 *   - the window's queries: till cash is only a counter tender row of THIS register ('main' reads a null `Order.registerKey`;
 *     'b' never counts 'main' cash), an office cash payment on a counter invoice is "not taken at the till", a refund with no
 *     recorded tender is never subtracted from the drawer and flips tenderKnown, a non-counter order and another tenant count
 *     for nothing;
 *   - reopen is audited and the re-close keeps the cutoff.
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test tenants only, collected only
 * by jest.db.config.js). Tenant slugs `qa-day-close-*` are approved by assertTestTenant.
 */
jest.mock("../../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { DenominationCount } from "@routeflow/types";
import type { JwtPayload } from "../../../auth/jwt-payload.interface";
import { describeDb, requireLocalDatabaseUrl } from "../../../common/testing/db-spec";
import { PrismaService } from "../../../prisma/prisma.service";
import { TenantContextService } from "../../../tenant/tenant-context.service";
import { dbClockNow, lockCounterClose } from "../../../returns/counter-close-lock";
import { legGroupId } from "../counter-tender-row";
import { CounterDayCloseService } from "./day-close.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../../scripts/lib/test-tenants.cjs");

const NOW = new Date("2026-10-08T20:00:00.000Z"); // 16:00 in New York (EDT): the day opened at 04:00Z
const tens = (n: number): DenominationCount[] => [{ kind: "bill", value: 10, count: n }];

describeDb("counter day close on real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CounterDayCloseService;
  let sent = 0;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-day-close-a-${run}`, "day-close.db.spec.ts");
  const slugB = assertTestTenant(`qa-day-close-b-${run}`, "day-close.db.spec.ts");
  const tenants = { A: "", B: "" };
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let operator!: JwtPayload;
  let seq = 0;

  const as = <T>(tenant: "A" | "B", fn: () => Promise<T>) => tenantCtx.run(tenants[tenant], fn);

  async function customer(tenant: "A" | "B"): Promise<string> {
    const user = await raw.user.create({
      data: {
        email: `c-${tenant}-${seq}-${run}@example.test`,
        username: `c-${tenant}-${seq}-${run}`,
        role: "CUSTOMER",
        tenantId: tenants[tenant],
      },
    });
    userIds.push(user.id);
    const c = await raw.customer.create({
      data: {
        userId: user.id,
        businessName: `Acme Test ${tenant} ${seq}`,
        contactName: "Tester",
        tenantId: tenants[tenant],
      },
    });
    customerIds.push(c.id);
    return c.id;
  }

  /** A counter (or not) order with one invoice; returns both ids. */
  async function sale(o: {
    tenant?: "A" | "B";
    registerKey?: string | null;
    counterSale?: boolean;
    total?: number;
    at?: Date;
  }) {
    seq += 1;
    const tenant = o.tenant ?? "A";
    const customerId = await customer(tenant);
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId: tenants[tenant],
        counterSale: o.counterSale ?? true,
        registerKey: o.registerKey ?? null,
        status: "DELIVERED",
        orderNumber: `D${run}-${seq}`,
        total: o.total ?? 30,
        createdAt: o.at ?? new Date("2026-10-08T14:00:00.000Z"),
      },
    });
    orderIds.push(order.id);
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `DINV-${run}-${seq}`,
        customerId,
        orderId: order.id,
        tenantId: tenants[tenant],
        status: "SENT",
        subtotal: o.total ?? 30,
        total: o.total ?? 30,
      },
    });
    invoiceIds.push(invoice.id);
    return { orderId: order.id, invoiceId: invoice.id, customerId, tenantId: tenants[tenant] };
  }

  const pay = (
    s: { invoiceId: string; tenantId: string },
    p: { amount: number; method?: string; at: string; status?: string; group?: string },
  ) =>
    raw.invoicePayment.create({
      data: {
        invoiceId: s.invoiceId,
        tenantId: s.tenantId,
        amount: p.amount,
        method: (p.method ?? "CASH") as never,
        status: (p.status ?? "PAID") as never,
        paidAt: new Date(p.at),
        paymentGroupId: p.group ?? null,
      },
    });

  async function refund(
    s: { orderId: string; customerId: string; tenantId: string },
    r: { amount: number; tender: string | null; at: string },
  ) {
    seq += 1;
    return raw.return.create({
      data: {
        returnNumber: `DR${run}-${seq}`,
        orderId: s.orderId,
        customerId: s.customerId,
        tenantId: s.tenantId,
        reason: "DAMAGED",
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: r.amount,
        refundedAt: new Date(r.at),
        refundTender: (r.tender ?? null) as never,
      },
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 10 });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    service = new CounterDayCloseService(
      prisma,
      { get: async () => ({ counter: "optional" }) } as never,
      {
        send: async () => {
          sent += 1;
          return { delivered: true, transport: "smtp" };
        },
      } as never,
    );
    tenants.A = (
      await raw.tenant.create({ data: { slug: slugA, name: `Day close A ${slugA}` } })
    ).id;
    tenants.B = (
      await raw.tenant.create({ data: { slug: slugB, name: `Day close B ${slugB}` } })
    ).id;
    for (const t of [tenants.A, tenants.B]) {
      await raw.tenantConfig.create({ data: { tenantId: t, timezone: "America/New_York" } });
    }
    const op = await raw.user.create({
      data: {
        email: `op-${run}@example.test`,
        username: `op-${run}`,
        role: "OPERATOR",
        tenantId: tenants.A,
      },
    });
    const admin = await raw.user.create({
      data: {
        email: `admin-${run}@example.test`,
        username: `admin-${run}`,
        role: "TENANT_ADMIN",
        tenantId: tenants.A,
      },
    });
    userIds.push(op.id, admin.id);
    operator = {
      sub: op.id,
      username: op.username,
      role: "OPERATOR",
      tenantId: tenants.A,
    } as never;
  }, 120_000);

  afterAll(async () => {
    const tenantList = Object.values(tenants);
    await raw.auditLog.deleteMany({ where: { tenantId: { in: tenantList } } });
    await raw.billingNotificationLog.deleteMany({ where: { tenantId: { in: tenantList } } });
    await raw.counterDayClose.deleteMany({ where: { tenantId: { in: tenantList } } });
    await raw.return.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenantConfig.deleteMany({ where: { tenantId: { in: tenantList } } });
    await raw.tenant.deleteMany({ where: { id: { in: tenantList } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  // ─── The race ──────────────────────────────────────────────────────────────────────────────────

  /** A writer exactly as the counter paths run: the SHARED close lock first, then a payment dated from the database clock. */
  function inFlightWriter(
    s: { invoiceId: string; tenantId: string },
    register: string,
    amount: number,
  ) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: (pid: number) => void;
    const hasLock = new Promise<number>((r) => (acquired = r));
    const done = raw.$transaction(
      async (tx) => {
        await lockCounterClose(tx as never, s.tenantId, register);
        const rows = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`) as Array<{ pid: number }>;
        acquired(Number(rows[0].pid));
        await gate;
        const paidAt = await dbClockNow(tx as never);
        await tx.invoicePayment.create({
          data: {
            invoiceId: s.invoiceId,
            tenantId: s.tenantId,
            amount,
            method: "CASH",
            status: "PAID",
            paidAt,
          },
        });
      },
      { timeout: 30_000 },
    );
    return { hasLock, release, done };
  }

  async function waitUntilBlockedBy(pid: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [pid],
      );
      if (Number(r.rows[0].n) > 0) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("the close never queued behind the in-flight writer");
  }

  it("an in-flight tender racing the close lands in exactly one window", async () => {
    const REG = `r-race-${run}`;
    const s = await sale({ registerKey: REG, at: new Date(Date.now() - 60_000) });
    const writer = inFlightWriter(s, REG, 12.5);
    const writerPid = await writer.hasLock;

    // the close starts while the writer holds the shared lock: it must queue behind it, not read a cutoff yet
    const closing = as("A", () =>
      service.close({ openingFloat: 10, denominations: tens(2), registerKey: REG }, operator),
    );
    await waitUntilBlockedBy(writerPid);
    writer.release();
    await writer.done;
    const snap = await closing;

    const row = await raw.invoicePayment.findFirstOrThrow({ where: { invoiceId: s.invoiceId } });
    // exactly one window: the payment is before the cutoff, so it is in this close...
    expect(row.paidAt.getTime()).toBeLessThan(Date.parse(snap.windowEnd));
    expect(snap.totals.moneyIn.cash).toBe(12.5);
    expect(snap.expectedCash).toBe(22.5); // 10 float + 12.5
    expect(snap.variance).toBe(-2.5); // counted 20
    // ...and the next window does not count it again
    const state = await as("A", () => service.state(REG));
    expect(state.preview.windowStart).toBe(snap.windowEnd);
    expect(state.preview.tillCash).toBe(0);

    // a payment after the close is in the NEXT window only; the closed snapshot does not move
    const late = inFlightWriter(s, REG, 7);
    await late.hasLock;
    late.release();
    await late.done;
    // `now` a minute ahead: the payment is dated from the DATABASE clock, which may run ahead of this process's
    const after = await as("A", () => service.state(REG, new Date(Date.now() + 60_000)));
    expect(after.preview.tillCash).toBe(7);
    expect(after.lastClose?.totals.moneyIn.cash).toBe(12.5);
    expect(after.lastClose?.expectedCash).toBe(22.5);
  }, 90_000);

  // ─── Duplicates and the unique key ─────────────────────────────────────────────────────────────

  it("two closes of one day racing: one wins, the other is a 409 DAY_ALREADY_CLOSED, and one row is stored", async () => {
    const REG = `r-dup-${run}`;
    const results = await Promise.allSettled([
      as("A", () =>
        service.close({ openingFloat: 0, denominations: tens(1), registerKey: REG }, operator),
      ),
      as("A", () =>
        service.close({ openingFloat: 0, denominations: tens(1), registerKey: REG }, operator),
      ),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason.response).toMatchObject({ code: "DAY_ALREADY_CLOSED" });
    expect(
      await raw.counterDayClose.count({ where: { tenantId: tenants.A, registerKey: REG } }),
    ).toBe(1);
  }, 60_000);

  it("the unique (tenantId, registerKey, windowStart) key is real: a duplicate window is a P2002", async () => {
    const data = {
      tenantId: tenants.A,
      registerKey: `r-uniq-${run}`,
      day: new Date("2026-10-08T00:00:00.000Z"),
      zone: "America/New_York",
      windowStart: new Date("2026-10-08T04:00:00.000Z"),
      windowEnd: new Date("2026-10-08T20:00:00.000Z"),
      closedAt: new Date("2026-10-08T20:00:00.000Z"),
      expectedCash: 0,
      countedCash: 0,
      variance: 0,
      denominations: [],
      totals: {},
    };
    await raw.counterDayClose.create({ data });
    await expect(raw.counterDayClose.create({ data })).rejects.toMatchObject({ code: "P2002" });
    // the same window on ANOTHER register, or another tenant, is fine
    await raw.counterDayClose.create({ data: { ...data, registerKey: `r-uniq2-${run}` } });
    await raw.counterDayClose.create({ data: { ...data, tenantId: tenants.B } });
  });

  // ─── The window's queries ──────────────────────────────────────────────────────────────────────

  it("till cash is a counter tender row of THIS register; office cash is not at the till; an unrecorded refund tender is never cash", async () => {
    const REG_MAIN = "main";
    const main = await sale({ registerKey: null, total: 27.25 }); // an order with no key reads as 'main'
    const keyed = await sale({ registerKey: "main", total: 4 });
    const other = await sale({ registerKey: "b", total: 99 });
    const notCounter = await sale({ counterSale: false, total: 33 });
    const foreign = await sale({ tenant: "B", registerKey: null, total: 77 });

    await pay(main, { amount: 20, at: "2026-10-08T15:00:00.000Z" }); // till cash
    await pay(main, { amount: 7.25, at: "2026-10-08T15:05:00.000Z", group: randomUUID() }); // office cash
    await pay(main, { amount: 5, method: "CREDIT_CARD", at: "2026-10-08T15:10:00.000Z" });
    await pay(main, { amount: 50, at: "2026-10-08T15:15:00.000Z", status: "DRAFT" }); // not PAID
    await pay(main, { amount: 11, at: "2026-10-08T03:00:00.000Z" }); // before the day opened
    await pay(keyed, { amount: 4, at: "2026-10-08T16:00:00.000Z" });
    await pay(other, { amount: 99, at: "2026-10-08T15:00:00.000Z" });
    await pay(notCounter, { amount: 33, at: "2026-10-08T15:00:00.000Z" });
    await pay(foreign, { amount: 77, at: "2026-10-08T15:00:00.000Z" });
    await refund(main, { amount: 12, tender: null, at: "2026-10-08T16:00:00.000Z" }); // no tender recorded
    await refund(main, { amount: 5, tender: "CASH", at: "2026-10-08T16:30:00.000Z" });
    await refund(other, { amount: 40, tender: "CASH", at: "2026-10-08T16:00:00.000Z" });

    const state = await as("A", () => service.state(REG_MAIN, NOW));
    expect(state.preview.windowStart).toBe("2026-10-08T04:00:00.000Z");
    expect(state.preview.tillCash).toBe(24); // 20 + 4; not the office 7.25, not 'b', not the non-counter order, not tenant B
    expect(state.preview.cashRefunds).toBe(5);
    expect(state.preview.totals.moneyIn).toEqual({
      cash: 24,
      card: 5,
      check: 0,
      other: 0,
      total: 29,
    });
    expect(state.preview.totals.notAtTill).toBe(7.25);
    expect(state.preview.totals.refunds).toMatchObject({
      count: 2,
      cash: 5,
      other: 12,
      total: 17,
      tenderKnown: false,
      unknownTenderCount: 1,
    });

    // register 'b' never counts 'main' cash, and its cash refund is its own
    const b = await as("A", () => service.state("b", NOW));
    expect(b.preview.tillCash).toBe(99);
    expect(b.preview.cashRefunds).toBe(40);
    expect(b.preview.totals.notAtTill).toBe(0);
    expect(b.preview.totals.refunds.tenderKnown).toBe(true);

    // the other tenant sees only its own
    const isolated = await as("B", () => service.state("main", NOW));
    expect(isolated.preview.tillCash).toBe(77);
    expect(isolated.preview.totals.refunds.count).toBe(0);
  }, 60_000);

  it("a split sale: its leg rows are till money, an ungrouped office row beside them is not, and a legacy sale's ungrouped row is", async () => {
    const REG = `split-${run}`;
    const split = await sale({ registerKey: REG, total: 50 });
    const legacy = await sale({ registerKey: REG, total: 12 });
    // the sale's tender, as the split writer stores it: a card leg and a cash leg, each with the order's own leg group id
    await pay(split, {
      amount: 30,
      method: "CREDIT_CARD",
      at: "2026-10-08T15:00:00.000Z",
      group: legGroupId(split.orderId, 0),
    });
    await pay(split, {
      amount: 20,
      at: "2026-10-08T15:00:00.000Z",
      group: legGroupId(split.orderId, 1),
    });
    await pay(split, { amount: 6, at: "2026-10-08T15:30:00.000Z" }); // ungrouped: an office payment beside the legs
    await pay(legacy, { amount: 12, at: "2026-10-08T15:40:00.000Z" }); // ungrouped, no leg row: the legacy tender

    const state = await as("A", () => service.state(REG, NOW));
    expect(state.preview.tillCash).toBe(32); // 20 (the cash leg) + 12 (the legacy sale); not the office 6
    expect(state.preview.totals.moneyIn).toEqual({
      cash: 32,
      card: 30,
      check: 0,
      other: 0,
      total: 62,
    });
    expect(state.preview.totals.notAtTill).toBe(6);
  }, 60_000);

  // ─── Reopen and re-close ───────────────────────────────────────────────────────────────────────

  it("reopen is audited in the database and the re-close keeps the cutoff, sends a second Z report", async () => {
    const REG = `r-reopen-${run}`;
    const first = await as("A", () =>
      service.close({ openingFloat: 5, denominations: tens(1), registerKey: REG }, operator),
    );
    const sentAfterFirst = sent;
    const reopened = await as("A", () => service.reopen(first.id, operator));
    expect(reopened.reopenedAt).not.toBeNull();
    const audits = await raw.auditLog.findMany({
      where: { tenantId: tenants.A, entityId: first.id, action: "COUNTER_DAY_CLOSE_REOPENED" },
    });
    expect(audits).toHaveLength(1);
    expect((audits[0].meta as { snapshot: { countedCash: number } }).snapshot.countedCash).toBe(10);

    const again = await as("A", () =>
      service.close(
        { openingFloat: 999, denominations: tens(3), notes: "recount", registerKey: REG },
        operator,
      ),
    );
    expect(again.id).toBe(first.id);
    expect(again.windowEnd).toBe(first.windowEnd);
    expect(again.countedCash).toBe(30);
    expect(again.openingFloat).toBe(5);
    expect(again.reopenedAt).toBeNull();
    expect(again.closedAt >= first.closedAt).toBe(true);
    expect(sent).toBeGreaterThan(sentAfterFirst); // the corrected report went out
    expect(
      await raw.counterDayClose.count({ where: { tenantId: tenants.A, registerKey: REG } }),
    ).toBe(1);
    const claims = await raw.billingNotificationLog.findMany({
      where: { tenantId: tenants.A, milestone: "ZREPORT", key: { startsWith: `${first.id}:` } },
    });
    expect(claims).toHaveLength(2); // one per closedAt
  }, 60_000);
});
