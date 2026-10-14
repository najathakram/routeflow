/**
 * Row 510 (brief 3) - real-Postgres proof of a RECURRING INVOICE and its restricted lines, through the real
 * RecurringInvoicesService, InvoicesService and SellingRestrictionsService (rules, labels, addresses from the database):
 *
 *   Run now (manual)   a template holding a restricted line answers 409 RESTRICTION_WARNING to the clicker, the template
 *                      untouched (not claimed, no invoice, no error recorded); the resubmit with the ack issues the invoice
 *                      with the restricted line STAMPED by the clicker (reason, by, at, rule ids) and ONE audit row; a
 *                      SUPER_ADMIN gets the hard 409 SELLING_RESTRICTED; a clean template runs untouched with no stamp.
 *   scheduled run     SA-205: a template with a restricted line issues NO invoice (never the clean lines alone), is
 *                      suspended with its cycle moved forward, notifies the operator and the admin once, and writes no
 *                      stamp anywhere; reactivated and cleaned, the next scheduled run issues a plain invoice, so an
 *                      override is never carried forward.
 *
 * No `selling_restrictions.enabled` row exists. Collected only by jest.db.config.js. One throwaway `qa-r510-<run>` tenant
 * (assertTestTenant), purged in afterAll.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { EstimatesService } from "../estimates/estimates.service";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NumberingService } from "../import/numbering.service";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  setStoreState,
  staffPayload,
  type OverrideWorld,
} from "../../test/restriction-override-fixture";

const RUN = randomUUID().slice(0, 8);
const REASON = "Licensed buyer, paperwork on file";
const notifications = { sendToUser: jest.fn().mockResolvedValue(1) };

describeDb(
  "row 510 (brief 3): recurring invoices warn on Run now and skip the cycle when scheduled — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    let recurring: RecurringInvoicesService;
    let w: OverrideWorld;

    const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
    const staff = (role: "OPERATOR" | "TENANT_ADMIN" | "SUPER_ADMIN" = "OPERATOR") =>
      staffPayload(w, role);
    const errOf = async (p: Promise<unknown>): Promise<any> => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      throw new Error("expected a rejection");
    };
    const bodyOf = (e: any) => e.getResponse() as any;
    const ackFrom = (e: any) => ({
      warningHash: bodyOf(e).warningHash as string,
      restrictionOverrides: (bodyOf(e).lines as Array<{ lineKey: string }>).map((l) => ({
        lineKey: l.lineKey,
        reason: REASON,
      })),
    });
    const DUE = () => new Date(Date.now() - 24 * 3600 * 1000);

    async function template(productIds: string[], over: { customerId?: string } = {}) {
      return raw.recurringInvoice.create({
        data: {
          tenantId: w.tenantId,
          customerId: over.customerId ?? w.caCustomerId,
          frequency: "MONTHLY",
          dayOfMonth: 1,
          nextRunAt: DUE(),
          items: {
            create: [
              ...productIds.map((productId, i) => ({
                tenantId: w.tenantId,
                productId,
                description: `line ${i}`,
                qty: "2",
                unitPrice: "10.00",
              })),
              {
                tenantId: w.tenantId,
                productId: null,
                description: "Custom fee (exempt)",
                qty: "1",
                unitPrice: "5.00",
              },
            ],
          },
        },
        include: { items: true },
      });
    }
    const invoicesOf = (templateId: string) =>
      raw.invoice.findMany({
        where: { tenantId: w.tenantId, recurringInvoiceId: templateId },
        include: { items: { orderBy: { createdAt: "asc" } } },
      });
    const audits = (invoiceId: string) =>
      raw.auditLog.findMany({
        where: {
          tenantId: w.tenantId,
          action: "selling_restriction.overridden",
          meta: { path: ["documentId"], equals: invoiceId },
        },
      });

    beforeAll(async () => {
      const url = requireLocalDatabaseUrl();
      pool = new Pool({ connectionString: url });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      dbPrisma = new PrismaService(tenantCtx);
      await dbPrisma.$connect();
      const mod = await Test.createTestingModule({
        providers: [
          InvoicesService,
          EstimatesService,
          RecurringInvoicesService,
          { provide: NotificationsService, useValue: notifications },
          NumberingService,
          SellingRestrictionsService,
          ProductLabelsService,
          { provide: PrismaService, useValue: dbPrisma },
          { provide: TenantContextService, useValue: tenantCtx },
          {
            provide: RouteFlowGateway,
            useValue: {
              emitInvoiceUpdated: jest.fn(),
              emitOrderCreated: jest.fn(),
              emitOrderStatusChanged: jest.fn(),
              emitLowStock: jest.fn(),
              emitStopCompleted: jest.fn(),
              emitUrgentOrder: jest.fn(),
            },
          },
          {
            provide: EmailService,
            useValue: {
              sendInvoice: jest.fn(),
              isEmailConfigured: jest.fn().mockResolvedValue(true),
            },
          },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          {
            provide: SystemConfigService,
            useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
          },
          RegulatedLedgerService,
          {
            provide: AuthorizationGuardService,
            useValue: {
              assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
              checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
            },
          },
          {
            provide: CreditNotesService,
            useValue: {
              autoApplyOldestCreditsInTx: jest
                .fn()
                .mockResolvedValue({ applied: 0, invoiceStatus: null }),
              settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
              releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: MessagingService,
            useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
          },
          {
            provide: StorageService,
            useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
          },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          entitlementAuthorityFromEntitlements,
          {
            provide: CommissionEngineService,
            useValue: {
              syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
              syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
              removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();
      recurring = mod.get(RecurringInvoicesService);
      w = await seedOverrideWorld(raw, RUN, "restriction-override.recurring.db.spec.ts");
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
      await dbPrisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    beforeEach(() => notifications.sendToUser.mockClear());

    describe("Run now (manual)", () => {
      it("warns the clicker and leaves the template UNTOUCHED: not claimed, no invoice, no error recorded", async () => {
        const t = await template([w.banned, w.clean]);
        const e = await errOf(as(() => recurring.runNow(t.id, staff())));
        expect(e.getStatus()).toBe(409);
        expect(bodyOf(e)).toMatchObject({
          code: "RESTRICTION_WARNING",
          warningHash: expect.stringMatching(/^rw1:/),
          lines: [{ lineKey: "n:0", productId: w.banned }],
        });
        const after = await raw.recurringInvoice.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.nextRunAt.getTime()).toBe(t.nextRunAt.getTime());
        expect(after.lastRunAt).toBeNull();
        expect(after.lastError).toBeNull();
        expect(after.isActive).toBe(true);
        expect(await invoicesOf(t.id)).toHaveLength(0);
        expect(notifications.sendToUser).not.toHaveBeenCalled();
      });

      it("the resubmit with the ack issues the invoice with the restricted line stamped BY THE CLICKER, plus ONE audit row", async () => {
        const t = await template([w.banned, w.clean]);
        const e = await errOf(as(() => recurring.runNow(t.id, staff("TENANT_ADMIN"))));
        const invoice: any = await as(() =>
          recurring.runNow(t.id, staff("TENANT_ADMIN"), ackFrom(e) as never),
        );
        expect(invoice?.id).toBeDefined();
        const [inv] = await invoicesOf(t.id);
        expect(inv.items).toHaveLength(3); // nothing dropped: banned, clean and the custom line
        const bannedLine = inv.items.find((i) => i.productId === w.banned)!;
        expect(bannedLine).toMatchObject({
          restrictionOverrideReason: REASON,
          restrictionOverrideBy: w.adminId, // the user who clicked, not the template's creator
          restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
        });
        expect(bannedLine.restrictionOverrideAt).toBeInstanceOf(Date);
        expect(inv.items.filter((i) => i.restrictionOverrideAt !== null)).toHaveLength(1);
        expect(await audits(inv.id)).toHaveLength(1);
        // the cycle was claimed and the template records a success
        const after = await raw.recurringInvoice.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
        expect(after.lastRunStatus).toBe("SUCCESS");
      });

      it("a stale ack (the template changed since the warning) warns again with a fresh hash, writing nothing", async () => {
        const t = await template([w.banned]);
        const e = await errOf(as(() => recurring.runNow(t.id, staff())));
        const ack = ackFrom(e);
        await raw.recurringInvoiceItem.create({
          data: {
            tenantId: w.tenantId,
            recurringInvoiceId: t.id,
            productId: w.banned2,
            description: "added after the warning",
            qty: "1",
            unitPrice: "10.00",
          },
        });
        const again = await errOf(as(() => recurring.runNow(t.id, staff(), ack as never)));
        expect(bodyOf(again).code).toBe("RESTRICTION_WARNING");
        expect(bodyOf(again).warningHash).not.toBe(ack.warningHash);
        expect(await invoicesOf(t.id)).toHaveLength(0);
      });

      it("SUPER_ADMIN may not override: the hard 409 SELLING_RESTRICTED, nothing claimed", async () => {
        const t = await template([w.banned]);
        const e = await errOf(as(() => recurring.runNow(t.id, staff("SUPER_ADMIN"))));
        expect(bodyOf(e).code).toBe("SELLING_RESTRICTED");
        expect(await invoicesOf(t.id)).toHaveLength(0);
        const after = await raw.recurringInvoice.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.nextRunAt.getTime()).toBe(t.nextRunAt.getTime());
      });

      it("a clean template (same customer) runs untouched: no warning, no stamp, no audit row", async () => {
        const t = await template([w.clean]);
        const invoice: any = await as(() => recurring.runNow(t.id, staff()));
        const [inv] = await invoicesOf(t.id);
        expect(invoice.id).toBe(inv.id);
        expect(inv.items.every((i) => i.restrictionOverrideAt === null)).toBe(true);
        expect(await audits(inv.id)).toHaveLength(0);
      });
    });

    describe("scheduled run (SA-205)", () => {
      it("issues NO invoice for a template with a restricted line (never the clean lines alone), suspends it and notifies once each; no stamp anywhere", async () => {
        const t = await template([w.banned, w.clean]);
        const before = await raw.invoiceItem.count({
          where: { tenantId: w.tenantId, restrictionOverrideAt: { not: null } },
        });
        const out = await as(() => (recurring as any).generateInvoiceFromTemplate(t));
        expect(out).toBeNull();
        expect(await invoicesOf(t.id)).toHaveLength(0);
        const after = await raw.recurringInvoice.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.isActive).toBe(false);
        expect(after.lastRunStatus).toBe("FAILED");
        expect(after.lastError).toContain("Suspended:");
        expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now()); // the skipped cycle is never a make-up
        expect(notifications.sendToUser).toHaveBeenCalledTimes(2); // the operator and the admin of the world
        expect(
          await raw.invoiceItem.count({
            where: { tenantId: w.tenantId, restrictionOverrideAt: { not: null } },
          }),
        ).toBe(before);
      });

      it("after the line is fixed and the template reactivated, the next scheduled run issues a PLAIN invoice (no override carried forward)", async () => {
        const t = await template([w.clean]);
        const out: any = await as(() => (recurring as any).generateInvoiceFromTemplate(t));
        expect(out?.id).toBeDefined();
        const [inv] = await invoicesOf(t.id);
        expect(inv.items.every((i) => i.restrictionOverrideAt === null)).toBe(true);
        expect(await audits(inv.id)).toHaveLength(0);
      });
    });
  },
);
