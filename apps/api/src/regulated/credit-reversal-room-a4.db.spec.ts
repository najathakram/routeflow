/**
 * SA-1042 A-4 (I-180) on REAL Postgres: a typed (itemised) credit note on a REGULATED line must fit what the regulated ledger can
 * still reverse on that order line (`credit-reversal-room.ts`, the one remaining `reverseCreditNoteEntries` clamps to). Run with
 * `npm run local:test:db` (fresh `rf_dbspec_*` database).
 *
 * Fixture (win-heavy's S1 shape): product P on ONE order with two invoices. Lines A and B are each 200 pcs, 50.00 net, 5.00 levy,
 * both sales booked in the ledger; A's invoice is the LATER one (total 190.00, so a refund lump has room), B's the earlier.
 *
 *   R-L1  a pooled 200-pc return is received (REVERSAL on A: -200 / -50 / -5) and refunded (one 50.00 lump, on B's invoice, SA-1051),
 *         then a typed credit of 50.00 / 200 pcs on A: before the fix ACCEPTED with the item's categoryTax 5.00 while the ledger
 *         booked nothing (the clamp: A is closed); after: 409 CREDIT_NOTE_OVER_HEADROOM from the A-4 bind, no note, no item, ledger unchanged.
 *   G-L2  the same return, the typed credit on B (the line with room, B's invoice given room): accepted, the category nets 0 / 0.
 *   G-L11 G-L2's original totals (B 50.00): observed, no value ruled (SA-1054): which door refuses a typed credit on B and on A.
 *   G-L3  a pooled 100-pc return, then a typed 100-pc credit on A: accepted and books A's remainder; a 150-pc one: refused.
 *   G-L4  a rotated invoice item (the credited id differs from the SALE row's): the refusal comes through the order line.
 *   G-L5  boxed line (5 boxes of 12, B661 pieces): the bind compares in the unit the clamp uses.
 *   G-L6  filing-period straddle (the SALE sits in an earlier, LOCKED period): the bind reads the same remaining the reversal books.
 *   G-L7  a line-named return (R-r22's shape): refused (A-3's pinned bind fires first; the A-4 bind would refuse it too).
 *   G-L8  a line that never booked a SALE row: accepted, as on master.   G-L9  the S1 shape on a non-regulated product: accepted.
 *   G-L10 for each accepted credit: the tax the reversal booked equals the levy the items store (within the closing drift).
 *   G-L3c (SA-1054 A-2) the money fits, the qty does not: refused (the qty arm). G-L12 two items on one order line and invoice: each
 *         fits, together they don't (the fold). G-L13 a line a re-sync offset and never re-booked: observed.
 *   CD-*  (SA-1054 A-3) a row that takes ALL the qty left may pass the ledger's money remaining by the money side's drift allowance
 *         (`creditDriftTol`): 10.00 / 6 pcs with 1 pc back twice leaves 6.67 on the money and 6.66 on the ledger, both at 4 pcs.
 *
 * Every tenant is a throwaway `qa-a4-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "../returns/returns.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { CreditNoteReissueService } from "../credit-notes/credit-note-reissue.service";
import { IdempotencyService } from "../common/idempotency.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { censusOldTypedCredits } from "./credit-reversal-census";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Shape {
  qty: number;
  boxes: number;
  pack: number;
  unitPrice: number;
  net: number;
  levy: number;
}
const PIECES: Shape = { qty: 200, boxes: 20, pack: 10, unitPrice: 0.25, net: 50, levy: 5 };
const BOXED: Shape = { qty: 60, boxes: 5, pack: 12, unitPrice: 1, net: 60, levy: 6 };
/** SA-1054 A-3: 10.00 over 6 pcs. 1 pc back twice leaves 6.67 on the money (it telescopes) and 6.66 on the ledger (a share of what is left). */
const SIX: Shape = { qty: 6, boxes: 6, pack: 1, unitPrice: 1.67, net: 10, levy: 1 };
/** SA-1054 A-5: the same 10.00 over more pieces: the qty the form never sends is derived from the rounded amount and overshoots. */
const TWENTY_FOUR: Shape = { qty: 24, boxes: 24, pack: 1, unitPrice: 0.42, net: 10, levy: 1 };
const SIX_HUNDRED: Shape = { qty: 600, boxes: 600, pack: 1, unitPrice: 0.02, net: 10, levy: 1 };

