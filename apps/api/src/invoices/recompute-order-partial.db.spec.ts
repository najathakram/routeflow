/**
 * B667 (revenue loss) — DB-lane repro: `recomputeOrderFromInvoices` (fired by any DRAFT edit —
 * a discount, shipping, anything — on a PARTIAL invoice) treated "what the invoices currently
 * bill" as the WHOLE order, even when a partial invoice legitimately covers only some of it.
 *
 * Reachable path: `createPartialFromOrder` bills one line of a two-line order in full, leaving
 * the other line un-invoiced (still PENDING). Any subsequent DRAFT edit on that partial invoice
 * (`update()` with `discount` or `shippingFee` set) calls `recomputeOrderFromInvoices`, which:
 *   (a) treated the un-invoiced line as an ORPHAN ("billed by no invoice") and CANCELLED it
 *       (qty 0, subtotal 0) — though it was never actually refused, just not billed yet;
 *   (b) rewrote the ORDER's subtotal to only the billed sum, discarding the unbilled line's
 *       contribution.
 *
 * Fix: both (a) and (b) now run only when the order's invoices cover it WHOLLY — the same
 * precondition `resyncOrderInvoicesForEdit` documents (~L2007-2013): never partially invoiced,
 * whether that's one line billed for only part of its qty, or a subset of lines billed at full
 * qty while others are un-invoiced. See `finalize-order-recompute.ts`.
 *
 * #1185 review round 2 — three more cases folded in:
 *   1. (HIGH) coverage must be decided PER LINE, BEFORE the existing-line update loop runs —
 *      that loop matches a line billed for only PART of its qty too, so checking "matched vs
 *      not" only after it already ran let a partially-billed line's own row get silently
 *      shrunk to whatever is currently billed (order qty 10, bill 6 -> row becomes qty 6).
 *   2. (MED) a line an operator REMOVED from the only invoice that ever billed it still needs
 *      cancelling — that is the mechanism's original purpose. Distinguished by `invoicedQty`:
 *      > 0 and no longer billed -> a genuine orphan, cancel it; = 0 -> never billed, leave it.
 *   3. (MED) the shipping-fee back-sync must reach the order even while the rest of the
 *      recompute stays gated — `Order.shippingFee` is DEFINED as Σ(non-void invoice fees), a
 *      property of the invoices alone.
 *
 * #1185 review round 3 — round 2's own fix (decide coverage PER LINE, gate the rewrite behind
 * it) introduced two new ways for OrderItem.invoicedQty to go stale, because the ONLY place that
 * ever wrote it was the full-coverage rewrite loop — nothing touched it on the still-partial
 * branch:
 *   4. (HIGH) an invoice-item qty EDIT on a still-partial order never reached invoicedQty at
 *      all. Order line qty 10, invoice bills 4 (invoicedQty -> 4 via createPartialFromOrder).
 *      Edit that invoice's item UP to 6 -> still partial (6 < 10) -> old code returned early ->
 *      invoicedQty stuck at 4 -> a later invoice can still bill `10 - 4 = 6` more, landing 12
 *      billed against an order of 10. Edit DOWN instead (6 -> 2) -> invoicedQty stuck at the
 *      stale higher value -> the line is under-billable by the same margin.
 *   5. (MED) a line REMOVED from its invoice while a SIBLING line is what's actually keeping the
 *      order partial never got its invoicedQty released either — L1 fully billed, L2 billed
 *      then removed (invoicedQty stays stale, non-zero), L3 never billed (blocks coverage) ->
 *      old code's early return left L2 permanently unbillable, since `qty - invoicedQty` never
 *      recovers. Round 2's own finding-2 test (below) only covers the SINGLE-line case, where
 *      removal makes the order newly fully-covered and the ALREADY-EXISTING orphan-cancel loop
 *      runs — it can't reach a case gated behind a still-partial sibling.
 * Fix: sync every active line's invoicedQty from byTarget on the partial branch too (clamped to
 * the line's own qty, 0 when unmatched) — see `checkOrderCoverage`'s own loop and doc.
 *
 * WHY THE DB LANE: a mocked Prisma can't prove the read-then-write sequence across TWO tables
 * (OrderItem + Order), nor that the un-invoiced line's row is genuinely untouched (not just
 * returned as if untouched by a mock). Round 5 (SA-093, item B) corrects an earlier version of
 * this comment that claimed `recomputeOrderFromInvoices` always ran inside its own transaction —
 * it did not: called WITHOUT a `tx` (every real caller, per invoices.service.ts), each write was
 * its own round trip, no atomicity across OrderItem/Order at all. It NOW opens its own
 * `tenantTransaction`, under an order-keyed advisory lock (`common/db-locks.ts`'s
 * `withAdvisoryLock`, family `"order-merge"`), whenever no caller-supplied `tx` is given; called
 * WITH one (a caller already inside its own transaction), it shares that tx as before and takes
 * no lock of its own. A mock cannot prove either the atomicity or the lock actually serializes
 * two concurrent calls on the same order — only a real DB can. Collected only by
 * `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * Harness: same provider/mock shape as `invoice-delete-credit.db.spec.ts` — a real
 * `InvoicesService` wired to a real `PrismaService` (compose DB) + `TenantContextService`,
 * every other collaborator mocked at the module boundary.
 *
 * SAFETY: every tenant is a throwaway `qa-b667-<run>-<n>` slug (`assertTestTenant`);
 * `afterAll` deletes exactly the rows this run created, in FK order.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { withAdvisoryLock } from "../common/db-locks";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b667-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "recompute-order-partial.db.spec.ts",
  );
}

describeDb(
  "B667 — partial invoice + DRAFT edit must never cancel unbilled lines, real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    const createdTenantIds: string[] = [];

    const mockGateway = {
      emitInvoiceUpdated: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitLowStock: jest.fn(),
      emitStopCompleted: jest.fn(),
      emitUrgentOrder: jest.fn(),
    };
    const mockEmailService = {
      sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
      isEmailConfigured: jest.fn().mockResolvedValue(true),
    };
    const mockSystemConfig = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const mockCreditNotes = {
      autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
      releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
    };
    const mockMessaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };
    const mockStorage = {
      upload: jest.fn().mockResolvedValue("stored"),
      presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
    const mockCommissionEngine = {
      syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
      syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
      removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
    };

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          EstimatesService,
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          { provide: RouteFlowGateway, useValue: mockGateway },
          { provide: EmailService, useValue: mockEmailService },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          { provide: SystemConfigService, useValue: mockSystemConfig },
          {
            provide: RegulatedLedgerService,
            useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
          },
          {
            provide: AuthorizationGuardService,
            useValue: {
              assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
              checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
            },
          },
          { provide: CreditNotesService, useValue: mockCreditNotes },
          { provide: MessagingService, useValue: mockMessaging },
          { provide: StorageService, useValue: mockStorage },
          {
            provide: EntitlementAuthority,
            inject: [EntitlementsService],
            useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
              can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
            }),
          },
          { provide: EntitlementsService, useValue: mockEntitlements },
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();

      invoicesService = module.get(InvoicesService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => {
          // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
        });
      }
      await prisma?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      await prisma.invoiceItem.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.orderItem.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }

    /** Tenant + customer boilerplate shared by every scenario below. */
    async function seedTenantAndCustomer(label: string) {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `B667 ${slug}` } });
      createdTenantIds.push(tenant.id);
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
          businessName: `B667 ${slug}`,
          contactName: `B667 ${slug}`,
          tenantId: tenant.id,
        },
      });
      return { slug, tenant, customer };
    }

    /**
     * A tenant with a PARTIALLY_DELIVERED order of two lines: A (qty 4 @ $10 = $40) and
     * B (qty 6 @ $5 = $30, order subtotal 70). Bills A in full via createPartialFromOrder,
     * leaving B untouched (still PENDING, qty 6, subtotal 30, invoicedQty 0).
     */
    async function seedPartiallyInvoicedOrder(label: string) {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `B667 ${slug}` } });
      createdTenantIds.push(tenant.id);
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
          businessName: `B667 ${slug}`,
          contactName: `B667 ${slug}`,
          tenantId: tenant.id,
        },
      });
      const productA = await prisma.product.create({
        data: { name: `A ${slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const productB = await prisma.product.create({
        data: { name: `B ${slug}`, unit: "ea", pricePerUnit: 5, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 70,
          total: 70,
          tenantId: tenant.id,
        },
      });
      const lineA = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: productA.id,
          status: "PENDING",
          qty: 4,
          unitPrice: 10,
          subtotal: 40,
          tenantId: tenant.id,
        },
      });
      const lineB = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: productB.id,
          status: "PENDING",
          qty: 6,
          unitPrice: 5,
          subtotal: 30,
          tenantId: tenant.id,
        },
      });

      return tenantCtx.run(tenant.id, async () => {
        const invoice = await invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineA.id, qty: 4 }],
        });
        return { tenant, order, lineA, lineB, invoice };
      });
    }

    it("a DRAFT edit (discount) on a partial invoice leaves the unbilled line PENDING at its own qty/subtotal", async () => {
      const { order, lineB, invoice } = await seedPartiallyInvoicedOrder("a");

      await tenantCtx.run(order.tenantId!, () =>
        invoicesService.update((invoice as any).id, { discount: 0 } as any),
      );

      const refreshed = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineB.id } });
      expect(refreshed.status).toBe("PENDING"); // NOT CANCELLED
      expect(Number(refreshed.qty)).toBe(6); // NOT zeroed
      expect(Number(refreshed.subtotal)).toBe(30); // NOT zeroed
      expect(Number(refreshed.invoicedQty)).toBe(0);
    });

    it("the same edit leaves the ORDER subtotal at 70 — never rewritten to just the billed 40", async () => {
      const { order, invoice } = await seedPartiallyInvoicedOrder("b");

      await tenantCtx.run(order.tenantId!, () =>
        invoicesService.update((invoice as any).id, { discount: 0 } as any),
      );

      const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(Number(refreshedOrder.subtotal)).toBe(70); // NOT 40
      expect(Number(refreshedOrder.total)).toBe(70);
    });

    it("the orphan-cancel loop's remaining job: normalizes an ALREADY-cancelled line's stale qty/subtotal once the order is fully covered (a genuinely un-billed ACTIVE line can never reach this loop — it is what blocks full coverage in the first place)", async () => {
      const slug = freshTenantSlug("d");
      const tenant = await prisma.tenant.create({ data: { slug, name: `B667 ${slug}` } });
      createdTenantIds.push(tenant.id);
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
          businessName: `B667 ${slug}`,
          contactName: `B667 ${slug}`,
          tenantId: tenant.id,
        },
      });
      const productA = await prisma.product.create({
        data: { name: `A ${slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 40,
          total: 40,
          tenantId: tenant.id,
        },
      });
      const lineA = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: productA.id,
          status: "PENDING",
          qty: 4,
          unitPrice: 10,
          subtotal: 40,
          tenantId: tenant.id,
        },
      });
      // Already cancelled by a normal order edit (unrelated to invoicing) — but stale: a prior bug
      // or a race left its qty/subtotal non-zero. No invoice will EVER bill this line; it must
      // never block full coverage, and its stale numbers should get zeroed once the order is.
      const lineC = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: null,
          status: "CANCELLED",
          qty: 3,
          unitPrice: 5,
          subtotal: 15,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineA.id, qty: 4 }],
        }),
      );
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, { discount: 0 } as any),
      );

      const refreshedC = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineC.id } });
      expect(refreshedC.status).toBe("CANCELLED");
      expect(Number(refreshedC.qty)).toBe(0); // normalized — was stale at 3
      expect(Number(refreshedC.subtotal)).toBe(0); // normalized — was stale at 15
    });

    it("finding 1 (HIGH, #1185): a line billed for only PART of its qty keeps its FULL qty/subtotal — the update loop never runs while any line is under-billed", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("e");
      const product = await prisma.product.create({
        data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 100,
          total: 100,
          tenantId: tenant.id,
        },
      });
      const lineA = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        // Bill only 6 of the 10 — a PARTIAL bill on a SINGLE line (not a separate unbilled line).
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineA.id, qty: 6 }],
        }),
      );
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, { discount: 0 } as any),
      );

      const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
      expect(refreshedA.status).toBe("PENDING");
      expect(Number(refreshedA.qty)).toBe(10); // NOT shrunk to the billed 6
      expect(Number(refreshedA.subtotal)).toBe(100); // NOT shrunk to 60
      const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(Number(refreshedOrder.subtotal)).toBe(100); // NOT rewritten to 60
      expect(Number(refreshedOrder.total)).toBe(100);
    });

    it("finding 2 (MED, #1185): a line removed from the only invoice that billed it IS a genuine orphan (invoicedQty > 0) — cancels it, distinct from a never-billed line (invoicedQty 0, test 1 above) which never does", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("f");
      const product = await prisma.product.create({
        data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 40,
          total: 40,
          tenantId: tenant.id,
        },
      });
      const lineA = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 4,
          unitPrice: 10,
          subtotal: 40,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        // Bill it in FULL first (invoicedQty -> 4) …
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineA.id, qty: 4 }],
        }),
      );
      // … then the operator removes it from the invoice entirely (replaces the item list with
      // none). The line's invoicedQty (4) still records that it WAS billed — that is exactly
      // what distinguishes it from a line that was simply never invoiced.
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, { items: [] } as any),
      );

      const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
      expect(refreshedA.status).toBe("CANCELLED");
      expect(Number(refreshedA.qty)).toBe(0);
      expect(Number(refreshedA.subtotal)).toBe(0);
      expect(Number(refreshedA.invoicedQty)).toBe(0);
    });

    it("finding 3 (MED, #1185): a shipping-fee edit on a partial invoice still back-syncs Order.shippingFee — while subtotal/the unbilled line stay gated exactly as in test 1", async () => {
      const { order, lineB, invoice } = await seedPartiallyInvoicedOrder("g");

      await tenantCtx.run(order.tenantId!, () =>
        invoicesService.update((invoice as any).id, { shippingFee: 15 } as any),
      );

      const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(Number(refreshedOrder.shippingFee)).toBe(15); // synced despite the gate
      expect(Number(refreshedOrder.total)).toBe(85); // 70 (unchanged subtotal) + the new fee
      expect(Number(refreshedOrder.subtotal)).toBe(70); // still gated — NOT rewritten to 40
      const refreshedB = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineB.id } });
      expect(refreshedB.status).toBe("PENDING"); // still gated — NOT cancelled
      expect(Number(refreshedB.qty)).toBe(6);
    });

    it("finding 4 (HIGH, #1185 rd3): an invoice-item qty EDIT on a still-partial order keeps invoicedQty in sync in BOTH directions, so a later invoice can never over- or under-bill the gap", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("h");
      const product = await prisma.product.create({
        data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 100,
          total: 100,
          tenantId: tenant.id,
        },
      });
      const lineA = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineA.id, qty: 4 }],
        }),
      );
      const afterBill4 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
      expect(Number(afterBill4.invoicedQty)).toBe(4);

      // UP-edit: 4 -> 6. Still partial (6 < 10) — the old code returned early and left
      // invoicedQty stuck at 4, letting a later invoice bill `10 - 4 = 6` more (12 against 10).
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, {
          items: [{ productId: product.id, qty: 6, unitPrice: 10, description: "A" }],
        } as any),
      );
      const afterUp = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
      expect(afterUp.status).toBe("PENDING"); // still gated — order not fully covered
      expect(Number(afterUp.qty)).toBe(10); // the line's own qty is untouched (round 2, finding 1)
      expect(Number(afterUp.invoicedQty)).toBe(6); // NOT stuck at 4

      // DOWN-edit: 6 -> 2. The old code (had it even reached here) would have left invoicedQty
      // at whatever stale value it last saw — this proves the sync tracks EITHER direction.
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, {
          items: [{ productId: product.id, qty: 2, unitPrice: 10, description: "A" }],
        } as any),
      );
      const afterDown = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
      expect(Number(afterDown.invoicedQty)).toBe(2); // NOT stuck at 6
    });

    it("finding 5 (MED, #1185 rd3): a line REMOVED from its invoice while a sibling keeps the order partial still releases its invoicedQty, so it can be invoiced again", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("i");
      const productA = await prisma.product.create({
        data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const productB = await prisma.product.create({
        data: { name: `B ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 120,
          total: 120,
          tenantId: tenant.id,
        },
      });
      // L1: fully billed. L2: billed, then removed. L3: never billed — the ONLY thing keeping
      // the order partial once L2 is removed, so L2's release must NOT depend on becoming the
      // sole blocker (round 2's own finding-2 test covers the single-line case, where removal
      // makes the order newly fully-covered and the orphan-cancel loop runs instead of this sync).
      const lineL1 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: productA.id,
          status: "PENDING",
          qty: 4,
          unitPrice: 10,
          subtotal: 40,
          tenantId: tenant.id,
        },
      });
      const lineL2 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: productB.id,
          status: "PENDING",
          qty: 3,
          unitPrice: 10,
          subtotal: 30,
          tenantId: tenant.id,
        },
      });
      const lineL3 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: null,
          status: "PENDING",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [
            { orderItemId: lineL1.id, qty: 4 },
            { orderItemId: lineL2.id, qty: 3 },
          ],
        }),
      );
      const afterBill = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL2.id } });
      expect(Number(afterBill.invoicedQty)).toBe(3);

      // Remove L2's item from the invoice, keeping L1's. L3 (never billed) is untouched and
      // alone keeps the order partial — so this never reaches the fully-covered rewrite/orphan
      // loop at all.
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, {
          items: [{ productId: productA.id, qty: 4, unitPrice: 10, description: "A" }],
        } as any),
      );

      const refreshedL2 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL2.id } });
      expect(refreshedL2.status).toBe("PENDING"); // NOT cancelled — this sync only releases qty
      expect(Number(refreshedL2.qty)).toBe(3); // the line's own qty is untouched
      expect(Number(refreshedL2.invoicedQty)).toBe(0); // released — billable again
      const refreshedL1 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL1.id } });
      expect(Number(refreshedL1.invoicedQty)).toBe(4); // still-billed line stays in sync too
      const refreshedL3 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL3.id } });
      expect(Number(refreshedL3.invoicedQty)).toBe(0); // never billed — unaffected
    });

    it("review round 4 (HIGH): an item edit's product-only re-match must never credit an active line's billed qty onto a CANCELLED sibling of the same product", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("j");
      const product = await prisma.product.create({
        data: { name: `P ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 90,
          total: 90,
          tenantId: tenant.id,
        },
      });
      // L1: active, billed in full below. L2: SAME product, but CANCELLED -- created AFTER L1,
      // so the old `existingByProduct` Map (last-write-wins, no cancelled filter) resolves
      // product P to L2, not L1. L3: unbilled, keeps the order partial so this exercises the
      // invoicedQty-sync branch (not the full-coverage rewrite).
      const lineL1 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 4,
          unitPrice: 10,
          subtotal: 40,
          tenantId: tenant.id,
        },
      });
      const lineL2 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "CANCELLED",
          qty: 0,
          unitPrice: 10,
          subtotal: 0,
          tenantId: tenant.id,
        },
      });
      const lineL3 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: null,
          status: "PENDING",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineL1.id, qty: 4 }],
        }),
      );
      const afterBill = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL1.id } });
      expect(Number(afterBill.invoicedQty)).toBe(4);

      // The item edit drops orderItemId (SplitInvoiceModal/manual-edit shape) -- the only way
      // recomputeOrderFromInvoices' byTarget re-matches by product alone. L3 (never billed)
      // keeps the order partial, so this lands in the invoicedQty-sync loop, not the
      // full-coverage rewrite.
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, {
          items: [{ productId: product.id, qty: 4, unitPrice: 10, description: "P" }],
        } as any),
      );

      const refreshedL1 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL1.id } });
      // The old bug: the product-only match resolved to L2 (last-write-wins, cancelled-blind),
      // so L1's own row was never found in byTarget -> billedQty computed as 0 -> L1.invoicedQty
      // reset to 0, silently making the already-billed line billable again.
      expect(Number(refreshedL1.invoicedQty)).toBe(4); // NOT reset to 0
      expect(refreshedL1.status).toBe("PENDING");
      const refreshedL2 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL2.id } });
      expect(refreshedL2.status).toBe("CANCELLED"); // untouched
      expect(Number(refreshedL2.invoicedQty)).toBe(0);
    });

    it("control: once the SECOND line is also billed in full, the recompute applies — order subtotal becomes the billed sum", async () => {
      const { order, lineA, lineB, invoice } = await seedPartiallyInvoicedOrder("c");

      // Bill line B too — the order is now WHOLLY invoiced.
      await tenantCtx.run(order.tenantId!, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineB.id, qty: 6 }],
        }),
      );
      // Corrupt the order's stored total to a value the seed never produced (999, not 70) — a
      // real recompute is now the ONLY way back to 70. Without this, the assertion below would
      // pass even if finalizeOrderRecompute's gate wrongly stayed closed: 70 was already sitting
      // there from the seed, so "still 70" would prove nothing.
      await prisma.order.update({ where: { id: order.id }, data: { subtotal: 999, total: 999 } });

      // Any DRAFT edit on either invoice now recomputes with full coverage.
      await tenantCtx.run(order.tenantId!, () =>
        invoicesService.update((invoice as any).id, { discount: 0 } as any),
      );

      const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
      const refreshedB = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineB.id } });
      expect(refreshedA.status).toBe("PENDING");
      expect(refreshedB.status).toBe("PENDING"); // billed, not an orphan — never cancelled
      const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      // 40 + 30, corrected back from the 999 corruption — proves the recompute actually ran.
      expect(Number(refreshedOrder.subtotal)).toBe(70);
    });

    it("round 5, item 1 (HIGH): a line billed for only PART of its qty, then removed entirely, is released — NOT cancelled", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("k");
      const product = await prisma.product.create({
        data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 100,
          total: 100,
          tenantId: tenant.id,
        },
      });
      const lineA = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        // Bill only 4 of the 10 — a genuine partial bill on a SINGLE line.
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineA.id, qty: 4 }],
        }),
      );
      const afterBill = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
      expect(Number(afterBill.invoicedQty)).toBe(4);

      // Remove the item from its ONLY invoice entirely — the old code's unmatched-branch bug
      // read invoicedQty 4 > 0 as "covered" and cancelled the line outright, losing 6 units
      // that were never billed.
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, { items: [] } as any),
      );

      const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
      expect(refreshedA.status).toBe("PENDING"); // NOT cancelled
      expect(Number(refreshedA.qty)).toBe(10); // NOT zeroed
      expect(Number(refreshedA.subtotal)).toBe(100); // NOT zeroed
      expect(Number(refreshedA.invoicedQty)).toBe(0); // released — billable again
    });

    it("round 5, item 2 (HIGH): an ambiguous product match (2+ active lines, no orderItemId) is SKIPPED, never credited to the wrong line", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("l");
      const product = await prisma.product.create({
        data: { name: `P ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 150,
          total: 150,
          tenantId: tenant.id,
        },
      });
      // L1 and L2 are the SAME product (the ambiguity) — L3 is a different product, unbilled,
      // keeping the order partial so this exercises the sync loop, not the full rewrite.
      const lineL1 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 4,
          unitPrice: 10,
          subtotal: 40,
          tenantId: tenant.id,
        },
      });
      const lineL2 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 6,
          unitPrice: 10,
          subtotal: 60,
          tenantId: tenant.id,
        },
      });
      const lineL3 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: null,
          status: "PENDING",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        // Bill L2 specifically (precise, via orderItemId) — L1 stays un-billed.
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineL2.id, qty: 6 }],
        }),
      );
      const afterBill = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL2.id } });
      expect(Number(afterBill.invoicedQty)).toBe(6);

      // The item edit drops orderItemId (SplitInvoiceModal/manual-edit shape) — the only way
      // recomputeOrderFromInvoices' byTarget re-matches by product alone, and L1/L2 now share
      // one. The OLD bug: round 4's first-match picked L1, crediting L2's billed 6 onto L1 and
      // releasing L2 to 0 — enabling L2 to be billed again on top of what it already bills.
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, {
          items: [{ productId: product.id, qty: 6, unitPrice: 10, description: "P" }],
        } as any),
      );

      const refreshedL1 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL1.id } });
      const refreshedL2 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL2.id } });
      // Both left EXACTLY as they were before the ambiguous edit — bail, not guess.
      expect(Number(refreshedL1.invoicedQty)).toBe(0); // never billed, still 0 — not credited to
      expect(Number(refreshedL2.invoicedQty)).toBe(6); // still billed 6 — NOT released to 0
      const refreshedL3 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL3.id } });
      expect(Number(refreshedL3.invoicedQty)).toBe(0); // untouched, unrelated product
    });

    // SA-093a ruling (2+3), round 6: the ROOT fix. Same ambiguous-product shape as the test
    // above, but the client round-trips orderItemId on the edit -- proving the precise match
    // sidesteps the whole ambiguous-fallback path entirely (never even reaches the skip), so an
    // up-edit's new qty actually lands instead of the line staying stuck at its old invoicedQty.
    it("round 6 (ruling 2+3, HIGH): an up-edit WITH orderItemId syncs precisely even though the product is ambiguous -- no over-bill door", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("o1");
      const product = await prisma.product.create({
        data: { name: `P ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 150,
          total: 150,
          tenantId: tenant.id,
        },
      });
      // L1 and L2 share a product -- the SAME shape the round-5 interim fix could only bail on.
      const lineL1 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 4,
          unitPrice: 10,
          subtotal: 40,
          tenantId: tenant.id,
        },
      });
      const lineL2 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          tenantId: tenant.id,
        },
      });
      const lineL3 = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: null,
          status: "PENDING",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineL2.id, qty: 4 }],
        }),
      );
      const afterBill = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL2.id } });
      expect(Number(afterBill.invoicedQty)).toBe(4);

      // Up-edit 4 -> 6, WITH orderItemId this time (the client round-trips it, per the DTO's new
      // field). The precise match must apply -- L2's invoicedQty must actually MOVE to 6, not
      // stay stuck at 4 (which would let a later invoice bill 6 more: 4 + 6 + 6 = 16 against 10).
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, {
          items: [
            {
              orderItemId: lineL2.id,
              productId: product.id,
              qty: 6,
              unitPrice: 10,
              description: "P",
            },
          ],
        } as any),
      );

      const refreshedL2 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL2.id } });
      expect(Number(refreshedL2.invoicedQty)).toBe(6); // moved -- precise match, not stuck at 4
      const refreshedL1 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL1.id } });
      expect(Number(refreshedL1.invoicedQty)).toBe(0); // untouched -- never confused with L2
      const refreshedL3 = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineL3.id } });
      expect(Number(refreshedL3.invoicedQty)).toBe(0); // untouched, unrelated product
    });

    // SA-093a ruling (2+3): finding 3's own repro. A free-text (no productId) line that DOES
    // have an orderItemId must round-trip it through an edit -- losing it was finding 3's exact
    // bug (the line became matchless, its invoicedQty reset to 0, enabling a re-bill).
    it("round 6 (ruling 2+3, HIGH): a free-text line (no productId) WITH orderItemId is never re-billed after an edit", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("o2");
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 150,
          total: 150,
          tenantId: tenant.id,
        },
      });
      // No productId at all -- a manually-entered custom line item on the order.
      const lineFree = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: null,
          status: "PENDING",
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          tenantId: tenant.id,
        },
      });
      const lineOther = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: null,
          status: "PENDING",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: lineFree.id, qty: 10 }],
        }),
      );
      const afterBill = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineFree.id } });
      expect(Number(afterBill.invoicedQty)).toBe(10);

      // A no-op discount edit, but round-tripping orderItemId on the free-text item this time.
      await tenantCtx.run(tenant.id, () =>
        invoicesService.update((invoice as any).id, {
          items: [
            { orderItemId: lineFree.id, qty: 10, unitPrice: 10, description: "Custom charge" },
          ],
        } as any),
      );

      const refreshedFree = await prisma.orderItem.findUniqueOrThrow({
        where: { id: lineFree.id },
      });
      // Still billed 10 -- NOT reset to 0 (finding 3's bug), so it can never be billed again.
      expect(Number(refreshedFree.invoicedQty)).toBe(10);
      const refreshedOther = await prisma.orderItem.findUniqueOrThrow({
        where: { id: lineOther.id },
      });
      expect(Number(refreshedOther.invoicedQty)).toBe(0); // untouched
    });

    // Round 7, finding 3 (MED, #1185): assertOrderItemIdsBelongToOrder previously checked only
    // that the id resolved on this order -- a CANCELLED line, or a client-asserted productId
    // that doesn't match the real line, both resolved as if valid.
    describe("round 7, finding 3 (MED): assertOrderItemIdsBelongToOrder refuses more than a bare id match, real Postgres", () => {
      it("refuses an orderItemId that points to a CANCELLED line", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("q1");
        const product = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 150,
            total: 150,
            tenantId: tenant.id,
          },
        });
        const lineActive = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "PENDING",
            qty: 5,
            unitPrice: 10,
            subtotal: 50,
            tenantId: tenant.id,
          },
        });
        const lineCancelled = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "CANCELLED",
            qty: 0,
            unitPrice: 10,
            subtotal: 0,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineActive.id, qty: 5 }],
          }),
        );

        await expect(
          tenantCtx.run(tenant.id, () =>
            invoicesService.update((invoice as any).id, {
              items: [
                {
                  orderItemId: lineCancelled.id,
                  productId: product.id,
                  qty: 1,
                  unitPrice: 10,
                  description: "x",
                },
              ],
            } as any),
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it("refuses an orderItemId whose productId doesn't match a client-sent productId", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("q2");
        const productA = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const productB = await prisma.product.create({
          data: { name: `B ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 50,
            total: 50,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productA.id,
            status: "PENDING",
            qty: 5,
            unitPrice: 10,
            subtotal: 50,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 5 }],
          }),
        );

        await expect(
          tenantCtx.run(tenant.id, () =>
            // lineA is really productA -- claiming productB for the SAME orderItemId is refused.
            invoicesService.update((invoice as any).id, {
              items: [
                {
                  orderItemId: lineA.id,
                  productId: productB.id,
                  qty: 5,
                  unitPrice: 10,
                  description: "x",
                },
              ],
            } as any),
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it("refuses an orderItemId that belongs to a DIFFERENT order (foreign line)", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("q3");
        const product = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 50,
            total: 50,
            tenantId: tenant.id,
          },
        });
        const lineOnThisOrder = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "PENDING",
            qty: 5,
            unitPrice: 10,
            subtotal: 50,
            tenantId: tenant.id,
          },
        });
        // A second, unrelated order in the SAME tenant -- its line is foreign to the first order.
        const otherOrder = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 20,
            total: 20,
            tenantId: tenant.id,
          },
        });
        const foreignLine = await prisma.orderItem.create({
          data: {
            orderId: otherOrder.id,
            productId: product.id,
            status: "PENDING",
            qty: 2,
            unitPrice: 10,
            subtotal: 20,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineOnThisOrder.id, qty: 5 }],
          }),
        );

        await expect(
          tenantCtx.run(tenant.id, () =>
            invoicesService.update((invoice as any).id, {
              items: [
                {
                  orderItemId: foreignLine.id,
                  productId: product.id,
                  qty: 2,
                  unitPrice: 10,
                  description: "x",
                },
              ],
            } as any),
          ),
        ).rejects.toThrow(BadRequestException);
      });
    });

    it("round 5, item 3 (MED): the void path's product fallback never adjusts a CANCELLED line", async () => {
      const { tenant, customer } = await seedTenantAndCustomer("m");
      const product = await prisma.product.create({
        data: { name: `P ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "PARTIALLY_DELIVERED",
          subtotal: 40,
          total: 40,
          tenantId: tenant.id,
        },
      });
      // The ACTIVE line this invoice really bills, created AFTER a CANCELLED line of the same
      // product — the old bug's product fallback (`orderItems.find`) had no status filter, so
      // array order alone decided which row a legacy no-orderItemId invoice line's void/unvoid
      // adjusted; a CANCELLED row created first could still be picked.
      const cancelledSibling = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "CANCELLED",
          qty: 0,
          unitPrice: 10,
          subtotal: 0,
          invoicedQty: 0,
          tenantId: tenant.id,
        },
      });
      const activeLine = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "PENDING",
          qty: 4,
          unitPrice: 10,
          subtotal: 40,
          tenantId: tenant.id,
        },
      });

      const invoice = await tenantCtx.run(tenant.id, () =>
        invoicesService.createPartialFromOrder(order.id, {
          items: [{ orderItemId: activeLine.id, qty: 4 }],
        }),
      );
      // Legacy shape: strip orderItemId directly on the invoice item, forcing the void path's
      // product-only fallback (adjustInvoicedQtyForInvoice) to resolve it.
      await prisma.invoiceItem.updateMany({
        where: { invoiceId: (invoice as any).id },
        data: { orderItemId: null },
      });

      await tenantCtx.run(tenant.id, () => invoicesService.voidInvoice((invoice as any).id));

      const refreshedActive = await prisma.orderItem.findUniqueOrThrow({
        where: { id: activeLine.id },
      });
      const refreshedCancelled = await prisma.orderItem.findUniqueOrThrow({
        where: { id: cancelledSibling.id },
      });
      expect(Number(refreshedActive.invoicedQty)).toBe(0); // released — the void's real target
      expect(Number(refreshedCancelled.invoicedQty)).toBe(0); // untouched throughout
    });

    describe("SA-093a (round 6): mutation-row-keyed coverage basis, real Postgres", () => {
      it("(1) a short-delivered line (real DeliveryMutation row) shrinks to its billed qty, a refused sibling (REFUSED row) is cancelled", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("n1");
        const productA = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const productB = await prisma.product.create({
          data: { name: `B ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "DELIVERED",
            subtotal: 160,
            total: 160,
            tenantId: tenant.id,
          },
        });
        // A: ordered 10, delivered 6, billed 6 (a short delivery, correctly billed for what
        // arrived). B: ordered 6, refused — never billed, never billable.
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productA.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        const lineB = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productB.id,
            status: "PENDING",
            qty: 6,
            unitPrice: 10,
            subtotal: 60,
            tenantId: tenant.id,
          },
        });
        // SA-093a: the basis is the real DeliveryMutation ROW, never the deliveredQty column
        // (left at its default 0 for both lines here) and never order.status.
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: productA.id,
            type: "DELIVERED",
            quantityDelivered: 6,
            tenantId: tenant.id,
          },
        });
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineB.id,
            productId: productB.id,
            type: "REFUSED",
            quantityDelivered: 0,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 6 }],
          }),
        );
        await tenantCtx.run(tenant.id, () =>
          invoicesService.update((invoice as any).id, { discount: 0 } as any),
        );

        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(refreshedA.status).toBe("PENDING");
        expect(Number(refreshedA.qty)).toBe(6); // shrunk to what was actually billed/delivered
        expect(Number(refreshedA.subtotal)).toBe(60);
        const refreshedB = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineB.id } });
        expect(refreshedB.status).toBe("CANCELLED"); // refused — cancelled once covered
        const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(Number(refreshedOrder.total)).toBe(60);
      });

      it("(2) the SAME shape with NO DeliveryMutation rows at all changes nothing, even though the order status is DELIVERED (round 4's rule, unconstrained qty)", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("n2");
        const productA = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const productB = await prisma.product.create({
          data: { name: `B ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "DELIVERED", // status alone must not matter -- see (4) below, its own pin
            subtotal: 160,
            total: 160,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productA.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        const lineB = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productB.id,
            status: "PENDING",
            qty: 6,
            unitPrice: 10,
            subtotal: 60,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 6 }],
          }),
        );
        await tenantCtx.run(tenant.id, () =>
          invoicesService.update((invoice as any).id, { discount: 0 } as any),
        );

        // No mutation rows -> hasMutations:false -> every line's billable qty is unconstrained
        // (round 4's rule). A is still under-billed (6 of 10), so the order stays gated.
        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(refreshedA.status).toBe("PENDING");
        expect(Number(refreshedA.qty)).toBe(10); // NOT shrunk
        expect(Number(refreshedA.subtotal)).toBe(100);
        const refreshedB = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineB.id } });
        expect(refreshedB.status).toBe("PENDING"); // NOT cancelled — no mutation row says it's refused
        const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(Number(refreshedOrder.subtotal)).toBe(160); // unchanged — still gated
      });

      it("(3) a fully-delivered-and-billed line (real DeliveryMutation row), then removed from its invoice, is released — NOT cancelled", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("n3");
        const product = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: product.id,
            type: "DELIVERED",
            quantityDelivered: 10,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 4 }],
          }),
        );
        const afterBill = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(Number(afterBill.invoicedQty)).toBe(4);

        await tenantCtx.run(tenant.id, () =>
          invoicesService.update((invoice as any).id, { items: [] } as any),
        );

        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(refreshedA.status).toBe("PENDING"); // NOT cancelled — genuinely under-billed still
        expect(Number(refreshedA.invoicedQty)).toBe(0); // released
      });

      // SA-093a, finding 1's own repro: an order can be marked DELIVERED (changeStatus, the van
      // sale, or completeStop with no `dto.deliveries`) WITHOUT ever writing a DeliveryMutation
      // row or stamping deliveredQty. Round 5's status-keyed rule read every line on such an
      // order as billable 0 and finalizeOrderRecompute cancelled all of them -- a $160 order
      // silently going to $0. This is (2) above in a single-line shape, named as its own pin
      // because it's the exact repro the independent review verified against master.
      it("(4) DELIVERED via a bare status update (changeStatus shape), no mutation rows at all: nothing shrinks, nothing cancels -- stays fully priced (finding 1 repro)", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("n4");
        const product = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PENDING",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 4 }],
          }),
        );
        // The office marks the order DELIVERED directly (changeStatus's own shape) -- no
        // DeliveryMutation row, no deliveredQty stamp, exactly the gap the review found.
        await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });

        await tenantCtx.run(tenant.id, () =>
          invoicesService.update((invoice as any).id, { discount: 0 } as any),
        );

        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(refreshedA.status).toBe("PENDING"); // NOT cancelled
        expect(Number(refreshedA.qty)).toBe(10); // NOT shrunk to the 4 billed so far
        expect(Number(refreshedA.subtotal)).toBe(100); // NOT zeroed
        const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(Number(refreshedOrder.subtotal)).toBe(100); // the $100 stays $100, not $0
      });

      // completeStop writes DeliveryMutation rows but, unlike completeWithPayment, never stamps
      // OrderItem.deliveredQty -- proving the mutation-row basis is what actually governs, not
      // that stale/never-written column (which stays 0 here throughout).
      it("(5) DELIVERED via completeStop's shape (mutation rows present, deliveredQty column left at 0): the mutation basis applies", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("n5");
        const product = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
            // deliveredQty deliberately omitted -- stays at its schema default (0), exactly what
            // completeStop leaves it at (only completeWithPayment ever writes that column).
          },
        });
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: product.id,
            type: "DELIVERED",
            quantityDelivered: 6,
            tenantId: tenant.id,
          },
        });

        const preCheck = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(Number(preCheck.deliveredQty)).toBe(0); // the column really is untouched

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 6 }],
          }),
        );
        await tenantCtx.run(tenant.id, () =>
          invoicesService.update((invoice as any).id, { discount: 0 } as any),
        );

        // Billed exactly the mutation row's 6 -> fully covered and shrunk to 6, DESPITE the
        // deliveredQty column reading 0 throughout -- the mutation row is what actually governed.
        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(refreshedA.status).toBe("PENDING");
        expect(Number(refreshedA.qty)).toBe(6);
        expect(Number(refreshedA.subtotal)).toBe(60);
      });
    });

    // SA-113b (round 7, #1185, HIGH/money): ADD_ON rows (and any row with a null
    // quantityDelivered, even a REFUSED-typed one) are order-change provenance, never delivery
    // evidence -- an independent Opus 5.5 full re-read of round 6 found deliveredBasisByLine
    // summing a change-request row's SIGNED delta qty as if it were an absolute delivered
    // amount, which could either cancel a never-billed line or drop billable units.
    describe("SA-113b (round 7): ADD_ON / change-request rows are never delivery evidence, real Postgres", () => {
      it("(a) a lone CHANGE_QTY row (ADD_ON, qty -3, no quantityDelivered) on an undelivered order changes nothing", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("p1");
        const product = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        // Mirrors orders.service.ts's at-door change-request approval site: ADD_ON, `qty` is a
        // SIGNED DELTA (a cut here), `quantityDelivered` is never set.
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: product.id,
            type: "ADD_ON",
            qty: -3,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 4 }],
          }),
        );
        await tenantCtx.run(tenant.id, () =>
          invoicesService.update((invoice as any).id, { discount: 0 } as any),
        );

        // The ADD_ON row is ignored entirely -- no evidence at all, so the line's remaining
        // ordered qty (10) stays unconstrained (round 4's rule): still under-billed, order
        // stays gated, nothing shrinks or cancels.
        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(refreshedA.status).toBe("PENDING");
        expect(Number(refreshedA.qty)).toBe(10);
        expect(Number(refreshedA.subtotal)).toBe(100);
      });

      it("(b) the SAME ADD_ON row next to a real DELIVERED row of 7 gives a basis of 7, the ADD_ON's -3 contributes nothing", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("p2");
        const product = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: product.id,
            type: "ADD_ON",
            qty: -3,
            tenantId: tenant.id,
          },
        });
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: product.id,
            type: "DELIVERED",
            quantityDelivered: 7,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 7 }],
          }),
        );
        await tenantCtx.run(tenant.id, () =>
          invoicesService.update((invoice as any).id, { discount: 0 } as any),
        );

        // Basis is 7 (the DELIVERED row alone) -- billed exactly 7, fully covered, shrunk to 7.
        // If the ADD_ON's -3 had been summed in, the basis would be 4 and this would either
        // refuse the qty-7 bill outright or mis-shrink the line.
        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(refreshedA.status).toBe("PENDING");
        expect(Number(refreshedA.qty)).toBe(7);
        expect(Number(refreshedA.subtotal)).toBe(70);
      });

      it("(c) a REMOVE_ITEM-shaped row (REFUSED, qty -10, no quantityDelivered) is NOT evidence and doesn't flip hasMutations", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("p3");
        const product = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        // orders.service.ts writes REFUSED (not ADD_ON) for a REMOVE_ITEM change request, but
        // -- like every at-door change-request row -- never sets quantityDelivered. type alone
        // is not enough to qualify as evidence; SA-113b requires quantityDelivered != null too.
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: product.id,
            type: "REFUSED",
            qty: -10,
            tenantId: tenant.id,
          },
        });

        const invoice = await tenantCtx.run(tenant.id, () =>
          invoicesService.createPartialFromOrder(order.id, {
            items: [{ orderItemId: lineA.id, qty: 4 }],
          }),
        );
        await tenantCtx.run(tenant.id, () =>
          invoicesService.update((invoice as any).id, { discount: 0 } as any),
        );

        // hasMutations stays false (no QUALIFYING row) -- the line's ordered qty (10) stays
        // unconstrained, exactly as if the REFUSED row didn't exist. If the row had wrongly
        // counted, the line would read as billable 0 and finalizeOrderRecompute would cancel it.
        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(refreshedA.status).toBe("PENDING");
        expect(Number(refreshedA.qty)).toBe(10);
        expect(Number(refreshedA.subtotal)).toBe(100);
      });
    });

    describe("B785/SA-113a: the at-door reconcile (basis:delivered) reads the evidence basis, real Postgres", () => {
      // SA-345a: a line with NO qualifying row of its own bills its LEGACY COLUMN (`deliveredQty ?? 0`),
      // capped at qty — never the full qty (the column IS the evidence for an order delivered before
      // DeliveryMutation rows existed). Coverage (billableQtyFromBasis) keeps "no rows => full qty";
      // this is the delivered READER, a different question.
      const seedNoEvidenceLine = async (label: string, column: number | null) => {
        const { tenant, customer } = await seedTenantAndCustomer(label);
        const productA = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productA.id,
            status: "PENDING",
            qty: 10,
            ...(column === null ? {} : { deliveredQty: column }),
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        await tenantCtx.run(tenant.id, () => invoicesService.createInvoiceFromOrder(order.id));
        return { tenant, order, lineA, productA };
      };
      const reconcileDelivered = async (tenantId: string, orderId: string) => {
        await tenantCtx.run(tenantId, () =>
          invoicesService.reconcileOrderDraftInvoice(orderId, { basis: "delivered" }),
        );
        return prisma.invoice.findFirstOrThrow({
          where: { orderId },
          include: { items: true },
        });
      };

      it("(1a) SA-345a: no evidence row + column 0 bills 0 — the line is dropped from the draft, never billed at the full qty", async () => {
        const { tenant, order, lineA } = await seedNoEvidenceLine("b785-1a", 0);

        const draft = await reconcileDelivered(tenant.id, order.id);

        expect(draft.items).toHaveLength(0);
        expect(Number(draft.subtotal)).toBe(0);
        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(Number(refreshedA.invoicedQty)).toBe(0);
      });

      it("(1b) SA-345a: no evidence row + a legacy column of 7 (qty 10) bills 7 (reconcileOrderDraftInvoice)", async () => {
        const { tenant, order, lineA } = await seedNoEvidenceLine("b785-1b", 7);

        const draft = await reconcileDelivered(tenant.id, order.id);

        expect(draft.items).toHaveLength(1);
        expect(Number(draft.items[0]!.qty)).toBe(7);
        expect(Number(draft.subtotal)).toBe(70);
        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(Number(refreshedA.invoicedQty)).toBe(7);
      });

      it("(1c) SA-345a: no evidence row + a stale column of 15 against qty 10 is capped at qty — bills 10, never units nobody ordered", async () => {
        const { tenant, order } = await seedNoEvidenceLine("b785-1c", 15);

        const draft = await reconcileDelivered(tenant.id, order.id);

        expect(draft.items).toHaveLength(1);
        expect(Number(draft.items[0]!.qty)).toBe(10);
        expect(Number(draft.subtotal)).toBe(100);
      });

      it("(2) a REFUSED evidence row bills 0 (reconcileOrderDraftInvoice)", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("b785-2");
        const productA = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productA.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        // SA-539d: the office bills FIRST (no evidence yet ⇒ the draft bills the full line), then the
        // door refuses, then the at-door reconcile. Seeding the REFUSED row before the create made
        // B760 bill min(10, 0) = 0 ⇒ no draft at all (the owner-closed "no fee on a fully refused
        // delivery"), which is not the path this case pins.
        await tenantCtx.run(tenant.id, () => invoicesService.createInvoiceFromOrder(order.id));
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: productA.id,
            type: "REFUSED",
            quantityDelivered: 0,
            tenantId: tenant.id,
          },
        });

        await tenantCtx.run(tenant.id, () =>
          invoicesService.reconcileOrderDraftInvoice(order.id, { basis: "delivered" }),
        );

        const draft = await prisma.invoice.findFirstOrThrow({
          where: { orderId: order.id },
          include: { items: true },
        });
        expect(draft.items).toHaveLength(0); // billQty 0 -- filtered out entirely
        expect(Number(draft.subtotal)).toBe(0);
      });

      it("(3) a stale OrderItem.deliveredQty that disagrees with the evidence never wins — the evidence does (reconcileOrderDraftInvoice)", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("b785-3");
        const productA = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productA.id,
            status: "PENDING",
            qty: 10,
            // Deliberately stale/disagreeing column: a stock-settle or a stray earlier
            // write left this at 3, but the real evidence row below says 7.
            deliveredQty: 3,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: productA.id,
            type: "DELIVERED",
            quantityDelivered: 7,
            tenantId: tenant.id,
          },
        });
        await tenantCtx.run(tenant.id, () => invoicesService.createInvoiceFromOrder(order.id));

        await tenantCtx.run(tenant.id, () =>
          invoicesService.reconcileOrderDraftInvoice(order.id, { basis: "delivered" }),
        );

        const draft = await prisma.invoice.findFirstOrThrow({
          where: { orderId: order.id },
          include: { items: true },
        });
        expect(Number(draft.items[0]!.qty)).toBe(7); // the evidence row, never the stale column
        expect(Number(draft.subtotal)).toBe(70);
      });

      it("(4) SA-115a: a CANCELLED line is excluded, even with its own evidence row (reconcileOrderDraftInvoice)", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("b785-4");
        const productA = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const productB = await prisma.product.create({
          data: { name: `B ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 160,
            total: 160,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productA.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        const lineB = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productB.id,
            status: "CANCELLED",
            qty: 6,
            unitPrice: 10,
            subtotal: 60,
            tenantId: tenant.id,
          },
        });
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: productA.id,
            type: "DELIVERED",
            quantityDelivered: 10,
            tenantId: tenant.id,
          },
        });
        // A CANCELLED line with its own real evidence row -- must never bill.
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineB.id,
            productId: productB.id,
            type: "DELIVERED",
            quantityDelivered: 6,
            tenantId: tenant.id,
          },
        });
        await tenantCtx.run(tenant.id, () => invoicesService.createInvoiceFromOrder(order.id));

        await tenantCtx.run(tenant.id, () =>
          invoicesService.reconcileOrderDraftInvoice(order.id, { basis: "delivered" }),
        );

        const draft = await prisma.invoice.findFirstOrThrow({
          where: { orderId: order.id },
          include: { items: true },
        });
        expect(draft.items).toHaveLength(1);
        expect(draft.items[0]!.orderItemId).toBe(lineA.id);
        expect(Number(draft.subtotal)).toBe(100);
      });

      it("(5) reconcileOrderDeliveredInvoices (the sibling-aware path) is byte-identical to reconcileOrderDraftInvoice for a single-group order", async () => {
        const { tenant, customer } = await seedTenantAndCustomer("b785-5");
        const productA = await prisma.product.create({
          data: { name: `A ${tenant.slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id },
        });
        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            status: "PARTIALLY_DELIVERED",
            subtotal: 100,
            total: 100,
            tenantId: tenant.id,
          },
        });
        const lineA = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: productA.id,
            status: "PENDING",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
            tenantId: tenant.id,
          },
        });
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: productA.id,
            type: "DELIVERED",
            quantityDelivered: 7,
            tenantId: tenant.id,
          },
        });
        await tenantCtx.run(tenant.id, () => invoicesService.createInvoiceFromOrder(order.id));

        // The clean-provenance sibling path (called via reconcileDeliveredOrdersInTx in
        // production) must land on the SAME numbers as the plain draft path above.
        await tenantCtx.run(tenant.id, () =>
          invoicesService.reconcileOrderDeliveredInvoices(order.id),
        );

        const draft = await prisma.invoice.findFirstOrThrow({
          where: { orderId: order.id },
          include: { items: true },
        });
        expect(Number(draft.items[0]!.qty)).toBe(7);
        expect(Number(draft.subtotal)).toBe(70);
        const refreshedA = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineA.id } });
        expect(Number(refreshedA.invoicedQty)).toBe(7);
      });

      it("(6) SA-133/SA-345a: a line whose ONLY rows are ADD_ON/null-quantity change-request rows has no evidence of its own — it bills its legacy column (7 of 10), and the ADD_ON's signed qty never shrinks or replaces it", async () => {
        const { tenant, order, productA, lineA } = await seedNoEvidenceLine("b785-6", 7);
        // A door-cut change request: ADD_ON-shaped, signed delta qty, NO quantityDelivered.
        // Never evidence — if it wrongly counted, the line would read as delivered -3 (billable
        // 0), not its column of 7.
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: productA.id,
            type: "ADD_ON",
            qty: -3,
            quantityDelivered: null,
            tenantId: tenant.id,
          },
        });

        const draft = await reconcileDelivered(tenant.id, order.id);

        expect(draft.items).toHaveLength(1);
        expect(Number(draft.items[0]!.qty)).toBe(7); // the column decides — no real evidence exists
        expect(Number(draft.subtotal)).toBe(70);
      });

      it("(6b) SA-345a: the same ADD_ON-only line with a column of 0 bills 0 (nothing delivered), not the full qty", async () => {
        const { tenant, order, productA, lineA } = await seedNoEvidenceLine("b785-6b", 0);
        await prisma.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: lineA.id,
            productId: productA.id,
            type: "ADD_ON",
            qty: -3,
            quantityDelivered: null,
            tenantId: tenant.id,
          },
        });

        const draft = await reconcileDelivered(tenant.id, order.id);

        expect(draft.items).toHaveLength(0);
        expect(Number(draft.subtotal)).toBe(0);
      });
    });

    describe("SA-093 (B): concurrency, real Postgres", () => {
      // Round 6: the ORIGINAL version of this test fired two concurrent update() calls and
      // asserted only the final state -- it could never actually fail, because Postgres's own
      // row lock on Order.update() already serializes two writers to the SAME row regardless of
      // whether the order-keyed advisory lock exists at all; both writes "land cleanly" either
      // way. This version proves the ADVISORY LOCK ITSELF blocks a concurrent recompute: the
      // test takes the lock first and holds it, fires a real update() that must wait on it,
      // confirms the order is genuinely UNCHANGED while the lock is held (not just eventually
      // consistent), then releases and confirms the blocked call completes.
      it("a concurrent recompute genuinely BLOCKS on the order-keyed advisory lock (not just Postgres row-lock serialization)", async () => {
        const { order, lineB, invoice } = await seedPartiallyInvoicedOrder("o1");

        let releaseTestLock: () => void = () => {};
        const testLockHeld = new Promise<void>((resolve) => {
          releaseTestLock = resolve;
        });
        const lockAcquired = new Promise<void>((resolve) => {
          void withAdvisoryLock(
            { family: "order-merge", key: order.id, mode: "wait" },
            async () => {
              resolve();
              await testLockHeld;
            },
          );
        });
        await lockAcquired;

        const updatePromise = tenantCtx.run(order.tenantId!, () =>
          invoicesService.update((invoice as any).id, { shippingFee: 5 } as any),
        );

        // finally, not a plain follow-on statement: a failed mid-check must still release the
        // test's own lock-holding connection, or a genuine (probe) failure here hangs the whole
        // suite on a dangling advisory-lock session instead of reporting a clean red.
        try {
          await new Promise((r) => setTimeout(r, 300));
          // Still blocked on the lock this test holds -- the write must not have landed yet.
          const midOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
          expect(Number(midOrder.shippingFee)).toBe(0);
        } finally {
          releaseTestLock();
        }
        await updatePromise;

        const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(Number(refreshedOrder.shippingFee)).toBe(5);
        expect(Number(refreshedOrder.subtotal)).toBe(70); // still gated — unbilled line B stands
        expect(Number(refreshedOrder.total)).toBe(75); // 70 + the 5 fee, never a torn partial sum
        const refreshedB = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineB.id } });
        expect(refreshedB.status).toBe("PENDING");
        expect(Number(refreshedB.qty)).toBe(6); // untouched
      });
    });
  },
);
