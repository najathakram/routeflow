import { ConflictException } from "@nestjs/common";
import { InlineReturnsService } from "./inline-returns.service";

/**
 * B947 third door: an inline return's capture checked only its source line's OWN invoice. A refund lump minted on the LATEST
 * invoice Y (an itemless note, attributed to the product only through its Return) is invisible there, so an inline return of the
 * same product sourced to an OLDER invoice X's line passed. The same takes are now checked against the ORDER POOL when the
 * order has 2+ creditable invoices. Real-Postgres: credit-notes/credit-return-line-cap-multi-invoice.db.spec.ts case 11.
 */
const row = (id: string, productId: string) => ({
  id,
  productId,
  subtotal: 100,
  qty: 1,
  boxes: null,
  unitsPerBox: null,
  pieces: null,
  product: { unitsPerBox: null },
});
const X = { id: "inv-x", items: [row("x-a", "pa"), row("x-b", "pb")] };
const Y = { id: "inv-y", items: [row("y-c", "pc")] };

function setup(opts: { lumpOfA: boolean; invoices?: Array<{ id: string; items: any[] }> }) {
  const invoices = opts.invoices ?? [X, Y];
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    invoiceItem: {
      findMany: jest.fn(async (args: any) =>
        args.where?.id ? [{ id: "x-a", invoiceId: "inv-x" }] : X.items,
      ),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue({ orderId: "ord-1" }),
      count: jest.fn().mockResolvedValue(invoices.length),
      findMany: jest.fn().mockResolvedValue(invoices),
    },
    creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
    returnItem: { findMany: jest.fn().mockResolvedValue([]) },
    creditNote: {
      // the per-invoice legacy term (by invoiceId = X) sees nothing: the lump sits on the LATEST invoice Y
      findMany: jest.fn(async (args: any) =>
        args.where.invoiceId === "inv-x" || !opts.lumpOfA ? [] : [{ id: "cn-lump" }],
      ),
    },
    return: {
      findMany: jest.fn().mockResolvedValue([{ items: [{ productId: "pa", qty: 1 }] }]),
    },
  };
  const svc: any = Object.create(InlineReturnsService.prototype);
  svc.prisma = { getTenantId: () => "t-1" };
  const run = () =>
    svc.assertWithinLineHeadroom(tx, [{ sourceInvoiceItemId: "x-a", pieces: 1, subtotal: 100 }]);
  return { run, tx };
}

describe("InlineReturnsService.assertWithinLineHeadroom: B947 the order pool (third door)", () => {
  it("a refund lump of A on the LATEST invoice, then an inline return of A sourced to the OLDER invoice's line: REFUSED 409", async () => {
    const { run } = setup({ lumpOfA: true });
    const err = await run().catch((e: any) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "RETURN_REFUND_OVER_LINE_HEADROOM",
      productId: "pa",
    });
  });

  it("the same inline return with nothing credited passes", async () => {
    const { run } = setup({ lumpOfA: false });
    await expect(run()).resolves.toBeUndefined();
  });

  it("a single creditable invoice never reads the pool (the per-invoice check is all there is)", async () => {
    const { run, tx } = setup({ lumpOfA: true, invoices: [X] });
    await expect(run()).resolves.toBeUndefined();
    expect(tx.invoice.findMany).not.toHaveBeenCalled();
  });
});
