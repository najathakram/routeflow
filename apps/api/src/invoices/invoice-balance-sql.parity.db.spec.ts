/**
 * SA-770 (ACTION-ITEMS row 294) — DB-lane PARITY PIN for `balanceDueSql`: the SQL predicate and the
 * TypeScript classifier every invoice read shows (`classifyInvoiceBalance`, which `deriveInvoiceDetailFields` and the list use)
 * must agree row for row, on every shape of payment history. Plus the three readers built on the
 * predicate, against real rows: the overdue id list, the overdue count and the sweep's UPDATE.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`; the real
 * connection is built in `beforeAll` (never at collection time) and `requireLocalDatabaseUrl()`
 * refuses any non-local host. SAFETY: every tenant is a throwaway `qa-sa770-<run>-<n>-<label>` slug
 * approved by `assertTestTenant`; `afterAll` deletes exactly the tenants THIS run created, in FK
 * order. Each test seeds its own tenant, so no expectation depends on a sibling.
 *
 * The fixtures are the cases the spec lists: unpaid, partial, exactly paid, overpaid (P-3 keeps it
 * out of PAID), a DRAFT payment, a VOID payment, a credit-note application and an advance
 * application. All are SENT (an open status): the TS `isSettled` shortcut (PAID / VOID /
 * WRITTEN_OFF => 0) is a STATUS rule the readers apply through their status filter, not part of
 * the payment arithmetic this predicate pins.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { deriveInvoiceDetailFields } from "./invoice-detail-read";
import { classifyInvoiceBalance } from "./invoice-balance-classify";
import {
  balanceDueSql,
  markInvoicesOverdue,
  overdueInvoiceCount,
  overdueInvoiceIds,
} from "./invoice-balance-sql";
import { Prisma } from "@prisma/client";
import { overdueCutoff } from "../common/calendar-date";
import { markOverdueForTenant } from "./overdue-sweep.service";
import { applyInvoiceStatusFilters } from "./invoice-list-query";
import { computeInvoiceKpiSummary } from "./invoice-kpi-summary";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

type Pay = {
  amount: number;
  method?: "CASH" | "CREDIT_NOTE" | "ADVANCE";
  status?: "DRAFT" | "PAID" | "VOID" | "PENDING";
};
type Fixture = { label: string; total: number; payments: Pay[]; due: boolean };

/** label -> what it models; `due` is the expected `balance > 0` (the hand-checked oracle). */
const FIXTURES: Fixture[] = [
  { label: "unpaid", total: 100, payments: [], due: true },
  { label: "partial", total: 100, payments: [{ amount: 90 }], due: true },
  { label: "exact", total: 100, payments: [{ amount: 100 }], due: false },
  { label: "overpaid", total: 100, payments: [{ amount: 110 }], due: false },
  {
    label: "exact-two-cash",
    total: 100.1,
    payments: [{ amount: 50.05 }, { amount: 50.05 }],
    due: false,
  },
  { label: "draft-payment", total: 100, payments: [{ amount: 100, status: "DRAFT" }], due: true },
  { label: "void-payment", total: 100, payments: [{ amount: 100, status: "VOID" }], due: true },
  { label: "pending-check", total: 100, payments: [{ amount: 100, status: "PENDING" }], due: true },
  {
    label: "credit-note-partial",
    total: 100,
    payments: [{ amount: 40, method: "CREDIT_NOTE" }],
    due: true,
  },
  {
    label: "credit-note-exact",
    total: 100,
    payments: [{ amount: 100, method: "CREDIT_NOTE" }],
    due: false,
  },
  {
    label: "advance-partial",
    total: 100,
    payments: [{ amount: 25, method: "ADVANCE" }],
    due: true,
  },
  {
    label: "mixed-exact",
    total: 100,
    payments: [
      { amount: 30, method: "CASH" },
      { amount: 20, method: "ADVANCE" },
      { amount: 50, method: "CREDIT_NOTE" },
      { amount: 99, method: "CASH", status: "DRAFT" },
      { amount: 99, method: "CASH", status: "VOID" },
    ],
    due: false,
  },
  { label: "one-cent-left", total: 100, payments: [{ amount: 99.99 }], due: true },
];

