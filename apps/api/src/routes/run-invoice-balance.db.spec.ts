/**
 * B810/SA-130a — DB-lane proof that `payableInvoiceFindManyArgs`'s query actually
 * EXECUTES against a real Postgres and returns the shape `groupPayableInvoicesByOrder`
 * expects. This is the standing gate the mocked-Prisma specs cannot satisfy: Opus's
 * round-1 finding on this PR was `payableInvoices` selected as if it were a relation on
 * `Order` — a shape a mocked client happily returns but the REAL client rejects with
 * `Unknown field 'payableInvoices'`. This spec seeds real rows and calls the real
 * `invoice.findMany` with the exact args this module builds, so a schema/query mismatch
 * fails here instead of in prod.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`;
 * the real connection is built in `beforeAll` (never at collection time) and
 * `requireLocalDatabaseUrl()` refuses any non-local host. SAFETY: every tenant is a
 * throwaway `qa-b810-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes
 * exactly the tenants THIS run created, in FK order.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  groupPayableInvoicesByOrder,
  payableInvoiceFindManyArgs,
  type RawInvoiceForBalance,
} from "./run-invoice-balance";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("payableInvoiceFindManyArgs — real Postgres proof (B810/SA-130a)", () => {
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
        console.warn(`run-invoice-balance.db.spec: cleanup of tenant ${tenantId} failed: ${e}`);
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanup(tenantId: string): Promise<void> {
    await prisma.invoicePayment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-b810-${RUN}-${seq}`, "run-invoice-balance.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `B810 ${slug}` } });
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
        businessName: `B810 ${label}`,
        contactName: label,
        tenantId: tenant.id,
      },
    });
    const order = await prisma.order.create({
      data: { tenantId: tenant.id, customerId: customer.id, status: "DELIVERED", total: 100 },
    });
    return { tenantId: tenant.id, customerId: customer.id, orderId: order.id };
  }

  async function invoice(
    s: { tenantId: string; customerId: string; orderId: string },
    label: string,
    over: {
      status: "DRAFT" | "SENT" | "PARTIAL" | "OVERDUE" | "PAID" | "VOID";
      total: number;
      depositPercent?: number;
      payments?: Array<{ amount: number; status?: "PAID" | "PENDING" }>;
    },
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customerId,
        orderId: s.orderId,
        invoiceNumber: `INV-B810-${RUN}-${label}`,
        status: over.status,
        subtotal: over.total,
        total: over.total,
        depositPercent: over.depositPercent ?? null,
      },
    });
    for (const p of over.payments ?? [])
      await prisma.invoicePayment.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: inv.id,
          amount: p.amount,
          method: "CASH",
          status: p.status ?? "PAID",
        },
      });
    return inv;
  }

  // Scoped through the SAME tenantId the seed created — matches
  // routes.service.ts's real usage (`this.prisma.forTenant().invoice.findMany(...)`)
  // exactly, so this proves the query under real tenant scoping, not a bypass.
  const fetchRaw = (tenantId: string, orderIds: string[]): Promise<RawInvoiceForBalance[]> =>
    tenantCtx.run(tenantId, () =>
      prisma.forTenant().invoice.findMany(payableInvoiceFindManyArgs(orderIds)),
    ) as unknown as Promise<RawInvoiceForBalance[]>;

  it("the exact query executes and returns balanceDue = total - confirmed payments for a SENT invoice", async () => {
    const s = await seed("sent");
    await invoice(s, "a", { status: "SENT", total: 100, payments: [{ amount: 40 }] });

    const rows = await fetchRaw(s.tenantId, [s.orderId]);
    const byOrder = groupPayableInvoicesByOrder(rows);

    expect(byOrder[s.orderId]).toEqual([
      { id: rows[0]!.id, status: "SENT", total: 100, balanceDue: 60, isDepositMirror: false },
    ]);
  });

  it("excludes VOID and PAID from the returned set, but VOID never reaches even the raw rows (query-level where), while PAID does (filtered by groupPayableInvoicesByOrder)", async () => {
    const s = await seed("statuses");
    await invoice(s, "void", { status: "VOID", total: 50 });
    await invoice(s, "paid", { status: "PAID", total: 30, payments: [{ amount: 30 }] });
    await invoice(s, "sent", { status: "SENT", total: 20 });

    const rows = await fetchRaw(s.tenantId, [s.orderId]);
    expect(rows.map((r) => r.status).sort()).toEqual(["PAID", "SENT"]); // VOID excluded at the query
    const byOrder = groupPayableInvoicesByOrder(rows);
    expect(byOrder[s.orderId]!.map((i) => i.status)).toEqual(["SENT"]); // PAID excluded by PAYABLE filter
  });

  it("a PENDING (unconfirmed) payment is never subtracted — balanceDue stays at the full total", async () => {
    const s = await seed("pending");
    await invoice(s, "a", {
      status: "SENT",
      total: 80,
      payments: [{ amount: 80, status: "PENDING" }],
    });

    const rows = await fetchRaw(s.tenantId, [s.orderId]);
    expect(groupPayableInvoicesByOrder(rows)[s.orderId]![0]!.balanceDue).toBe(80);
  });

  it("isDepositMirror is true for the order's sole non-void deposit invoice, real round-trip through Postgres's Decimal columns", async () => {
    const s = await seed("mirror");
    await invoice(s, "a", { status: "SENT", total: 100, depositPercent: 25 });

    const rows = await fetchRaw(s.tenantId, [s.orderId]);
    const byOrder = groupPayableInvoicesByOrder(rows);
    expect(byOrder[s.orderId]![0]!.isDepositMirror).toBe(true);
  });

  it("isDepositMirror is false once a second non-void invoice exists for the same order, even though the deposit one is still PAYABLE", async () => {
    const s = await seed("mirror-not-sole");
    await invoice(s, "a", { status: "SENT", total: 100, depositPercent: 25 });
    await invoice(s, "b", { status: "PAID", total: 20 });

    const rows = await fetchRaw(s.tenantId, [s.orderId]);
    const byOrder = groupPayableInvoicesByOrder(rows);
    expect(byOrder[s.orderId]!.find((i) => i.status === "SENT")!.isDepositMirror).toBe(false);
  });

  it("batches across multiple orders in ONE call and groups each independently — matches routes.service.ts's page-wide fetch (never per-order/per-run)", async () => {
    const s = await seed("multi-order");
    const otherOrder = await prisma.order.create({
      data: { tenantId: s.tenantId, customerId: s.customerId, status: "DELIVERED", total: 90 },
    });
    await invoice(s, "o1", { status: "SENT", total: 60, payments: [{ amount: 10 }] });
    await invoice({ ...s, orderId: otherOrder.id }, "o2", {
      status: "PARTIAL",
      total: 90,
      payments: [{ amount: 30 }],
    });

    const rows = await fetchRaw(s.tenantId, [s.orderId, otherOrder.id]);
    const byOrder = groupPayableInvoicesByOrder(rows);
    expect(byOrder[s.orderId]![0]!.balanceDue).toBe(50);
    expect(byOrder[otherOrder.id]![0]!.balanceDue).toBe(60);
  });

  it("never leaks another tenant's invoice for the same order id shape (tenant isolation under forTenant())", async () => {
    const s = await seed("isolation");
    await invoice(s, "a", { status: "SENT", total: 40 });
    const other = await seed("isolation-other");

    const rowsUnderOther = await fetchRaw(other.tenantId, [s.orderId]);
    expect(rowsUnderOther).toEqual([]);
  });

  /**
   * SA-130b: an order carries a SENT deposit invoice (`depositPercent` set)
   * that is NOT the order's sole non-void invoice, because a separate DRAFT
   * invoice also exists for the same order (e.g. an order edit after the
   * deposit was collected re-reconciled a fresh draft for the new lines).
   * `isDepositMirror` must read false here (SA-102's WP-D1 shape requires
   * SOLE) — this test proves that, plus proves `recordDeliveryPaymentInTx`'s
   * own collection total from this module's query/mapping (F2 confirmed:
   * deposit 40 + draft 100 = 140, matching the fixture's own numbers below).
   *
   * What this does NOT prove — because the DRAFT here is a hand-seeded
   * fixture, not built via the real `reconcileOrderDraftInvoice` recompute —
   * is whether that recompute already nets the already-collected deposit out
   * of a REAL draft's `total`. That is a separate, filed investigation
   * (spawned as a follow-up task from this session, not resolved in this PR
   * per the fleet lead's routing): it needs a spec that mutates a live order
   * and reads back the DRAFT that `reconcileOrderDraftInvoice`/
   * `resyncOrderInvoicesForEdit` actually rebuilds, not a fixture.
   */
  it("SA-130b: a SENT deposit invoice NOT sole (an open DRAFT also exists) — isDepositMirror false, balances match recordDeliveryPaymentInTx's own collection", async () => {
    const s = await seed("deposit-not-sole");
    const depositInvoice = await invoice(s, "deposit", {
      status: "SENT",
      total: 40,
      depositPercent: 40,
    });
    const draftInvoice = await invoice(s, "draft", { status: "DRAFT", total: 100 });

    const rows = await fetchRaw(s.tenantId, [s.orderId]);
    const byOrder = groupPayableInvoicesByOrder(rows);
    const payable = byOrder[s.orderId] ?? [];

    // isDepositMirror is false: the deposit invoice is no longer the order's
    // SOLE non-void invoice once the draft exists alongside it.
    const depositRow = payable.find((p) => p.id === depositInvoice.id);
    expect(depositRow?.isDepositMirror).toBe(false);
    expect(depositRow?.total).toBe(40);
    expect(depositRow?.balanceDue).toBe(40);

    // Ground truth for recordDeliveryPaymentInTx's own collection, oldest
    // first: depositRow.balanceDue from the SENT invoice, then
    // draftRow.balanceDue from the DRAFT — never reconciledDoorDue's
    // reconciledEstimate figure, which is a CLIENT-side re-derivation from
    // the order's current lines, not the draft's own stored `total`.
    const draftRow = payable.find((p) => p.id === draftInvoice.id);
    expect(draftRow?.total).toBe(100);
    expect(draftRow?.balanceDue).toBe(100);
    expect((depositRow?.balanceDue ?? 0) + (draftRow?.balanceDue ?? 0)).toBe(140);
  });
});
