/**
 * I-101 item 6 (units ladder matrix 2026-10-28, A6): the three-level ladder, proved end to end on REAL Postgres.
 *
 * Fixture: ONE family with TWO variants. On each variant the pack is 10 pieces (`Product.unitsPerBox`, no row), a Case is
 * 200 pieces (perParent 20) and a Pallet is 4,800 pieces (parent = the Case, perParent 24). The levels are written by the
 * REAL units writer (`ProductUnitsService.create`), never inserted raw, so the chain checks run.
 *
 * Chain per variant and level (Case, Pallet): order (`OrdersService.create`) -> invoice (`createInvoiceFromOrder`) ->
 * standard return (`ReturnsService.create/approve/receive`) -> credit note (`processRefund`) -> stock. Every stage is read
 * back from the stored columns. The return is sent two ways: as a PIECE count equal to one whole level (200 / 4,800) and as a
 * LEVEL count (1). Observed on 2026-10-28: a return item's qty is the order line's stored unit, pieces, so a count of 1 puts
 * back 1 piece and credits the pro-rated piece price (box / 10), not the Case or Pallet price. The "units" cases pin that
 * observed behaviour so the day a return learns a unit they turn red and are rewritten (matrix item 15, B754). Expected values are the ladder arithmetic written down here, not copied from
 * a run: a variant's Case is priced from its pack (20 x box price), a Pallet from the Case (24 x Case price).
 *
 * `note 4` block: the pack has no row, so a Case cannot name the box as its parent. The block records what the writer does
 * with a Case that carries `perParent` and no parent: it saves it, and it also saves one whose `perParent` disagrees with its
 * factor (nothing ties 300 to 7 without a parent). It does not work around the gap.
 *
 * Run via `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js. SAFETY: one throwaway
 * `qa-i101-<run>` tenant approved by `assertTestTenant`; afterAll deletes exactly its rows.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: class InvoicePdfService {},
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "../returns/returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";
import { ProductUnitsService } from "./product-units.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/** The ladder, as the matrix fixture names it. */
const PACK = 10;
const CASE = { label: "Case", factor: 200, perParent: 20 };
const PALLET = { label: "Pallet", factor: 4800, perParent: 24 };
/** Box price per variant; Case = 20 x box, Pallet = 24 x Case. */
const VARIANTS = [
  { name: "a1", boxPrice: 20, casePrice: 400, palletPrice: 9600 },
  { name: "a2", boxPrice: 30, casePrice: 600, palletPrice: 14400 },
] as const;
const START_STOCK = 100_000;
const ORDER_QTY = 2; // units of the level on the order
const RETURN_QTY = 1; // levels handed back

