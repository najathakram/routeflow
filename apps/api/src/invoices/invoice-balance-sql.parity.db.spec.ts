/**
 * SA-770 (ACTION-ITEMS row 294) — DB-lane PARITY PIN for `balanceDueSql`: the SQL predicate and the
 * TypeScript `balanceDue` every invoice read shows (`deriveInvoiceDetailFields`, invoice-detail-read.ts)
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
import {
  balanceDueSql,
  markInvoicesOverdue,
  overdueInvoiceCount,
  overdueInvoiceIds,
} from "./invoice-balance-sql";
import { Prisma } from "@prisma/client";

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
      const ts = deriveInvoiceDetailFields(row).balanceDue > 0;
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

  it("markInvoicesOverdue flips only the unpaid past-due SENT/VIEWED, never a paid or overpaid one", async () => {
    const s = await seedTenant("sweep");
    const owes = await seedInvoice(s, { label: "sweep-owes", total: 100, payments: [] });
    const viewed = await seedInvoice(
      s,
      { label: "sweep-viewed", total: 100, payments: [] },
      { status: "VIEWED" },
    );
    const exact = await seedInvoice(s, {
      label: "sweep-exact",
      total: 100,
      payments: [{ amount: 100 }],
    });
    const over = await seedInvoice(s, {
      label: "sweep-over",
      total: 100,
      payments: [{ amount: 150 }],
    });
    const partial = await seedInvoice(
      s,
      { label: "sweep-partial", total: 100, payments: [{ amount: 10 }] },
      { status: "PARTIAL" },
    );
    const cutoff = new Date("2026-10-02T00:00:00.000Z");

    const n = await markInvoicesOverdue(prisma, s.tenantId, cutoff, ["SENT", "VIEWED"]);
    expect(n).toBe(2); // owes + viewed

    const status = async (id: string) =>
      (await prisma.invoice.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    expect(await status(owes)).toBe("OVERDUE");
    expect(await status(viewed)).toBe("OVERDUE");
    expect(await status(exact)).toBe("SENT");
    expect(await status(over)).toBe("SENT");
    expect(await status(partial)).toBe("PARTIAL");
  });
});
