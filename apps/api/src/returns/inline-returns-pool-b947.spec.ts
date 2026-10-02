import { ConflictException } from "@nestjs/common";
import { InlineReturnsService } from "./inline-returns.service";
import * as headroom from "../credit-notes/line-credit-headroom";

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

const Z = { id: "inv-a-first", items: [row("z-a", "pa")] }; // sorts BEFORE inv-x; on ANOTHER order with ONE creditable invoice
const W = { id: "inv-0-w", items: [row("w-b", "pb")] }; // the LOWEST id, on ord-1 (3 creditable invoices: W, X, Y)
let orderOf = (id: string): string => (id === "inv-a-first" ? "ord-2" : "ord-1");

function setup(opts: {
  lumpOfA: boolean;
  lump?: { productId: string; qty: number };
  invoices?: Array<{ id: string; items: any[] }>;
  takes?: Array<{ sourceInvoiceItemId: string; pieces: number; subtotal: number }>;
}) {
  const invoices = opts.invoices ?? [X, Y];
  const inOrder = (orderId: string) => invoices.filter((i) => orderOf(i.id) === orderId);
  const lineInvoice = (lineId: string) =>
    invoices.find((i) => i.items.some((it: any) => it.id === lineId))!.id;
  const takes = opts.takes ?? [{ sourceInvoiceItemId: "x-a", pieces: 1, subtotal: 100 }];
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    invoiceItem: {
      findMany: jest.fn(async (args: any) =>
        args.where?.id
          ? takes.map((t) => ({
              id: t.sourceInvoiceItemId,
              invoiceId: lineInvoice(t.sourceInvoiceItemId),
            }))
          : (invoices.find((i) => i.id === args.where.invoiceId)?.items ?? []),
      ),
    },
    invoice: {
      // (kept so the pre-fix implementation, which read the order of invoiceIds[0] here, can be run against these cases)
      findFirst: jest.fn(async (args: any) => ({ orderId: orderOf(args.where.id) })),
      count: jest.fn(async (args: any) => inOrder(args.where.orderId).length),
      // the pool read (by orderId) and the invoice -> order read (by id list) are told apart by their `where`
      findMany: jest.fn(async (args: any) =>
        args.where?.id
          ? invoices
              .filter((i) => args.where.id.in.includes(i.id))
              .map((i) => ({ id: i.id, orderId: orderOf(i.id) }))
          : inOrder(args.where.orderId),
      ),
    },
    creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
    returnItem: { findMany: jest.fn().mockResolvedValue([]) },
    creditNote: {
      // the per-invoice legacy term (by one invoiceId) sees nothing; only the ORDER POOL read (by `OR`) finds the lump on Y
      findMany: jest.fn(async (args: any) =>
        args.where.invoiceId !== undefined || !opts.lumpOfA ? [] : [{ id: "cn-lump" }],
      ),
    },
    return: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { items: [{ productId: opts.lump?.productId ?? "pa", qty: opts.lump?.qty ?? 1 }] },
        ]),
    },
  };
  const svc: any = Object.create(InlineReturnsService.prototype);
  svc.prisma = { getTenantId: () => "t-1" };
  const run = () => svc.assertWithinLineHeadroom(tx, takes);
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

  it("SA-628h pin: the inline path CONSULTS the order pool (loadOrderPool is called with the SOURCE invoice's order, on the tx) when the order has 2+ creditable invoices, and never otherwise", async () => {
    const spy = jest.spyOn(headroom, "loadOrderPool");
    const a = setup({ lumpOfA: false });
    await a.run();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(a.tx);
    expect(spy.mock.calls[0][1]).toBe("ord-1");
    // the order comes from the SOURCE line's invoice (an id-list read), never from the carrying order
    expect(a.tx.invoice.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["inv-x"] } },
      select: { id: true, orderId: true },
    });
    spy.mockClear();
    const b = setup({ lumpOfA: false, invoices: [X] });
    await b.run();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("OPUS: the pool is per SOURCE ORDER, never the order of the lowest invoice id: takes spilled over two orders consult each order's own pool", async () => {
    const spy = jest.spyOn(headroom, "loadOrderPool");
    // one product A taken from x-a (order ord-1: 2 creditable invoices, A already refunded there) AND from z-a (order ord-2, whose
    // single invoice has the LOWEST id): the old code checked only invoiceIds[0]'s order (ord-2, one invoice: NO pool check at all)
    const { run } = setup({
      lumpOfA: true,
      invoices: [Z, X, Y],
      takes: [
        { sourceInvoiceItemId: "z-a", pieces: 1, subtotal: 100 },
        { sourceInvoiceItemId: "x-a", pieces: 1, subtotal: 100 },
      ],
    });
    await expect(run()).rejects.toMatchObject({
      response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM", productId: "pa" },
    });
    // ord-1's pool was consulted; ord-2 (one creditable invoice) never pays for one
    expect(spy.mock.calls.map((c) => c[1])).toEqual(["ord-1"]);
    spy.mockRestore();
  });

  it("OPUS N1 (fails on the old code): a take on ord-2's own line is not judged by ord-1's pool, even when the LOWEST source invoice id sits on ord-1 (no false 409)", async () => {
    // A is fully refunded on ord-1 (lump on Y). The takes: A from ord-2's single invoice (own line: fits) and B from ord-1's W.
    // The OLD code summed takes by product and checked them against the pool of invoiceIds[0] = inv-0-w (ord-1): A's $100 against
    // ord-1's exhausted A pool = a FALSE 409. Per source order: A is judged on ord-2 (one invoice, no pool), B on ord-1 (room).
    const { run } = setup({
      lumpOfA: true,
      invoices: [W, Z, X, Y],
      takes: [
        { sourceInvoiceItemId: "z-a", pieces: 1, subtotal: 100 },
        { sourceInvoiceItemId: "w-b", pieces: 1, subtotal: 100 },
      ],
    });
    await expect(run()).resolves.toBeUndefined();
  });

  it("OPUS r4 N1: with pieces-per-qty > 1 the take reaches the pool IN PIECES (removing the conversion in the take OR in the room turns this red)", async () => {
    // Product pm: a 2-BOX line (x12 = 24 pieces) on X and a 12-PIECE line on Y. An itemless refund lump of pm (on Y) is
    // attributed over the combined lines by the legacy term: it fills the box line and 10 pieces of Y's line, leaving 2 pieces in
    // the pool. The take (1 box = 12 pieces, sourced to X's box line) FITS per-invoice (X cannot see the lump on Y) but not the
    // pool. Dividing the take by its line's pieces-per-qty (the pre-N2 shape) would compare 1 to 2 and pass.
    const mBox = { ...row("m-box", "pm"), subtotal: 240, qty: 2, unitsPerBox: 12 };
    const mPcs = { ...row("m-pcs", "pm"), subtotal: 60, qty: 12 };
    const MX = { id: "inv-mx", items: [mBox] };
    const MY = { id: "inv-my", items: [mPcs] };
    const { run } = setup({
      lumpOfA: true,
      lump: { productId: "pm", qty: 12 },
      invoices: [MX, MY],
      takes: [{ sourceInvoiceItemId: "m-box", pieces: 12, subtotal: 5 }],
    });
    const err = await run().catch((e: any) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "RETURN_REFUND_OVER_LINE_HEADROOM",
      productId: "pm",
      qtyUnit: "pieces",
      requestedQty: 12,
    });
    expect(err.getResponse().remainingQty).toBeLessThan(12);
  });

  it("the same inline return with nothing credited passes", async () => {
    const { run } = setup({ lumpOfA: false });
    await expect(run()).resolves.toBeUndefined();
  });

  it("a single creditable invoice never reads the pool (the per-invoice check is all there is)", async () => {
    const { run, tx } = setup({ lumpOfA: true, invoices: [X] });
    await expect(run()).resolves.toBeUndefined();
    expect(tx.invoice.findMany.mock.calls.every((c: any[]) => c[0].where?.id)).toBe(true); // only the id -> order read, no pool
  });
});
