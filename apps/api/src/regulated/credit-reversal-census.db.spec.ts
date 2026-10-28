/**
 * SA-1042 A-4 G5 on REAL Postgres: the old-rows census (`censusOldTypedCredits`) counts only credit items the ledger can reverse.
 * One tenant, one order, four invoice lines, each credited by its own typed note (levy `categoryTax` stored on the item):
 *
 *   N1  a BOUND line: a live SALE (10 pcs / 100.00 / 10.00), the note's REVERSAL booked its full 5.00     -> live, no mismatch
 *   N2  the G-L8 line: regulated on the invoice but no SALE row ever booked (levy 7.00 stored, none booked) -> NOT live, no mismatch
 *   N3  a DEAD SALE: the SALE was offset in place by a re-sync REVERSAL (square key); levy 4.00 stored, none booked
 *                                                                                                         -> NOT live, no mismatch
 *   N4  a BOUND line short-booked: a live SALE, stored 6.00, the REVERSAL booked 2.00                      -> live, ONE mismatch
 *
 * Expected: 4 typed items on 4 notes, itemsWithLiveSale 2 (N1, N4), itemsWithoutLiveSale 2 (N2, N3), one note booked less than
 * stored (N4). Without the live-SALE scope N2 and N3 would also read as mismatches (3); without the dead-SALE rule N3 would.
 * A second tenant's VOID note must not count. Collected only by `jest.db.config.js` (`npm run local:test:db`).
 * SAFETY: a throwaway `qa-census-<run>` tenant approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { censusOldTypedCredits } from "./credit-reversal-census";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-1042 A-4 G5: the old-rows census is scoped to live, non-dead SALE lines", () => {
  let prisma: PrismaService;
  let tenantId = "";
  let tenantIds: string[] = [];
  const noteIds: Record<string, string> = {};

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    const slug = assertTestTenant(`qa-census-${RUN}`, "credit-reversal-census.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `census ${slug}` } })).id;
    tenantIds = [tenantId];
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "c census", contactName: "c census", tenantId },
    });
    const category = await prisma.trackedCategory.create({
      data: { tenantId, name: `Census category ${slug}` },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `P ${slug}`, unit: "each", pricePerUnit: 10, unitsPerBox: 1 } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-CEN-${RUN}`,
        subtotal: 400,
        tax: 0,
        total: 400,
        status: "DELIVERED",
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-CEN-${RUN}`,
        status: "SENT",
        subtotal: 400,
        taxAmount: 0,
        discount: 0,
        total: 400,
      },
    });
    const t0 = new Date(Date.now() - 3_600_000);
    const t1 = new Date(Date.now() - 1_800_000);
    const lines: Record<string, { orderItemId: string; invoiceItemId: string }> = {};
    for (const [position, n] of ["N1", "N2", "N3", "N4"].entries()) {
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
      v: { qty: number; net: number; tax: number; at: Date; creditNoteId?: string },
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
          qty: v.qty,
          unitBasisQty: v.qty,
          netSales: v.net,
          categoryTax: v.tax,
          soldAt: v.at,
          periodBucket: "2026-10",
          createdAt: v.at,
        },
      });
    const note = async (n: string, tax: number) => {
      const cn = await prisma.creditNote.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceId: invoice.id,
          creditNoteNumber: `CN-CEN-${RUN}-${n}`,
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
          qty: 5,
          categoryTax: tax,
        },
      });
      return cn.id;
    };
    // N1 bound, fully booked
    await row("N1", "SALE", { qty: 10, net: 100, tax: 10, at: t0 });
    await row("N1", "REVERSAL", {
      qty: -5,
      net: -50,
      tax: -5,
      at: t1,
      creditNoteId: await note("N1", 5),
    });
    // N2: the G-L8 line, no SALE row at all
    await note("N2", 7);
    // N3: a SALE offset in place by a re-sync reversal (no return / credit note): the key is square, the SALE is dead
    await row("N3", "SALE", { qty: 10, net: 100, tax: 10, at: t0 });
    await row("N3", "REVERSAL", { qty: -10, net: -100, tax: -10, at: t1 });
    await note("N3", 4);
    // N4: bound, short-booked (stored 6.00, booked 2.00)
    await row("N4", "SALE", { qty: 10, net: 100, tax: 10, at: t0 });
    await row("N4", "REVERSAL", {
      qty: -2,
      net: -20,
      tax: -2,
      at: t1,
      creditNoteId: await note("N4", 6),
    });
    // a VOID note on a live line never counts
    const voided = await prisma.creditNote.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceId: invoice.id,
        creditNoteNumber: `CN-CEN-${RUN}-V`,
        amount: 50,
        status: "VOID",
      },
    });
    await prisma.creditNoteItem.create({
      data: {
        tenantId,
        creditNoteId: voided.id,
        invoiceItemId: lines.N1.invoiceItemId,
        trackedCategoryId: category.id,
        amount: 50,
        qty: 5,
        categoryTax: 9,
      },
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    for (const id of tenantIds) {
      const where = { where: { tenantId: id } };
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
      await prisma.tenant.delete({ where: { id } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  it("counts the bound lines as live, leaves the no-SALE (G-L8) and dead-SALE lines out, and flags only the short-booked note", async () => {
    const census = await censusOldTypedCredits(prisma, { tenantId });
    expect(census).toMatchObject({
      typedItems: 4,
      notes: 4,
      itemsWithLiveSale: 2,
      itemsWithoutLiveSale: 2,
      notesBookedLessTaxThanStored: 1,
    });
    expect(census.sample).toEqual([{ creditNoteId: noteIds.N4, storedTax: 6, bookedTax: 2 }]);
  });
});