describeDb(
  "I-101 units ladder: pack 10 / Case 200 / Pallet 4800 on two variants, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let invoices: any;
    let returns: ReturnsService;
    let units: ProductUnitsService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-i101-${run}`, "units-ladder-proof.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let customerId = "";
    let familyId = "";
    const variantIds: Record<string, string> = {};
    const levelIds: Record<string, string> = {};
    let invoiceSeq = 0;
    let cnSeq = 0;
    let returnSeq = 0;
    /** What the writer answered for each level, recorded for the report. */
    const writerAnswers: Record<string, unknown> = {};

    const operator = (): JwtPayload =>
      ({
        sub: operatorUserId,
        username: `op-${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    const inTenant = <T>(fn: () => Promise<T>): Promise<T> => tenantCtx.run(tenantId, fn);
    const num = (v: unknown) => (v == null ? null : Number(v));
    const stockOf = async (productId: string) =>
      Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      invoices = Object.assign(Object.create(InvoicesService.prototype), {
        prisma,
        systemConfig,
        entitlements: { hasFlag: async () => true },
        authority: { can: async () => false },
        sellingRestrictions: { assertLinesSellable: async () => undefined },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        ledger: anyMethod,
        gateway: anyMethod,
        generateInvoiceNumber: async () => `INV-I101-${run}-${++invoiceSeq}`,
        logger: new Logger("i101-invoices"),
      });
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: {
          emitOrderCreated: jest.fn(),
          emitUrgentOrder: jest.fn(),
          emitOrderStatusChanged: jest.fn(),
          emitLowStock: jest.fn(),
        },
        notifications: {
          sendToCustomer: jest.fn().mockResolvedValue(undefined),
          sendToUser: jest.fn().mockResolvedValue(1),
        },
        messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
          assertLinesSellable: async () => undefined,
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        invoicesService: {
          findOpenOrderDraft: async () => null,
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        creditNotes: {
          settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
          previewOrderCreditRelease: async () => [],
          releaseOrderCreditsInTx: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        oversellReader: { read: async () => "off" },
      });
      const mod = await Test.createTestingModule({
        providers: [
          CreditNotesService,
          ReturnsService,
          RegulatedLedgerService,
          CommissionEngineService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
          },
          { provide: RouteFlowGateway, useValue: anyMethod },
          {
            provide: NumberingService,
            useValue: {
              reserveNext: jest
                .fn()
                .mockImplementation(async (type: string) =>
                  type === "RETURN"
                    ? `RTN-I101-${run}-${++returnSeq}`
                    : `CN-I101-${run}-${++cnSeq}`,
                ),
            },
          },
        ],
      }).compile();
      returns = mod.get(ReturnsService);
      // the invoice writer settles credits through the REAL credit-notes service
      Object.assign(invoices, {
        creditNotes: mod.get(CreditNotesService),
        commissionEngine: mod.get(CommissionEngineService),
        numbering: mod.get(NumberingService),
        messaging: anyMethod,
        emailService: anyMethod,
        storage: anyMethod,
      });
      units = new ProductUnitsService(prisma);

      tenantId = (await raw.tenant.create({ data: { slug, name: `I101 ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `op-${run}@example.test`,
            username: `op-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      const buyer = await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      });
      customerId = (
        await raw.customer.create({
          data: {
            userId: buyer.id,
            businessName: "Acme",
            contactName: "Tester",
            isTaxExempt: true, // the document total is the line total
            tenantId,
          },
        })
      ).id;
      // The family container (what createFamilyContainer writes) and two variants (what variantData writes).
      familyId = (
        await raw.product.create({
          data: {
            tenantId,
            name: `Family ${run}`,
            unit: "each",
            pricePerUnit: "0.00",
            kind: "FAMILY",
            parentProductId: null,
            isActive: true,
          },
        })
      ).id;
      for (const v of VARIANTS) {
        variantIds[v.name] = (
          await raw.product.create({
            data: {
              tenantId,
              name: `Family ${run} ${v.name}`,
              variantName: v.name,
              parentProductId: familyId,
              kind: "VARIANT",
              unit: "each",
              unitsPerBox: PACK,
              pricePerUnit: v.boxPrice.toFixed(2),
              currentStock: START_STOCK,
              isActive: true,
            },
          })
        ).id;
        // The levels go through the real writer, Case first so the Pallet can name it as parent.
        const caseRow: any = await inTenant(() =>
          units.create(
            variantIds[v.name],
            { label: CASE.label, factorToBase: CASE.factor, perParent: CASE.perParent } as any,
            operatorUserId,
          ),
        );
        levelIds[`${v.name}:Case`] = caseRow.id;
        const palletRow: any = await inTenant(() =>
          units.create(
            variantIds[v.name],
            {
              label: PALLET.label,
              factorToBase: PALLET.factor,
              parentUnitId: caseRow.id,
              perParent: PALLET.perParent,
            } as any,
            operatorUserId,
          ),
        );
        levelIds[`${v.name}:Pallet`] = palletRow.id;
        writerAnswers[v.name] = { case: caseRow, pallet: palletRow };
      }
    }, 120_000);

    afterAll(async () => {
      try {
        const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
          (o) => o.id,
        );
        await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
        await raw.returnItem.deleteMany({ where: { tenantId } });
        await raw.return.deleteMany({ where: { tenantId } });
        await raw.creditNoteItem.deleteMany({ where: { tenantId } });
        await raw.creditNote.deleteMany({ where: { tenantId } });
        await raw.stockMovement.deleteMany({ where: { tenantId } });
        await raw.invoiceItem.deleteMany({ where: { tenantId } });
        await raw.invoice.deleteMany({ where: { tenantId } });
        await raw.orderItem.deleteMany({ where: { tenantId } });
        await raw.order.deleteMany({ where: { tenantId } });
        await raw.auditLog.deleteMany({ where: { tenantId } });
        await raw.productUnit.deleteMany({ where: { tenantId } });
        await raw.tenantUnit.deleteMany({ where: { tenantId } });
        await raw.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
        await raw.product.deleteMany({ where: { tenantId } });
        await raw.customer.deleteMany({ where: { tenantId } });
        await raw.user.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      } finally {
        await _resetLockPoolForTests();
        await prisma?.$disconnect();
        await raw?.$disconnect();
        await pool?.end();
      }
    }, 120_000);

    it("the writer stores the chain: Case 200 (perParent 20), Pallet 4800 (parent = Case, perParent 24), on both variants", async () => {
      for (const v of VARIANTS) {
        const rows = await raw.productUnit.findMany({
          where: { productId: variantIds[v.name] },
          orderBy: { factorToBase: "asc" },
        });
        expect(
          rows.map((r) => [
            r.label,
            r.factorToBase,
            r.parentUnitId,
            num(r.perParent),
            num(r.price),
          ]),
        ).toEqual([
          ["Case", 200, null, 20, null],
          ["Pallet", 4800, levelIds[`${v.name}:Case`], 24, null],
        ]);
      }
    });

    const levels = [
      { level: "Case", factor: CASE.factor, price: (v: (typeof VARIANTS)[number]) => v.casePrice },
      {
        level: "Pallet",
        factor: PALLET.factor,
        price: (v: (typeof VARIANTS)[number]) => v.palletPrice,
      },
    ] as const;

    for (const v of VARIANTS) {
      for (const l of levels) {
        for (const mode of ["pieces", "units"] as const) {
          it(`${v.name} at ${l.level}, return sent as ${mode}: order -> invoice -> return -> credit note -> stock`, async () => {
            const productId = variantIds[v.name];
            const unitPrice = l.price(v);
            const lineTotal = unitPrice * ORDER_QTY;
            const stock0 = await stockOf(productId);

            // 1. ORDER at the level
            const order = await inTenant(() =>
              orders.create(
                { customerId, items: [{ productId, qty: ORDER_QTY, unitLabel: l.level }] },
                operator(),
                { skipAutoMerge: true },
              ),
            );
            const oLine = await raw.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
            expect({
              unitLabel: oLine.unitLabel,
              boxes: num(oLine.boxes),
              qty: num(oLine.qty),
              unitsPerBox: num(oLine.unitsPerBox),
              unitPrice: num(oLine.unitPrice),
              subtotal: num(oLine.subtotal),
            }).toEqual({
              unitLabel: l.level,
              boxes: ORDER_QTY,
              qty: ORDER_QTY * l.factor,
              unitsPerBox: l.factor,
              unitPrice,
              subtotal: lineTotal,
            });
            expect(
              num((await raw.order.findUniqueOrThrow({ where: { id: order.id } })).total),
            ).toBe(lineTotal);
            expect(await stockOf(productId)).toBe(stock0 - ORDER_QTY * l.factor);

            // 2. INVOICE from the order
            await raw.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
            const made: any = await inTenant(() => invoices.createInvoiceFromOrder(order.id));
            // createInvoiceFromOrder answers an array (the regulated-category split); a plain catalog line never splits
            expect(Array.isArray(made) ? made.length : 1).toBe(1);
            const invoice: any = Array.isArray(made) ? made[0] : made;
            expect(invoice.id).toBeTruthy();
            const iLine = await raw.invoiceItem.findFirstOrThrow({
              where: { invoiceId: invoice.id },
            });
            expect({
              unitLabel: iLine.unitLabel,
              qty: num(iLine.qty),
              unitsPerBox: num(iLine.unitsPerBox),
              unitPrice: num(iLine.unitPrice),
              subtotal: num(iLine.subtotal),
            }).toEqual({
              unitLabel: l.level,
              qty: ORDER_QTY * l.factor,
              unitsPerBox: l.factor,
              unitPrice,
              subtotal: lineTotal,
            });
            expect(
              num((await raw.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).total),
            ).toBe(lineTotal);
            await raw.invoice.update({ where: { id: invoice.id }, data: { status: "SENT" } });

            // 3-5. RETURN of RETURN_QTY units of the level -> received to stock -> credit note. The three stages are read
            // together so one run reports every stored value, not only the first that differs.
            // A return item's qty is the order line's stored unit, which is PIECES for a unit line (qty 400 for 2 Cases).
            // "pieces": hand back RETURN_QTY whole levels = RETURN_QTY x factor pieces. "units": send the level COUNT (1),
            // which is what a person means by "one Case"; the writer reads it as 1 piece (observed, pinned below).
            const returnQty = mode === "pieces" ? RETURN_QTY * l.factor : RETURN_QTY;
            const piecePrice = v.boxPrice / PACK;
            const stockBeforeReturn = await stockOf(productId);
            const ret: any = await inTenant(() =>
              returns.create(
                {
                  orderId: order.id,
                  reason: "WRONG_ITEM",
                  items: [{ productId, qty: returnQty }],
                },
                operatorUserId,
                "OPERATOR",
              ),
            );
            await inTenant(() => returns.approve(ret.id));
            await inTenant(() => returns.receive(ret.id, operatorUserId, { restock: true }));
            const restocked = (await stockOf(productId)) - stockBeforeReturn;
            await inTenant(() => returns.processRefund(ret.id, undefined, operator()));
            const note = await raw.creditNote.findFirstOrThrow({
              where: { tenantId, invoiceId: invoice.id, status: { not: "VOID" } },
            });
            const nLine = await raw.creditNoteItem.findFirst({ where: { creditNoteId: note.id } });
            const retItem = await raw.returnItem.findFirstOrThrow({ where: { returnId: ret.id } });
            const seen = {
              returnItemQty: num(retItem.qty),
              restockedPieces: restocked,
              creditNoteAmount: num(note.amount),
              creditNoteLineAmount: nLine ? num(nLine.amount) : null,
              finalStock: await stockOf(productId),
            };
            const expected =
              mode === "pieces"
                ? {
                    returnItemQty: returnQty,
                    restockedPieces: returnQty,
                    creditNoteAmount: unitPrice * RETURN_QTY,
                    creditNoteLineAmount: unitPrice * RETURN_QTY,
                  }
                : {
                    // the count is read as pieces: 1 piece back, credited at the pro-rated piece price (box / 10)
                    returnItemQty: 1,
                    restockedPieces: 1,
                    creditNoteAmount: piecePrice,
                    creditNoteLineAmount: piecePrice,
                  };
            expect(seen).toEqual({
              ...expected,
              finalStock: stock0 - ORDER_QTY * l.factor + expected.restockedPieces,
            });
          }, 60_000);
        }
      }
    }

    describe("note 4: the pack has no row, so a Case cannot name the box as its parent", () => {
      it("records what the writer does with a Case that carries perParent and no parent (observation, not a workaround)", async () => {
        const probeId = (
          await raw.product.create({
            data: {
              tenantId,
              name: `Probe ${run}`,
              unit: "each",
              unitsPerBox: PACK,
              pricePerUnit: "20.00",
              currentStock: 0,
            },
          })
        ).id;
        // the Case as the fixture builds it: factor 200, perParent 20 (box x 20), parent null
        const asBuilt: any = await inTenant(() =>
          units.create(probeId, { label: "Case", factorToBase: 200, perParent: 20 } as any),
        );
        // a Case whose perParent disagrees with its factor (200 is not 7 x anything in the chain), parent null
        const wrong: any = await inTenant(() =>
          units
            .create(probeId, { label: "Crate", factorToBase: 300, perParent: 7 } as any)
            .catch((e) => ({
              rejected: e?.message ?? String(e),
              status: e?.getStatus?.(),
            })),
        );
        expect(asBuilt).toMatchObject({ label: "Case", parentUnitId: null });
        expect(num(asBuilt.perParent)).toBe(20);
        // observed: saved as given, parent null, perParent 7 beside factor 300 (no rejection)
        expect(wrong).toMatchObject({ label: "Crate", factorToBase: 300, parentUnitId: null });
        expect(num(wrong.perParent)).toBe(7);
      });
    });
  },
);