describeDb("balanceDueSql — SQL <-> TS parity (SA-770), real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const tenantId of [...tenantIds].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch((e) => {
        console.warn(
          `invoice-balance-sql.parity.db.spec: cleanup of tenant ${tenantId} failed: ${e}`,
        );
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanup(tenantId: string): Promise<void> {
    await prisma.invoicePayment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.tenantConfig.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa770-${RUN}-${seq}-${label}`,
      "invoice-balance-sql.parity.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA770 ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `SA770 ${label}`,
        contactName: label,
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, customerId: customer.id };
  }

  async function seedInvoice(
    s: { tenantId: string; customerId: string },
    f: { label: string; total: number; payments: Pay[] },
    opts: {
      status?: "SENT" | "VIEWED" | "PARTIAL" | "OVERDUE" | "PAID" | "DRAFT";
      dueDate?: Date | null;
      updatedAt?: Date;
    } = {},
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customerId,
        invoiceNumber: `INV-SA770-${RUN}-${f.label}`,
        status: opts.status ?? "SENT",
        subtotal: f.total,
        total: f.total,
        dueDate: opts.dueDate === undefined ? new Date("2026-09-01T00:00:00.000Z") : opts.dueDate,
        ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      },
    });
    for (const p of f.payments)
      await prisma.invoicePayment.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: inv.id,
          amount: p.amount,
          method: p.method ?? "CASH",
          status: p.status ?? "PAID",
        },
      });
    return inv.id;
  }

  /** The SQL side: every invoice of the tenant with the predicate evaluated in Postgres. */
  async function sqlBalanceDue(tenantId: string): Promise<Map<string, boolean>> {
    const rows = await prisma.$queryRaw<{ id: string; due: boolean }[]>(
      Prisma.sql`SELECT i."id" AS "id", (${balanceDueSql("i")}) AS "due"
                   FROM "Invoice" i WHERE i."tenantId" = ${tenantId}`,
    );
    return new Map(rows.map((r) => [r.id, r.due]));
  }

  it("the SQL predicate equals the TS `balanceDue > 0` of invoice-detail-read, fixture by fixture", async () => {
    const s = await seedTenant("parity");
    const ids = new Map<string, string>();
    for (const f of FIXTURES) ids.set(f.label, await seedInvoice(s, f));

    const sql = await sqlBalanceDue(s.tenantId);
    for (const f of FIXTURES) {
      const id = ids.get(f.label)!;
      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id },
        include: { payments: true },
      });
      // SA-770 r-note: the oracle is THE TS classifier (and the detail read, built on it, agrees)
      const cutoff = overdueCutoff(new Date());
      const ts = classifyInvoiceBalance(row, cutoff).balanceDue > 0;
      expect({ label: f.label, detail: deriveInvoiceDetailFields(row).balanceDue > 0 }).toEqual({
        label: f.label,
        detail: ts,
      });
      expect({ label: f.label, ts }).toEqual({ label: f.label, ts: f.due }); // the hand-checked oracle
      expect({ label: f.label, sql: sql.get(id) }).toEqual({ label: f.label, sql: ts }); // parity
    }
  });

  it("an invoice with no payment rows at all reads as owing its total (the LEFT side of the SUM)", async () => {
    const s = await seedTenant("nopay");
    const id = await seedInvoice(s, { label: "nopay", total: 10, payments: [] });
    expect((await sqlBalanceDue(s.tenantId)).get(id)).toBe(true);
  });

  it("overdueInvoiceIds selects exactly the past-due invoices that still owe, and the count agrees", async () => {
    const s = await seedTenant("ids");
    const owes = new Set<string>();
    const settled = new Set<string>();
    for (const f of FIXTURES) {
      const id = await seedInvoice(s, f);
      (f.due ? owes : settled).add(id);
    }
    // not past due (due today is not overdue): excluded whatever the balance
    const notDue = await seedInvoice(
      s,
      { label: "future", total: 100, payments: [] },
      { dueDate: new Date("2026-10-20T00:00:00.000Z") },
    );
    // a closed status never enters, even with a balance
    const draft = await seedInvoice(
      s,
      { label: "draft-status", total: 100, payments: [] },
      { status: "DRAFT" },
    );
    const cutoff = new Date("2026-10-02T00:00:00.000Z");
    const statuses = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] as const;

    const ids = await overdueInvoiceIds(prisma, s.tenantId, cutoff, { statuses });
    expect(new Set(ids)).toEqual(owes);
    for (const id of settled) expect(ids).not.toContain(id);
    expect(ids).not.toContain(notDue);
    expect(ids).not.toContain(draft);
    expect(await overdueInvoiceCount(prisma, s.tenantId, cutoff, { statuses })).toBe(owes.size);

    // the TS classifier's `isOverdue` selects exactly the same open invoices as the SQL reader
    const rows = await prisma.invoice.findMany({
      where: { tenantId: s.tenantId, status: { in: [...statuses] } },
      include: { payments: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect({ id: row.id, overdue: classifyInvoiceBalance(row, cutoff).isOverdue }).toEqual({
        id: row.id,
        overdue: ids.includes(row.id),
      });
    }
  });

  it("is tenant-scoped: another tenant's overdue invoices never appear", async () => {
    const a = await seedTenant("scope-a");
    const b = await seedTenant("scope-b");
    const mine = await seedInvoice(a, { label: "a-owes", total: 50, payments: [] });
    const theirs = await seedInvoice(b, { label: "b-owes", total: 50, payments: [] });
    const cutoff = new Date("2026-10-02T00:00:00.000Z");
    const ids = await overdueInvoiceIds(prisma, a.tenantId, cutoff, { statuses: ["SENT"] });
    expect(ids).toEqual([mine]);
    expect(ids).not.toContain(theirs);
  });

  it("markInvoicesOverdue flips only the unpaid past-due SENT/VIEWED, never a paid or overpaid one, and stamps updatedAt on the flipped rows only", async () => {
    const s = await seedTenant("sweep");
    const OLD = new Date("2026-01-01T00:00:00.000Z");
    const owes = await seedInvoice(
      s,
      { label: "sweep-owes", total: 100, payments: [] },
      { updatedAt: OLD },
    );
    const viewed = await seedInvoice(
      s,
      { label: "sweep-viewed", total: 100, payments: [] },
      { status: "VIEWED", updatedAt: OLD },
    );
    const exact = await seedInvoice(
      s,
      { label: "sweep-exact", total: 100, payments: [{ amount: 100 }] },
      { updatedAt: OLD },
    );
    const over = await seedInvoice(
      s,
      { label: "sweep-over", total: 100, payments: [{ amount: 150 }] },
      { updatedAt: OLD },
    );
    const partial = await seedInvoice(
      s,
      { label: "sweep-partial", total: 100, payments: [{ amount: 10 }] },
      { status: "PARTIAL", updatedAt: OLD },
    );
    const cutoff = new Date("2026-10-02T00:00:00.000Z");

    const n = await markInvoicesOverdue(prisma, s.tenantId, cutoff, ["SENT", "VIEWED"]);
    expect(n).toBe(2); // owes + viewed

    const row = (id: string) =>
      prisma.invoice.findUniqueOrThrow({
        where: { id },
        select: { status: true, updatedAt: true },
      });
    for (const id of [owes, viewed]) {
      const r = await row(id);
      expect(r.status).toBe("OVERDUE");
      expect(r.updatedAt.getTime()).toBeGreaterThan(OLD.getTime()); // a raw UPDATE must stamp it itself
    }
    for (const [id, status] of [
      [exact, "SENT"],
      [over, "SENT"],
      [partial, "PARTIAL"],
    ] as const) {
      const r = await row(id);
      expect(r.status).toBe(status);
      expect(r.updatedAt.getTime()).toBe(OLD.getTime()); // untouched, not even re-stamped
    }
  });

  it("cutoff boundary in an off-UTC tenant zone: due == cutoff is still grace, cutoff - 1 ms is overdue (pins the ::timestamp cast)", async () => {
    const s = await seedTenant("boundary");
    await prisma.tenantConfig.create({
      data: { tenantId: s.tenantId, timezone: "America/Chicago" },
    });
    // 04:30Z on Oct 2 is 23:30 on Oct 1 in Chicago: the tenant's today is Oct 1, so the cutoff is the
    // UTC-midnight stamp of Oct 1 and an invoice due Oct 1 is still inside its grace day.
    const now = new Date("2026-10-02T04:30:00.000Z");
    const cutoff = overdueCutoff(now, "America/Chicago");
    expect(cutoff.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    const atCutoff = await seedInvoice(
      s,
      { label: "edge-at", total: 100, payments: [] },
      { dueDate: cutoff },
    );
    const justBefore = await seedInvoice(
      s,
      { label: "edge-before", total: 100, payments: [] },
      { dueDate: new Date(cutoff.getTime() - 1) },
    );
    const justAfter = await seedInvoice(
      s,
      { label: "edge-after", total: 100, payments: [] },
      { dueDate: new Date(cutoff.getTime() + 1) },
    );
    const statuses = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] as const;

    // the readers agree on the boundary...
    expect(await overdueInvoiceIds(prisma, s.tenantId, cutoff, { statuses })).toEqual([justBefore]);
    expect(await overdueInvoiceCount(prisma, s.tenantId, cutoff, { statuses })).toBe(1);
    // ...and so does the sweep, end to end through the tenant's zone
    expect(await markOverdueForTenant(prisma, s.tenantId, now, { dryRun: true })).toBe(1);
    expect(await markOverdueForTenant(prisma, s.tenantId, now)).toBe(1);
    const status = async (id: string) =>
      (await prisma.invoice.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    expect(await status(justBefore)).toBe("OVERDUE");
    expect(await status(atCutoff)).toBe("SENT");
    expect(await status(justAfter)).toBe("SENT");
  });
  it("R4 'partial-past-due': a PARTIAL invoice that owes $5 is in the list's overdue ids, classifier-overdue, and in the KPI overdue bucket with the OVERDUE one", async () => {
    const s = await seedTenant("partial-past-due");
    // INV-0014: PARTIAL, total 35, 30 confirmed -> owes 5, due Sep 15 (the sweep never flips PARTIAL)
    const partial = await seedInvoice(
      s,
      { label: "partial-past-due", total: 35, payments: [{ amount: 30 }] },
      { status: "PARTIAL", dueDate: new Date("2026-09-15T00:00:00.000Z") },
    );
    // INV-0016: OVERDUE, total 30, nothing paid -> owes 30
    const overdue = await seedInvoice(
      s,
      { label: "overdue-unpaid", total: 30, payments: [] },
      { status: "OVERDUE", dueDate: new Date("2026-09-10T00:00:00.000Z") },
    );
    const cutoff = new Date("2026-10-02T00:00:00.000Z");

    // the LIST: the statuses the isOverdue filter composes, through the one SQL predicate
    const where: any = {};
    applyInvoiceStatusFilters(where, { isOverdue: true } as any, null);
    expect(where.status.in).toContain("PARTIAL");
    const ids = await overdueInvoiceIds(prisma, s.tenantId, cutoff, { statuses: where.status.in });
    expect(new Set(ids)).toEqual(new Set([partial, overdue]));
    expect(
      await overdueInvoiceCount(prisma, s.tenantId, cutoff, { statuses: where.status.in }),
    ).toBe(2);

    // the TS classifier says the same about the same rows
    const rows = await prisma.invoice.findMany({
      where: { tenantId: s.tenantId },
      include: { payments: true },
    });
    const byId = new Map(rows.map((r) => [r.id, classifyInvoiceBalance(r, cutoff)]));
    expect(byId.get(partial)).toEqual({ balanceDue: 5, isOverdue: true });
    expect(byId.get(overdue)).toEqual({ balanceDue: 30, isOverdue: true });

    // the KPI overdue bucket = the sum of exactly those balances ($35.00, the Release 4 tile)
    const kpi = await tenantCtx.run(s.tenantId, () =>
      computeInvoiceKpiSummary(
        { prisma, resolveTenantInvoiceDefaults: async () => ({ timezone: null }) },
        "2026-10-02",
        { sub: "op", role: "OPERATOR" } as any,
      ),
    );
    expect(kpi.overdue).toBe(35);
  });
});