describeDb(
  "SA-1042 A-4: a typed credit on a regulated line fits what the ledger can still reverse — real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let returns: ReturnsService;
    let creditNotes: CreditNotesService;
    let reissue: CreditNoteReissueService;
    let ledger: RegulatedLedgerService;
    const tenantIds: string[] = [];
    let seq = 0;
    let cnSeq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      const mod = await Test.createTestingModule({
        providers: [
          CreditNotesService,
          CreditNoteReissueService,
          IdempotencyService,
          ReturnsService,
          RegulatedLedgerService,
          CommissionEngineService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          { provide: RouteFlowGateway, useValue: anyMethod },
          {
            provide: NumberingService,
            useValue: {
              reserveNext: jest.fn().mockImplementation(async () => `CN-A4-${RUN}-${++cnSeq}`),
            },
          },
        ],
      }).compile();
      returns = mod.get(ReturnsService);
      creditNotes = mod.get(CreditNotesService);
      reissue = mod.get(CreditNoteReissueService);
      ledger = mod.get(RegulatedLedgerService);
    });

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
        await prisma.regulatedFiling.deleteMany(where).catch(swallow);
        await prisma.returnItem.deleteMany(where).catch(swallow);
        await prisma.return.deleteMany(where).catch(swallow);
        await prisma.creditNoteItem.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.trackedCategory.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /**
     * Product P, one order, lines A and B of `shape`, two invoices (A's the later). `regulated` false = no tracked category on
     * the invoice lines and no SALE rows; `bookA` false = A is regulated on the invoice but never booked a SALE (G-L8);
     * `soldAt` backdates the SALE rows (G-L6).
     */
    async function seed(
      label: string,
      opts: {
        shape?: Shape;
        regulated?: boolean;
        bookA?: boolean;
        soldAt?: Date;
        roomB?: boolean;
      } = {},
    ) {
      const {
        shape = PIECES,
        regulated = true,
        bookA = true,
        soldAt = new Date(),
        roomB = false,
      } = opts;
      seq += 1;
      const slug = assertTestTenant(
        `qa-a4-${RUN}-${seq}-${label}`,
        "credit-reversal-room-a4.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `a4 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const category = await prisma.trackedCategory.create({
        data: { tenantId, name: `A4 category ${slug}` },
      });
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `P ${slug}`,
          unit: "each",
          pricePerUnit: shape.unitPrice,
          unitsPerBox: shape.pack,
        } as any,
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-A4-${RUN}-${seq}`,
          subtotal: shape.net * 2,
          tax: 0,
          total: shape.net * 2,
          status: "DELIVERED",
        } as any,
      });
      const lineShape = {
        qty: shape.qty,
        unitPrice: shape.unitPrice,
        subtotal: shape.net,
        boxes: shape.boxes,
        pieces: 0,
        unitsPerBox: shape.pack,
      };
      const mkLine = (position: number) =>
        prisma.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            productId: product.id,
            name: product.name,
            position,
            ...lineShape,
          } as any,
        });
      const lineA = await mkLine(0);
      const lineB = await mkLine(1);
      const [idLater, idEarlier] = [randomUUID(), randomUUID()].sort();
      const invoiceA = await prisma.invoice.create({
        data: {
          id: idLater,
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-A4-${RUN}-${seq}`,
          status: "SENT",
          subtotal: shape.net,
          taxAmount: 0,
          discount: 0,
          total: shape.net * 3.8,
        },
      });
      const invoiceB = await prisma.invoice.create({
        data: {
          id: idEarlier,
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-A4-${RUN}-${seq}-B`,
          status: "SENT",
          subtotal: shape.net,
          taxAmount: 0,
          discount: 0,
          total: roomB ? shape.net * 3.8 : shape.net,
          createdAt: new Date(Date.now() - 3_600_000),
        },
      });
      const mkItem = (orderItemId: string, invoiceId: string) =>
        prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId,
            orderItemId,
            productId: product.id,
            description: "P",
            ...(regulated ? { trackedCategoryId: category.id, categoryTaxAmount: shape.levy } : {}),
            ...lineShape,
          } as any,
        });
      const iA = await mkItem(lineA.id, invoiceA.id);
      const iB = await mkItem(lineB.id, invoiceB.id);
      if (regulated) {
        const book = (invoiceId: string, item: typeof iA, orderItemId: string) =>
          ledger.writeSaleEntries({
            tenantId,
            orderId: order.id,
            invoiceId,
            soldAt,
            db: prisma,
            lines: [
              {
                invoiceItemId: item.id,
                orderItemId,
                trackedCategoryId: category.id,
                qty: shape.qty,
                boxes: shape.boxes,
                pieces: 0,
                unitsPerBox: shape.pack,
                netSales: shape.net,
                categoryTax: shape.levy,
              },
            ],
          });
        if (bookA) await book(invoiceA.id, iA, lineA.id);
        await book(invoiceB.id, iB, lineB.id);
      }
      return {
        tenantId,
        customerId: customer.id,
        userId: user.id,
        orderId: order.id,
        productId: product.id,
        categoryId: category.id,
        shape,
        lineA,
        lineB,
        invoiceA,
        invoiceB,
        iA,
        iB,
      };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;

    /** A return of `qty` pcs of P (naming `lineId`, or no line), received (the ledger reversal) and refunded (the lump). */
    async function returnAndRefund(s: Seed, qty: number, lineId: string | null = null) {
      const ret: any = await tenantCtx.run(s.tenantId, () =>
        returns.create(
          {
            orderId: s.orderId,
            reason: "DAMAGED",
            items: [{ productId: s.productId, ...(lineId ? { orderItemId: lineId } : {}), qty }],
          } as any,
          s.userId,
        ),
      );
      await prisma.return.update({ where: { id: ret.id }, data: { status: "APPROVED" } });
      await tenantCtx.run(s.tenantId, () => returns.receive(ret.id, s.userId));
      await tenantCtx.run(s.tenantId, () => returns.processRefund(ret.id));
      return prisma.creditNote.findFirstOrThrow({
        where: { tenantId: s.tenantId, status: { not: "VOID" } },
      });
    }

    /** A typed credit note on `invoiceId`'s item `itemId`; the error (or null) it answered. */
    const typedCredit = (
      s: Seed,
      invoiceId: string,
      itemId: string,
      amount: number,
      qty?: number,
    ) =>
      tenantCtx
        .run(s.tenantId, () =>
          creditNotes.create({
            customerId: s.customerId,
            invoiceId,
            amount,
            reason: "a4 typed credit",
            items: [{ invoiceItemId: itemId, amount, ...(qty != null ? { qty } : {}) }],
          } as any),
        )
        .then(() => null)
        .catch((e: any) => e);

    const codeOf = (e: any) => e?.getResponse?.()?.code ?? null;
    /** Which refusal answered, from the wording each door in credit-notes.service.ts uses (null = accepted). */
    const doorOf = (e: any) => {
      if (!e) return null;
      const m = String(e?.getResponse?.()?.message ?? e?.message ?? "");
      if (/would exceed invoice total/.test(m)) return "invoice-total";
      if (/past what it was billed/.test(m)) return "order-billed";
      if (/after the return already refunded/.test(m)) return "pinned (A-3)";
      if (/still allow to be credited for the product/.test(m)) return "pool";
      if (/regulated ledger can still reverse/.test(m)) return "ledger room (A-4)";
      return `other: ${m}`;
    };
    const noteCount = (s: Seed) =>
      prisma.creditNote.count({ where: { tenantId: s.tenantId, status: { not: "VOID" } } });
    const itemCount = (s: Seed) => prisma.creditNoteItem.count({ where: { tenantId: s.tenantId } });
    const ledgerRows = (s: Seed) =>
      prisma.regulatedSalesLedger.findMany({ where: { tenantId: s.tenantId } });
    /** Σ(SALE + REVERSAL) of the tenant's category: what the filing would report. */
    async function filing(s: Seed) {
      const rows = await ledgerRows(s);
      return {
        net: round2(rows.reduce((n, r) => n + Number(r.netSales), 0)),
        tax: round2(rows.reduce((n, r) => n + Number(r.categoryTax), 0)),
      };
    }
    /** G-L10: the levy the credit notes' regulated items store vs the tax their REVERSAL rows booked. */
    async function taxAgreement(s: Seed) {
      const items = await prisma.creditNoteItem.findMany({
        where: { tenantId: s.tenantId, trackedCategoryId: { not: null } },
      });
      const booked = (await ledgerRows(s)).filter(
        (r) => r.entryType === "REVERSAL" && r.creditNoteId != null,
      );
      return {
        stored: round2(items.reduce((n, i) => n + Number(i.categoryTax), 0)),
        booked: round2(-booked.reduce((n, r) => n + Number(r.categoryTax), 0)) + 0, // + 0: never -0
      };
    }

    it("R-L1: a typed credit on the line a pooled return already closed is CREDIT_NOTE_OVER_HEADROOM, nothing written", async () => {
      const s = await seed("rl1");
      const lump = await returnAndRefund(s, 200);
      expect(Number(lump.amount)).toBe(50);
      expect(lump.invoiceId).toBe(s.invoiceB.id); // SA-1051: the pooled refund fills the oldest invoice (B) first; the ledger reverses A
      expect(await filing(s)).toEqual({ net: 50, tax: 5 }); // B only: A's reversal took 50 / 5
      const before = (await ledgerRows(s)).length;
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 50, 200);
      expect(doorOf(err)).toBe("ledger room (A-4)"); // the red comes from the A-4 bind, not another door
      expect({
        code: codeOf(err),
        notes: await noteCount(s),
        items: await itemCount(s),
        rows: (await ledgerRows(s)).length - before,
        filing: await filing(s),
      }).toEqual({
        code: "CREDIT_NOTE_OVER_HEADROOM",
        notes: 1,
        items: 0,
        rows: 0,
        filing: { net: 50, tax: 5 },
      });
    });

    it("G-L2: the same return, then the typed credit on B (the line with room): accepted, the category nets 0 / 0", async () => {
      const s = await seed("gl2", { roomB: true }); // B's invoice gets room, so its total cap cannot mask the bind (SA-1054)
      await returnAndRefund(s, 200);
      const err = await typedCredit(s, s.invoiceB.id, s.iB.id, 50, 200);
      expect({ code: codeOf(err), notes: await noteCount(s), filing: await filing(s) }).toEqual({
        code: null,
        notes: 2,
        filing: { net: 0, tax: 0 },
      });
      expect(await taxAgreement(s)).toEqual({ stored: 5, booked: 5 });
    });

    it("G-L11 (OBSERVED, no value ruled): G-L2's original totals (B 50.00): which door refuses a typed credit on B and on A, and does any fit", async () => {
      const s = await seed("gl11"); // B's invoice total stays 50.00: the refund lump (50.00) already uses all of it
      const lump = await returnAndRefund(s, 200);
      const ledgerLines = (await ledgerRows(s))
        .filter((r) => r.entryType === "REVERSAL")
        .map((r) => (r.orderItemId === s.lineA.id ? "A" : "B"));
      const full = { onB: await typedCredit(s, s.invoiceB.id, s.iB.id, 50, 200), onA: null as any };
      full.onA = await typedCredit(s, s.invoiceA.id, s.iA.id, 50, 200);
      // the smallest typed credit: 1 pc / 0.25 on each line
      const smallB = await typedCredit(s, s.invoiceB.id, s.iB.id, 0.25, 1);
      const smallA = await typedCredit(s, s.invoiceA.id, s.iA.id, 0.25, 1);
      expect({
        lumpOn: lump.invoiceId === s.invoiceB.id ? "B" : "A",
        ledgerReversedLine: ledgerLines,
        fullOnB: doorOf(full.onB),
        fullOnA: doorOf(full.onA),
        smallOnB: doorOf(smallB),
        smallOnA: doorOf(smallA),
        notes: await noteCount(s),
      }).toEqual({
        lumpOn: "B", // the money consumed B ...
        ledgerReversedLine: ["A"], // ... and the ledger consumed A (F-7)
        fullOnB: "invoice-total",
        fullOnA: "ledger room (A-4)",
        smallOnB: "invoice-total",
        smallOnA: "ledger room (A-4)",
        notes: 1, // no typed credit fits either line
      });
    });

    it("G-L3: a pooled 100-pc return, then a typed 100-pc credit on A is accepted and books A's remainder", async () => {
      const s = await seed("gl3a");
      await returnAndRefund(s, 100);
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 25, 100);
      expect({ code: codeOf(err), filing: await filing(s) }).toEqual({
        code: null,
        filing: { net: 50, tax: 5 }, // B untouched, A reversed 25 + 25
      });
      expect(await taxAgreement(s)).toEqual({ stored: 2.5, booked: 2.5 });
    });

    it("G-L3: a pooled 100-pc return, then a typed 150-pc credit on A is refused (37.50 > the 25.00 A can still reverse)", async () => {
      const s = await seed("gl3b");
      await returnAndRefund(s, 100);
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 37.5, 150);
      expect({ code: codeOf(err), notes: await noteCount(s), items: await itemCount(s) }).toEqual({
        code: "CREDIT_NOTE_OVER_HEADROOM",
        notes: 1,
        items: 0,
      });
    });

    it("G-L4: a rotated invoice item (the SALE row sits under the old id): the refusal comes through the order line", async () => {
      const s = await seed("gl4");
      const rotated = await prisma.invoiceItem.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.invoiceA.id,
          orderItemId: s.lineA.id,
          productId: s.productId,
          description: "P",
          trackedCategoryId: s.categoryId,
          categoryTaxAmount: s.shape.levy,
          qty: s.shape.qty,
          unitPrice: s.shape.unitPrice,
          subtotal: s.shape.net,
          boxes: s.shape.boxes,
          pieces: 0,
          unitsPerBox: s.shape.pack,
        } as any,
      });
      await prisma.invoiceItem.delete({ where: { id: s.iA.id } }); // the ledger has no FK: the SALE row keeps the old id
      await returnAndRefund(s, 200);
      const err = await typedCredit(s, s.invoiceA.id, rotated.id, 50, 200);
      expect({ code: codeOf(err), notes: await noteCount(s), items: await itemCount(s) }).toEqual({
        code: "CREDIT_NOTE_OVER_HEADROOM",
        notes: 1,
        items: 0,
      });
    });

    it("G-L5: boxed line (5 boxes of 12): a pooled 30-pc return, then 30 pcs is accepted (books the remainder), 45 pcs is refused", async () => {
      const ok = await seed("gl5a", { shape: BOXED });
      await returnAndRefund(ok, 30);
      const accepted = await typedCredit(ok, ok.invoiceA.id, ok.iA.id, 30, 30);
      expect({ code: codeOf(accepted), filing: await filing(ok) }).toEqual({
        code: null,
        filing: { net: 60, tax: 6 },
      });
      expect(await taxAgreement(ok)).toEqual({ stored: 3, booked: 3 });
      const over = await seed("gl5b", { shape: BOXED });
      await returnAndRefund(over, 30);
      const refused = await typedCredit(over, over.invoiceA.id, over.iA.id, 45, 45);
      expect({ code: codeOf(refused), items: await itemCount(over) }).toEqual({
        code: "CREDIT_NOTE_OVER_HEADROOM",
        items: 0,
      });
    });

    it("G-L6: the SALE sits in an earlier LOCKED period: the same refusal, and a credit that fits books into the current period", async () => {
      const prev = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 10),
      );
      const key = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
      const lock = (s: Seed) =>
        prisma.regulatedFiling.create({
          data: {
            tenantId: s.tenantId,
            trackedCategoryId: s.categoryId,
            reportTemplate: "a4-test",
            periodKey: key,
            periodStart: new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), 1)),
            periodEnd: new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1)),
            status: "LOCKED",
            lockedAt: new Date(),
            rows: [],
          } as any,
        });
      const full = await seed("gl6a", { soldAt: prev });
      await lock(full);
      await returnAndRefund(full, 200);
      const refused = await typedCredit(full, full.invoiceA.id, full.iA.id, 50, 200);
      expect({ code: codeOf(refused), items: await itemCount(full) }).toEqual({
        code: "CREDIT_NOTE_OVER_HEADROOM",
        items: 0,
      });
      const part = await seed("gl6b", { soldAt: prev });
      await lock(part);
      await returnAndRefund(part, 100);
      const accepted = await typedCredit(part, part.invoiceA.id, part.iA.id, 25, 100);
      expect(codeOf(accepted)).toBeNull();
      expect(await taxAgreement(part)).toEqual({ stored: 2.5, booked: 2.5 });
    });

    it("G-L7: a line-named return of A, then a typed credit on A: refused (A-3's pinned bind fires first)", async () => {
      const s = await seed("gl7");
      await returnAndRefund(s, 200, s.lineA.id);
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 50, 200);
      expect({ code: codeOf(err), notes: await noteCount(s), items: await itemCount(s) }).toEqual({
        code: "CREDIT_NOTE_OVER_HEADROOM",
        notes: 1,
        items: 0,
      });
      expect(String(err?.getResponse?.()?.message)).toMatch(/after the return already refunded/);
    });

    it("G-L8: a regulated invoice line that never booked a SALE row: the typed credit is accepted, the ledger books nothing", async () => {
      const s = await seed("gl8", { bookA: false });
      await returnAndRefund(s, 200); // reverses B's booked line only
      const before = (await ledgerRows(s)).length;
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 50, 200);
      expect({ code: codeOf(err), rows: (await ledgerRows(s)).length - before }).toEqual({
        code: null,
        rows: 0,
      });
      // OBSERVED, not bound: the item stores the levy (5.00) the reversal had no SALE to book against
      expect(await taxAgreement(s)).toEqual({ stored: 5, booked: 0 });
    });

    it("G-L9: the S1 shape on a NON-regulated product: accepted, as on master (G-r23 KEPT)", async () => {
      const s = await seed("gl9", { regulated: false });
      await returnAndRefund(s, 200);
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 50, 200);
      expect({ code: codeOf(err), notes: await noteCount(s) }).toEqual({ code: null, notes: 2 });
      expect(await ledgerRows(s)).toEqual([]);
    });

    /** A typed credit note with several items on one invoice; the error (or null) it answered. */
    const typedCreditItems = (
      s: Seed,
      invoiceId: string,
      items: { invoiceItemId: string; amount: number; qty?: number }[],
    ) =>
      tenantCtx
        .run(s.tenantId, () =>
          creditNotes.create({
            customerId: s.customerId,
            invoiceId,
            amount: round2(items.reduce((n, i) => n + i.amount, 0)),
            reason: "a4 typed credit",
            items,
          } as any),
        )
        .then(() => null)
        .catch((e: any) => e);

    /** Line A's ledger rows: net / qty / tax summed over the order line, and its credit-note REVERSAL rows. */
    async function lineA(s: Seed) {
      const rows = (await ledgerRows(s)).filter((r) => r.orderItemId === s.lineA.id);
      return {
        net: round2(rows.reduce((n, r) => n + Number(r.netSales), 0)) + 0,
        qty: round2(rows.reduce((n, r) => n + Number(r.qty), 0)) + 0,
        tax: round2(rows.reduce((n, r) => n + Number(r.categoryTax), 0)) + 0,
        creditRows: rows
          .filter((r) => r.entryType === "REVERSAL" && r.creditNoteId != null)
          .map((r) => ({ net: Number(r.netSales), qty: Number(r.qty) })),
      };
    }

    const secondItemOnA = (s: Seed) =>
      prisma.invoiceItem.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.invoiceA.id,
          orderItemId: s.lineA.id,
          productId: s.productId,
          description: "P",
          trackedCategoryId: s.categoryId,
          categoryTaxAmount: s.shape.levy,
          qty: s.shape.qty,
          unitPrice: s.shape.unitPrice,
          subtotal: s.shape.net,
          boxes: s.shape.boxes,
          pieces: 0,
          unitsPerBox: s.shape.pack,
        } as any,
      });

    it("G-L3c (SA-1054 A-2): a 100-pc return, then a typed 20.00 / 150 pcs on A: the money fits, the qty does not: refused by the bind", async () => {
      const s = await seed("gl3c");
      await returnAndRefund(s, 100);
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 20, 150);
      expect({ code: codeOf(err), door: doorOf(err), items: await itemCount(s) }).toEqual({
        code: "CREDIT_NOTE_OVER_HEADROOM",
        door: "ledger room (A-4)",
        items: 0,
      });
    });

    it("G-L12 (SA-1054 A-2): two items on one order line and invoice, both kept: each fits alone, together they don't", async () => {
      const one = await seed("gl12a");
      expect(
        codeOf(
          await typedCreditItems(one, one.invoiceA.id, [
            { invoiceItemId: one.iA.id, amount: 30, qty: 120 },
          ]),
        ),
      ).toBeNull(); // each row fits the order line on its own ...
      const s = await seed("gl12b");
      const second = await secondItemOnA(s);
      const both = await typedCreditItems(s, s.invoiceA.id, [
        { invoiceItemId: s.iA.id, amount: 30, qty: 120 },
        { invoiceItemId: second.id, amount: 30, qty: 120 },
      ]);
      expect({ door: doorOf(both), notes: await noteCount(s), items: await itemCount(s) }).toEqual({
        door: "ledger room (A-4)", // ... together they ask for 60.00 / 240 of the 50.00 / 200 the line holds
        notes: 0,
        items: 0,
      });
    });

    it("A7 (SA-1054 A-2 fold, money half): 30.00 / 40 pcs on two items of one order line: each fits, together 60.00 of the 50.00 held: refused", async () => {
      // the qty half is G-L12; here the qty is small (80 of 200) so only the money arm of the fold can refuse
      const s = await seed("a7");
      const second = await secondItemOnA(s);
      const both = await typedCreditItems(s, s.invoiceA.id, [
        { invoiceItemId: s.iA.id, amount: 30, qty: 40 },
        { invoiceItemId: second.id, amount: 30, qty: 40 },
      ]);
      expect({ door: doorOf(both), notes: await noteCount(s), items: await itemCount(s) }).toEqual({
        door: "ledger room (A-4)",
        notes: 0,
        items: 0,
      });
      const one = await seed("a7b");
      expect(
        codeOf(
          await typedCreditItems(one, one.invoiceA.id, [
            { invoiceItemId: one.iA.id, amount: 30, qty: 40 },
          ]),
        ),
      ).toBeNull(); // 30.00 / 40 alone fits
    });

    it("G-L13 (OBSERVED, SA-1054 A-2): a line a re-sync offset and never re-booked: a typed credit is refused with 0 left, a lump is accepted", async () => {
      const s = await seed("gl13");
      await prisma.regulatedSalesLedger.create({
        data: {
          tenantId: s.tenantId,
          trackedCategoryId: s.categoryId,
          entryType: "REVERSAL",
          orderId: s.orderId,
          orderItemId: s.lineA.id,
          invoiceId: s.invoiceA.id,
          invoiceItemId: s.iA.id,
          qty: -s.shape.qty,
          unitBasisQty: -s.shape.qty,
          netSales: -s.shape.net,
          categoryTax: -s.shape.levy,
          soldAt: new Date(),
          periodBucket: "2026-11",
        },
      });
      const typed = await typedCredit(s, s.invoiceA.id, s.iA.id, 10, 40);
      const lump = await tenantCtx
        .run(s.tenantId, () =>
          creditNotes.create({
            customerId: s.customerId,
            invoiceId: s.invoiceA.id,
            amount: 10,
            reason: "a4 lump",
          } as any),
        )
        .then(() => null)
        .catch((e: any) => e);
      expect({ typed: doorOf(typed), lump: codeOf(lump) }).toEqual({
        typed: "ledger room (A-4)",
        lump: null,
      });
    });

    /** SA-1054 A-3: 10.00 / 6 pcs on A, 1 pc back twice: the ledger leaves 6.66 / 4 pcs, the money 6.67. */
    async function twoPartialReturns(label: string) {
      const s = await seed(label, { shape: SIX });
      await returnAndRefund(s, 1);
      await returnAndRefund(s, 1);
      return s;
    }

    it("CD-1: a typed 6.67 / 4 pcs closes the line: accepted, the reversal books 6.66 / 4, A nets 0 / 0, the item stores 6.67", async () => {
      const s = await twoPartialReturns("cd1");
      const before = await lineA(s);
      expect({ net: before.net, qty: before.qty }).toEqual({ net: 6.66, qty: 4 }); // the ledger's remaining, as the seat measured it
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 6.67, 4);
      expect(codeOf(err)).toBeNull();
      const after = await lineA(s);
      expect({ net: after.net, qty: after.qty, tax: after.tax }).toEqual({
        net: 0,
        qty: 0,
        tax: 0,
      });
      expect(after.creditRows).toEqual([{ net: -6.66, qty: -4 }]);
      const item = await prisma.creditNoteItem.findFirstOrThrow({
        where: { tenantId: s.tenantId },
      });
      expect(Number(item.amount)).toBe(6.67); // stored 6.67, booked 6.66: the cent the allowance covers
    });

    it("CD-2: 6.67 / 3 of the 4 left (not closing) is still refused", async () => {
      const s = await twoPartialReturns("cd2");
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 6.67, 3);
      expect({ door: doorOf(err), items: await itemCount(s) }).toEqual({
        door: "ledger room (A-4)",
        items: 0,
      });
    });

    it("CD-3: 6.66 / 4 is accepted, as before", async () => {
      const s = await twoPartialReturns("cd3");
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 6.66, 4))).toBeNull();
      expect((await lineA(s)).qty).toBe(0);
    });

    it("CD-4: 6.70 / 4 is past the allowance: refused by the bind", async () => {
      const s = await twoPartialReturns("cd4");
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 6.7, 4);
      expect({ door: doorOf(err), items: await itemCount(s) }).toEqual({
        door: "ledger room (A-4)",
        items: 0,
      });
    });

    it("CD-5: two rows on the line, 3.34 / 2 and 3.33 / 2: the second closes and is accepted", async () => {
      const s = await twoPartialReturns("cd5");
      const err = await typedCreditItems(s, s.invoiceA.id, [
        { invoiceItemId: s.iA.id, amount: 3.34, qty: 2 },
        { invoiceItemId: s.iA.id, amount: 3.33, qty: 2 },
      ]);
      expect(codeOf(err)).toBeNull();
      const after = await lineA(s);
      expect({ net: after.net, qty: after.qty }).toEqual({ net: 0, qty: 0 });
    });

    it("CD-9: an amount-only 6.67 (no qty typed) derives 4 pcs and is accepted, as CD-1", async () => {
      const s = await twoPartialReturns("cd9");
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 6.67))).toBeNull();
      expect((await lineA(s)).qty).toBe(0);
    });

    it("CD-10: a reissue of CD-1's note passes the dry run (the old note excluded) and the in-tx re-cap", async () => {
      const s = await twoPartialReturns("cd10");
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 6.67, 4))).toBeNull();
      const old = await prisma.creditNote.findFirstOrThrow({
        where: { tenantId: s.tenantId, status: { not: "VOID" }, items: { some: {} } },
      });
      const res: any = await tenantCtx.run(s.tenantId, () =>
        reissue.reissue(
          old.id,
          { amount: 6.67, items: [{ invoiceItemId: s.iA.id, amount: 6.67, qty: 4 }] } as any,
          `cd10-${RUN}`,
          null,
        ),
      );
      expect(res).toBeTruthy();
      const after = await lineA(s);
      expect({ net: after.net, qty: after.qty }).toEqual({ net: 0, qty: 0 });
    });

    /**
     * SA-1054 A-4: CD-11 at the DB, one row per shape. The line's money left is 6.67 in all three. These rows pin today's
     * behaviour on purpose: on an order with two or more live invoices a closing credit of 6.68 ends the line a cent over
     * (notes sum 10.01), the money side's own tolerance; when that row lands, CD-11b and CD-11c change with it.
     */
    const noteSum = async (s: Seed) =>
      round2(
        Number(
          (
            await prisma.creditNote.aggregate({
              where: { tenantId: s.tenantId, status: { not: "VOID" } },
              _sum: { amount: true },
            })
          )._sum.amount ?? 0,
        ),
      );
    async function twoReturnsOn(label: string, v: { voidB?: boolean; named?: boolean }) {
      const s = await seed(label, { shape: SIX });
      if (v.voidB)
        await prisma.invoice.update({ where: { id: s.invoiceB.id }, data: { status: "VOID" } });
      await returnAndRefund(s, 1, v.named ? s.lineA.id : null);
      await returnAndRefund(s, 1, v.named ? s.lineA.id : null);
      return s;
    }

    /**
     * SA-1054 A-5, rows CD-13 to CD-19: the web form sends no qty, so the service derives one from the rounded amount and the
     * room used to test THAT against the qty left. On a two-invoice order (the refund notes carry no items) it overshoots by a
     * sliver and the room refused a row whose money fit. A row typed by amount only is held to the money left. A typed qty
     * stays strict. CD-17 and CD-19 pin today's cents on purpose and move with the money side's row.
     */
    async function returnsOf(label: string, shape: Shape, qtys: number[], named = false) {
      const s = await seed(label, { shape });
      for (const q of qtys) await returnAndRefund(s, q, named ? s.lineA.id : null);
      return s;
    }
    const ledgerOf = async (s: Seed) => {
      const a = await lineA(s);
      return { net: a.net, qty: a.qty };
    };

    it("CD-13: 24 pcs, 4 + 4 back, no line named, an amount-only 6.67 is accepted and the line nets 0 / 0", async () => {
      const s = await returnsOf("cd13", TWENTY_FOUR, [4, 4]);
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 6.67))).toBeNull();
      expect(await ledgerOf(s)).toEqual({ net: 0, qty: 0 });
      const item = await prisma.creditNoteItem.findFirstOrThrow({
        where: { tenantId: s.tenantId },
      });
      expect(Number(item.amount)).toBe(6.67);
    });

    it("CD-14: 600 pcs, one return of 200, no line named, an amount-only 6.67 is accepted (no drift needed)", async () => {
      const s = await returnsOf("cd14", SIX_HUNDRED, [200]);
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 6.67))).toBeNull();
      expect(await ledgerOf(s)).toEqual({ net: 0, qty: 0 });
    });

    it("CD-15: 24 pcs, 4 + 4 back, an amount-only 3.00 then 3.67 are both accepted and the line nets 0 / 0", async () => {
      const s = await returnsOf("cd15", TWENTY_FOUR, [4, 4]);
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 3))).toBeNull();
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 3.67))).toBeNull();
      expect(await ledgerOf(s)).toEqual({ net: 0, qty: 0 });
    });

    it("CD-16: 24 pcs, 12 back, a typed 1.00 / 10 then an amount-only 2.00 is accepted; 2.00 / 0 pcs is left", async () => {
      const s = await returnsOf("cd16", TWENTY_FOUR, [12]);
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 1, 10))).toBeNull();
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 2))).toBeNull();
      expect(await ledgerOf(s)).toEqual({ net: 2, qty: 0 });
    });

    it("CD-17: 24 pcs, 4 + 4 back, an amount-only 6.68 is accepted: the line nets 0 / 0 and the notes sum 10.01 (the money side's cent)", async () => {
      const s = await returnsOf("cd17", TWENTY_FOUR, [4, 4]);
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 6.68))).toBeNull();
      expect(await ledgerOf(s)).toEqual({ net: 0, qty: 0 });
      expect(await noteSum(s)).toBe(10.01);
    });

    it("CD-18: refused by the room, nothing written: amount-only 6.69 and 8.00, a typed 6.67 / 16.1, and 0.03 on a closed line", async () => {
      for (const [label, amount, qty] of [
        ["cd18a", 6.69, undefined],
        ["cd18b", 8, undefined],
        ["cd18c", 6.67, 16.1],
      ] as const) {
        const s = await returnsOf(label, TWENTY_FOUR, [4, 4]);
        const itemsBefore = await itemCount(s);
        const err = await typedCredit(s, s.invoiceA.id, s.iA.id, amount, qty);
        expect({ label, door: doorOf(err) }).toEqual({ label, door: "ledger room (A-4)" });
        expect(await itemCount(s)).toBe(itemsBefore);
      }
      const closed = await returnsOf("cd18d", TWENTY_FOUR, [12, 12]);
      const itemsBefore = await itemCount(closed);
      const err = await typedCredit(closed, closed.invoiceA.id, closed.iA.id, 0.03);
      expect(doorOf(err)).toBe("ledger room (A-4)");
      expect(await itemCount(closed)).toBe(itemsBefore);
    });

    it("CD-19: the return names the line: an amount-only 6.67 is still refused, by the pinned door (24 pcs 4 + 4, and 600 pcs one return of 200)", async () => {
      for (const [label, shape, qtys] of [
        ["cd19a", TWENTY_FOUR, [4, 4]],
        ["cd19b", SIX_HUNDRED, [200]],
      ] as const) {
        const s = await returnsOf(label, shape, [...qtys], true);
        const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 6.67);
        expect({ label, door: doorOf(err) }).toEqual({ label, door: "pinned (A-3)" });
        expect({ label, items: await itemCount(s) }).toEqual({ label, items: 0 });
      }
    });

    /**
     * SA-1054 A-6, rows CD-20 to CD-22: the branches of A-5's rule that no earlier row could see, because every amount-only row
     * so far reached the qty left anyway. A row typed by amount only is held to the money left (the money test); the row that
     * takes all of it closes the line, a row that takes part of it stays small (the qty left is not the default).
     */
    it("CD-20: 24 pcs, 4 + 4 back, a typed 3.00 / 1 then an amount-only 3.67 (all the money left) is accepted and the line nets 0 / 0", async () => {
      const s = await returnsOf("cd20", TWENTY_FOUR, [4, 4]);
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 3, 1))).toBeNull();
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 3.67))).toBeNull();
      expect(await ledgerOf(s)).toEqual({ net: 0, qty: 0 });
    });

    it("CD-21: 24 pcs, 4 + 4 back, two items on one order line, amount-only 3.33 + 3.34: accepted and the line nets 0 / 0", async () => {
      const s = await returnsOf("cd21", TWENTY_FOUR, [4, 4]);
      const second = await secondItemOnA(s);
      const err = await typedCreditItems(s, s.invoiceA.id, [
        { invoiceItemId: s.iA.id, amount: 3.33 },
        { invoiceItemId: second.id, amount: 3.34 },
      ]);
      expect({ code: codeOf(err), door: doorOf(err) }).toEqual({ code: null, door: null });
      expect(await ledgerOf(s)).toEqual({ net: 0, qty: 0 });
    });

    it("CD-22: 24 pcs, 12 back, a typed 1.00 / 12 then an amount-only 2.00 twice: the line nets 2 / 0 then 0 / 0, no levy left, census short 0; 2.03 on the 2.00 left is refused", async () => {
      const s = await returnsOf("cd22", TWENTY_FOUR, [12]);
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 1, 12))).toBeNull();
      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 2))).toBeNull();
      expect(await ledgerOf(s)).toEqual({ net: 2, qty: 0 });

      const refused = await returnsOf("cd22b", TWENTY_FOUR, [12]);
      expect(
        codeOf(await typedCredit(refused, refused.invoiceA.id, refused.iA.id, 1, 12)),
      ).toBeNull();
      expect(codeOf(await typedCredit(refused, refused.invoiceA.id, refused.iA.id, 2))).toBeNull();
      const itemsBefore = await itemCount(refused);
      const err = await typedCredit(refused, refused.invoiceA.id, refused.iA.id, 2.03);
      expect(doorOf(err)).toBe("ledger room (A-4)");
      expect(await itemCount(refused)).toBe(itemsBefore);

      expect(codeOf(await typedCredit(s, s.invoiceA.id, s.iA.id, 2))).toBeNull();
      const after = await lineA(s);
      expect({ net: after.net, qty: after.qty, tax: after.tax }).toEqual({
        net: 0,
        qty: 0,
        tax: 0,
      });
      const census = await censusOldTypedCredits(prisma, { tenantId: s.tenantId });
      expect(census.notesBookedLessTaxThanStored).toBe(0);
    });

    it("CD-11a: one live invoice: 6.68 / 4 is refused by the money check (no item); 6.67 / 4 is accepted and the ledger reads 0 / 0", async () => {
      const refused = await twoReturnsOn("cd11a1", { voidB: true });
      const itemsBefore = await itemCount(refused);
      const err = await typedCredit(refused, refused.invoiceA.id, refused.iA.id, 6.68, 4);
      expect(codeOf(err)).toBe("CREDIT_NOTE_OVER_HEADROOM");
      expect(doorOf(err)).toMatch(/would exceed invoice line subtotal/);
      expect(await itemCount(refused)).toBe(itemsBefore);

      const ok = await twoReturnsOn("cd11a2", { voidB: true });
      expect(codeOf(await typedCredit(ok, ok.invoiceA.id, ok.iA.id, 6.67, 4))).toBeNull();
      const after = await lineA(ok);
      expect({ net: after.net, qty: after.qty }).toEqual({ net: 0, qty: 0 });
    });

    it("CD-11b: two invoices, the return names line A: 6.68 / 4 is accepted (notes sum 10.01, ledger 0 / 0); 6.69 / 4 is refused by the pinned door", async () => {
      const ok = await twoReturnsOn("cd11b1", { named: true });
      expect(codeOf(await typedCredit(ok, ok.invoiceA.id, ok.iA.id, 6.67, 4))).toBeNull();

      const accepted = await twoReturnsOn("cd11b2", { named: true });
      expect(
        codeOf(await typedCredit(accepted, accepted.invoiceA.id, accepted.iA.id, 6.68, 4)),
      ).toBeNull();
      expect(await noteSum(accepted)).toBe(10.01);
      const after = await lineA(accepted);
      expect({ net: after.net, qty: after.qty }).toEqual({ net: 0, qty: 0 });

      const refused = await twoReturnsOn("cd11b3", { named: true });
      const err = await typedCredit(refused, refused.invoiceA.id, refused.iA.id, 6.69, 4);
      expect(doorOf(err)).toBe("pinned (A-3)");
      expect(String(err?.getResponse?.()?.message)).toContain("6.67 left");
      expect(await itemCount(refused)).toBe(0);
    });

    it("CD-11c: two invoices, the return names no line: 6.68 / 4 is accepted (notes sum 10.01, ledger 0 / 0); 6.69 / 4 is refused by the room", async () => {
      const ok = await twoReturnsOn("cd11c1", {});
      expect(codeOf(await typedCredit(ok, ok.invoiceA.id, ok.iA.id, 6.67, 4))).toBeNull();

      const accepted = await twoReturnsOn("cd11c2", {});
      expect(
        codeOf(await typedCredit(accepted, accepted.invoiceA.id, accepted.iA.id, 6.68, 4)),
      ).toBeNull();
      expect(await noteSum(accepted)).toBe(10.01);
      const after = await lineA(accepted);
      expect({ net: after.net, qty: after.qty }).toEqual({ net: 0, qty: 0 });

      const refused = await twoReturnsOn("cd11c3", {});
      const err = await typedCredit(refused, refused.invoiceA.id, refused.iA.id, 6.69, 4);
      expect(doorOf(err)).toBe("ledger room (A-4)");
      expect(await itemCount(refused)).toBe(0);
    });
  },
);
