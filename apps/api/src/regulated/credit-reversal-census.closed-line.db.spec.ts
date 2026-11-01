/**
 * SA-1054 A-2 (rows CS-1 to CS-3) on REAL Postgres: the old-rows census (`censusOldTypedCredits`) must SEE a line a return or a
 * credit closed — the shape it exists to find. A return or credit REVERSAL reverses a sale, it does not unbook it; only a re-sync
 * or void offset does. `deadSaleIdsOf` nets each key twice and the second pass includes return and credit REVERSALs, so a line they
 * closed read dead and the census filed it under `itemsWithoutLiveSale`, never comparing stored against booked. The census now
 * feeds `deadSaleIdsOf` the line's rows without them.
 *
 *   CS-1  S1: a SALE (10 pcs / 100.00 / 10.00), a RETURN reversal closes the line, a typed credit stores 5.00 levy and its note
 *         booked no REVERSAL                                              -> live, flagged, booked 0
 *   CS-2  a return (2 pcs), then a typed credit that clamps and closes (stores 10.00 levy, the ledger books the 8.00 left)
 *                                                                          -> live, flagged, stored 10.00 against booked 8.00
 *   CS-3  N3 unchanged: a SALE offset in place by a re-sync REVERSAL (no returnId, no creditNoteId)        -> NOT live, not flagged
 *   CS-4  A-2's third shape: a typed credit ALONE closes the line (no return); stored 10.00 = booked 10.00 -> live, NOT flagged
 *         (fails if the census nets the credit's own REVERSAL: the line would read dead and drop to itemsWithoutLiveSale)
 *
 * Collected only by `jest.db.config.js` (`npm run local:test:db`).
 * SAFETY: a throwaway `qa-cs-<run>` tenant approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { censusOldTypedCredits } from "./credit-reversal-census";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-1054 A-2: the census sees a line a return or a credit closed", () => {
  let prisma: PrismaService;
  let tenantId = "";
  const noteIds: Record<string, string> = {};

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    const slug = assertTestTenant(`qa-cs-${RUN}`, "credit-reversal-census.closed-line.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `cs ${slug}` } })).id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "c cs", contactName: "c cs", tenantId },
    });
    const category = await prisma.trackedCategory.create({
      data: { tenantId, name: `CS category ${slug}` },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `P ${slug}`, unit: "each", pricePerUnit: 10, unitsPerBox: 1 } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-CS-${RUN}`,
        subtotal: 300,
        tax: 0,
        total: 300,
        status: "DELIVERED",
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-CS-${RUN}`,
        status: "SENT",
        subtotal: 300,
        taxAmount: 0,
        discount: 0,
        total: 300,
      },
    });
    const t0 = new Date(Date.now() - 3_600_000);
    const t1 = new Date(Date.now() - 1_800_000);
    const lines: Record<string, { orderItemId: string; invoiceItemId: string }> = {};
    for (const [position, n] of ["CS1", "CS2", "CS3", "CS4"].entries()) {
      const shape = { qty: 10, unitPrice: 10, subtotal: 100, boxes: 10, pieces: 0, unitsPerBox: 1 };
      const orderItem = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          position,
          ...shape,
        } as any,
      });
      const invoiceItem = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: orderItem.id,
          productId: product.id,
          description: "P",
          trackedCategoryId: category.id,
          categoryTaxAmount: 10,
          ...shape,
        } as any,
      });
      lines[n] = { orderItemId: orderItem.id, invoiceItemId: invoiceItem.id };
    }
    const row = (
      n: string,
      entryType: "SALE" | "REVERSAL",
      v: {
        qty: number;
        net: number;
        tax: number;
        at: Date;
        creditNoteId?: string;
        returnId?: string;
      },
    ) =>
      prisma.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: category.id,
          entryType,
          orderId: order.id,
          orderItemId: lines[n].orderItemId,
          invoiceId: invoice.id,
          invoiceItemId: lines[n].invoiceItemId,
          creditNoteId: v.creditNoteId ?? null,
          returnId: v.returnId ?? null,
          qty: v.qty,
          unitBasisQty: v.qty,
          netSales: v.net,
          categoryTax: v.tax,
          soldAt: v.at,
          periodBucket: "2026-10",
          createdAt: v.at,
        },
      });
    const note = async (n: string, tax: number, qty: number) => {
      const cn = await prisma.creditNote.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceId: invoice.id,
          creditNoteNumber: `CN-CS-${RUN}-${n}`,
          amount: 50,
          status: "ISSUED",
        },
      });
      noteIds[n] = cn.id;
      await prisma.creditNoteItem.create({
        data: {
          tenantId,
          creditNoteId: cn.id,
          invoiceItemId: lines[n].invoiceItemId,
          trackedCategoryId: category.id,
          amount: 50,
          qty,
          categoryTax: tax,
        },
      });
      return cn.id;
    };
    // CS-1 (S1): the return closes the line; the typed credit stores 5.00 and booked nothing
    await row("CS1", "SALE", { qty: 10, net: 100, tax: 10, at: t0 });
    await row("CS1", "REVERSAL", {
      qty: -10,
      net: -100,
      tax: -10,
      at: t1,
      returnId: randomUUID(),
    });
    await note("CS1", 5, 5);
    // CS-2: a 2-pc return, then a typed credit that closes: it stores 10.00 and the ledger books the 8.00 left
    await row("CS2", "SALE", { qty: 10, net: 100, tax: 10, at: t0 });
    await row("CS2", "REVERSAL", { qty: -2, net: -20, tax: -2, at: t1, returnId: randomUUID() });
    await row("CS2", "REVERSAL", {
      qty: -8,
      net: -80,
      tax: -8,
      at: new Date(t1.getTime() + 1000),
      creditNoteId: await note("CS2", 10, 10),
    });
    // CS-3: a SALE offset in place by a re-sync reversal (no returnId / creditNoteId): dead, out
    await row("CS3", "SALE", { qty: 10, net: 100, tax: 10, at: t0 });
    await row("CS3", "REVERSAL", { qty: -10, net: -100, tax: -10, at: t1 });
    await note("CS3", 4, 5);
    // CS-4: no return; a typed credit closes the line alone (the reversal books it all) and stores what the ledger booked
    await row("CS4", "SALE", { qty: 10, net: 100, tax: 10, at: t0 });
    await row("CS4", "REVERSAL", {
      qty: -10,
      net: -100,
      tax: -10,
      at: t1,
      creditNoteId: await note("CS4", 10, 10),
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    const where = { where: { tenantId } };
    await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
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
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma?.$disconnect();
  });

  it("CS-1, CS-2 are live and flagged (stored against booked); CS-3 (a re-sync offset) stays out; CS-4 (a credit alone closing) is live, not flagged", async () => {
    const census = await censusOldTypedCredits(prisma, { tenantId });
    expect(census).toMatchObject({
      typedItems: 4,
      notes: 4,
      itemsWithLiveSale: 3,
      itemsWithoutLiveSale: 1,
      notesBookedLessTaxThanStored: 2,
    });
    expect(census.sample).toEqual(
      expect.arrayContaining([
        { creditNoteId: noteIds.CS1, storedTax: 5, bookedTax: 0 },
        { creditNoteId: noteIds.CS2, storedTax: 10, bookedTax: 8 },
      ]),
    );
    expect(census.sample.map((s) => s.creditNoteId)).not.toContain(noteIds.CS3);
    expect(census.sample.map((s) => s.creditNoteId)).not.toContain(noteIds.CS4); // live and equal: counted, not listed
  });
});
