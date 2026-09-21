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
 * WHY THE DB LANE: a mocked Prisma can't prove the read-then-write sequence across TWO tables
 * (OrderItem + Order) inside `recomputeOrderFromInvoices`'s own transaction, nor that the
 * un-invoiced line's row is genuinely untouched (not just returned as if untouched by a mock).
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

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
  },
);
