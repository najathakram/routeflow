/**
 * SA-311 (#2181) — real-Postgres proof that `CreditNotesService.create` persists a CreditNoteItem
 * for EVERY referenced invoice line (ordinary and regulated), that the per-line cap is therefore
 * cumulative for ordinary lines (amount AND, per SA-401a, qty in base pieces), and that the
 * regulated-ledger reversal is unchanged.
 *
 * Before the fix only regulated items were written, so an ordinary line kept no line link
 * (sales-facts reported it unattributed) and `priorForLine` never saw an earlier credit on it: a
 * second credit could over-refund an ordinary line as long as the invoice-total cap had headroom.
 *
 * Real providers: PrismaService, CreditNotesService, RegulatedLedgerService, CommissionEngineService
 * and AuditService. Stubbed, none under test: the sales-agents entitlement (off, so no commission
 * rows), the socket gateway, and numbering (a unique number per call).
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-2181-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */

import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "./credit-notes.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { periodBucketOf } from "../regulated/period";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "credit notes persist an item for every referenced line — real Postgres (#2181, SA-311)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let creditNotes: CreditNotesService;
    const tenantIds: string[] = [];
    let seq = 0;
    let cnSeq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const mod = await Test.createTestingModule({
        providers: [
          CreditNotesService,
          RegulatedLedgerService,
          CommissionEngineService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          {
            provide: RouteFlowGateway,
            useValue: { emitCreditNoteCreated: jest.fn(), emitCreditNoteVoided: jest.fn() },
          },
          {
            provide: NumberingService,
            useValue: {
              reserveNext: jest.fn().mockImplementation(async () => `CN-2181-${RUN}-${++cnSeq}`),
            },
          },
        ],
      }).compile();
      creditNotes = mod.get(CreditNotesService);
    });

    afterAll(async () => {
      const swallow = () => undefined; // a failed cleanup must never mask a test's result
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
        await prisma.creditNoteItem.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.trackedCategory.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /** A SENT invoice of 100: a regulated line (50, with its live SALE row) and an ordinary line (50). */
    async function seed(label: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-2181-${RUN}-${seq}-${label}`,
        "credit-note-items-every-line.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `#2181 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const cat = await prisma.trackedCategory.create({
        data: { tenantId, name: `cat ${label}`, taxType: "EXCISE_PER_UNIT", rate: 1 },
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceNumber: `INV-2181-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 100,
          taxAmount: 5,
          total: 105,
        },
      });
      const reg = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          description: "regulated",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
          trackedCategoryId: cat.id,
          categoryTaxAmount: 5,
        },
      });
      const std = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          description: "ordinary",
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
        },
      });
      const soldAt = new Date();
      await prisma.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: cat.id,
          entryType: "SALE",
          invoiceId: invoice.id,
          invoiceItemId: reg.id,
          qty: 5,
          unitBasisQty: 5,
          netSales: 50,
          categoryTax: 5,
          soldAt,
          periodBucket: periodBucketOf(soldAt),
        },
      });
      return { tenantId, customerId: customer.id, invoiceId: invoice.id, reg, std };
    }

    const create = (s: Awaited<ReturnType<typeof seed>>, amount: number, items: any[]) =>
      tenantCtx.run(s.tenantId, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.invoiceId,
          amount,
          items,
        } as any),
      );
    const itemsOf = (tenantId: string) =>
      prisma.creditNoteItem.findMany({ where: { tenantId }, orderBy: { amount: "asc" } });
    const reversals = (tenantId: string) =>
      prisma.regulatedSalesLedger.count({ where: { tenantId, entryType: "REVERSAL" } });

    it("a mixed credit persists an item for EVERY referenced line; the ledger reverses the regulated line once", async () => {
      const s = await seed("mixed");
      await create(s, 30, [
        { invoiceItemId: s.reg.id, amount: 10 },
        { invoiceItemId: s.std.id, amount: 20 },
      ]);
      const items = await itemsOf(s.tenantId);
      expect(
        items.map((i) => [i.invoiceItemId, i.trackedCategoryId != null, Number(i.amount)]),
      ).toEqual([
        [s.reg.id, true, 10],
        [s.std.id, false, 20],
      ]);
      expect(await reversals(s.tenantId)).toBe(1); // unchanged: only the regulated line reverses
    });

    it("an ordinary-only credit persists its item and writes NO ledger reversal", async () => {
      const s = await seed("ordinary");
      await create(s, 20, [{ invoiceItemId: s.std.id, amount: 20 }]);
      const items = await itemsOf(s.tenantId);
      expect(items.map((i) => [i.invoiceItemId, i.trackedCategoryId])).toEqual([[s.std.id, null]]);
      expect(await reversals(s.tenantId)).toBe(0);
    });

    it("a first credit up to the ordinary line's subtotal passes", async () => {
      const s = await seed("fullline");
      await expect(create(s, 50, [{ invoiceItemId: s.std.id, amount: 50 }])).resolves.toBeDefined();
      expect((await itemsOf(s.tenantId)).map((i) => Number(i.amount))).toEqual([50]);
    });

    it("the per-line cap is CUMULATIVE for an ordinary line: a second credit over its subtotal is a 400", async () => {
      const s = await seed("cumulative");
      await create(s, 40, [{ invoiceItemId: s.std.id, amount: 40 }]);
      // The invoice-total cap still has headroom (40 of 105 credited); only the line cap refuses.
      await expect(create(s, 20, [{ invoiceItemId: s.std.id, amount: 20 }])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect((await itemsOf(s.tenantId)).map((i) => Number(i.amount))).toEqual([40]);
      expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(1);
    });

    it("SA-401a: a second credit whose QTY would exceed the line qty is a 400, though its amount alone passes", async () => {
      const s = await seed("qtyover");
      await create(s, 10, [{ invoiceItemId: s.std.id, amount: 10, qty: 4 }]); // 4 of 5 pieces
      // $10 + $10 = $20 <= $50 (amount cap passes); 4 + 2 = 6 > 5 pieces (qty cap refuses).
      await expect(
        create(s, 10, [{ invoiceItemId: s.std.id, amount: 10, qty: 2 }]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await itemsOf(s.tenantId)).map((i) => Number(i.qty))).toEqual([4]);
      expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(1);
    });

    it("#2245 Opus BLOCK: three amount-only partial credits that close a line all pass (rounded default qtys sum to the line qty)", async () => {
      const s = await seed("thirds");
      // An ordinary line of 2 pieces for 3.00 — credited 1.00 three times with no qty, as the web
      // picker sends. Each default qty is round3(2 × 1/3) = 0.667; three of those are 2.001 > 2,
      // so the per-line qty cap refused the THIRD (closing) credit. The closing credit now takes
      // exactly the remaining qty.
      const odd = await prisma.invoiceItem.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.invoiceId,
          description: "thirds",
          qty: 2,
          unitPrice: 1.5,
          subtotal: 3,
        },
      });
      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        await expect(create(s, 1, [{ invoiceItemId: odd.id, amount: 1 }])).resolves.toBeDefined();
      }
      const rows = (await itemsOf(s.tenantId)).filter((i) => i.invoiceItemId === odd.id);
      expect(rows).toHaveLength(3);
      expect(Math.round(rows.reduce((t, i) => t + Number(i.qty), 0) * 1000) / 1000).toBe(2);
      expect(Math.round(rows.reduce((t, i) => t + Number(i.amount), 0) * 100) / 100).toBe(3);
    });

    it("SA-401a: a qty exactly reaching the line qty passes", async () => {
      const s = await seed("qtyexact");
      await create(s, 10, [{ invoiceItemId: s.std.id, amount: 10, qty: 4 }]);
      await expect(
        create(s, 10, [{ invoiceItemId: s.std.id, amount: 10, qty: 1 }]), // 4 + 1 = 5
      ).resolves.toBeDefined();
      expect((await itemsOf(s.tenantId)).map((i) => Number(i.qty)).sort((a, b) => a - b)).toEqual([
        1, 4,
      ]);
    });
  },
);
