/**
 * B948 / SA-628a (c): InlineReturnsService.captureInTx refuses (409 RETURN_REFUND_OVER_LINE_HEADROOM, never clips) a capture whose
 * chunks would credit a source invoice line past its remaining headroom (credit-note items + the legacy term + earlier inline
 * returns), under an id-sorted tenant-scoped Invoice FOR UPDATE taken after the Order lock. The real-PG proof (both orders) is
 * credit-notes/credit-return-line-cap.db.spec.ts.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { InlineReturnsService } from "./inline-returns.service";

const A = { id: "a", productId: "pa", subtotal: 100, qty: 1, boxes: null, unitsPerBox: null };
const run = (chunks: any[], over: { cn?: any[]; inline?: any[]; items?: any[] } = {}) => {
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    invoiceItem: {
      findMany: jest
        .fn()
        .mockImplementation((args: any) =>
          args.where.id
            ? Promise.resolve((over.items ?? [A]).map((i) => ({ id: i.id, invoiceId: "inv-1" })))
            : Promise.resolve(over.items ?? [A]),
        ),
    },
    // B947: the order pool probe (a lone creditable invoice: no pool)
    invoice: {
      findMany: jest.fn().mockResolvedValue([]), // the source invoices' orders: none, so no pool
      count: jest.fn().mockResolvedValue(1),
    },
    creditNoteItem: { findMany: jest.fn().mockResolvedValue(over.cn ?? []) },
    creditNote: { findMany: jest.fn().mockResolvedValue([]) },
    return: { findMany: jest.fn().mockResolvedValue([]) },
    returnItem: { findMany: jest.fn().mockResolvedValue(over.inline ?? []) },
  };
  const svc: any = Object.assign(Object.create(InlineReturnsService.prototype), {
    prisma: { getTenantId: () => "t1" },
  });
  return { tx, p: svc.assertWithinLineHeadroom(tx, chunks) as Promise<void> };
};
const chunk = (id: string | null, pieces: number, subtotal: number) => ({
  sourceInvoiceItemId: id,
  pieces,
  subtotal,
});

describe("InlineReturnsService.assertWithinLineHeadroom (B948)", () => {
  it("RED REPRO: a $60 credit-note item on line A, then an inline return of the whole $100 line => 409 with {productId, requested, remaining}", async () => {
    const { p } = run([chunk("a", 1, 100)], { cn: [{ invoiceItemId: "a", amount: 60, qty: 0.6 }] });
    await expect(p).rejects.toMatchObject({
      response: {
        code: "RETURN_REFUND_OVER_LINE_HEADROOM",
        productId: "pa",
        requested: 100,
        remaining: 40,
      },
    });
  });
  it("an earlier INLINE return of the line counts too (two inline returns of the whole line: the second is refused)", async () => {
    const { p } = run([chunk("a", 1, 100)], {
      inline: [{ sourceInvoiceItemId: "a", qty: 1, subtotal: 100 }],
    });
    await expect(p).rejects.toMatchObject({
      response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
    });
  });
  it("a take that fits the remaining headroom passes", async () => {
    const { p } = run([chunk("a", 0.4, 40)], {
      cn: [{ invoiceItemId: "a", amount: 60, qty: 0.6 }],
    });
    await expect(p).resolves.toBeUndefined();
  });
  it("a selling-unit line with a NULL pack snapshot resolves its pack like the pricing (product pack 12): 5 pieces of a 2-case line fit", async () => {
    const legacy = {
      id: "lg",
      productId: "pl",
      subtotal: 240,
      qty: 2,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      product: { unitsPerBox: 12 },
    };
    const { p } = run([chunk("lg", 5, 50)], { items: [legacy] });
    await expect(p).resolves.toBeUndefined();
  });
  it("a boxed line counts on its own axis: 12 pieces of a 2-box x 12 line is 1 box, not 12", async () => {
    const boxed = {
      id: "bx",
      productId: "pb",
      subtotal: 120,
      qty: 2,
      boxes: null,
      unitsPerBox: 12,
    };
    const { p } = run([chunk("bx", 12, 60)], { items: [boxed] });
    await expect(p).resolves.toBeUndefined();
  });
  it("chunks with no source line (unreferenced pricing) carry nothing to cap and take no lock", async () => {
    const { tx, p } = run([chunk(null, 5, 50)]);
    await expect(p).resolves.toBeUndefined();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it("WRITES (locks + new row version) the source Invoice row(s), tenant-scoped, BEFORE reading the credits", async () => {
    const { tx, p } = run([chunk("a", 0.4, 40)]);
    await p;
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(String(tx.$executeRaw.mock.calls[0][0].join("?"))).toMatch(
      /UPDATE "Invoice".*"tenantId"/s,
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.creditNoteItem.findMany.mock.invocationCallOrder[0],
    );
  });
  it("source pin: captureInTx calls it right after pricing and before the driver-cap read", () => {
    const src = readFileSync(join(__dirname, "inline-returns.service.ts"), "utf8");
    const at = src.indexOf("await this.assertWithinLineHeadroom(tx, priced.chunks)");
    expect(at).toBeGreaterThan(src.indexOf("priceInlineReturn("));
    expect(at).toBeLessThan(src.indexOf("sumInlineReturnCredit(tx, dto.orderId)"));
  });

  it("B215 class: the READ-ONLY variant refuses the same over-line capture with NO Invoice write or lock", async () => {
    const { tx, p } = run([chunk("a", 1, 100)], {
      cn: [{ invoiceItemId: "a", amount: 60, qty: 0.6 }],
    });
    await p.catch(() => undefined); // the locking variant, already awaited: not under test here
    tx.$executeRaw.mockClear();
    const svc: any = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma: { getTenantId: () => "t1" },
    });
    await expect(
      svc.assertWithinLineHeadroom(tx, [chunk("a", 1, 100)], { readOnly: true }),
    ).rejects.toMatchObject({ response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" } });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it("source pin: preflightCapture runs the read-only headroom check before it returns (so the order edit refuses BEFORE the invoice revert)", () => {
    const src = readFileSync(join(__dirname, "inline-returns.service.ts"), "utf8");
    const pre = src.slice(
      src.indexOf("async preflightCapture("),
      src.indexOf("captureInTx + the credit issue"),
    );
    expect(pre).toMatch(/assertWithinLineHeadroom\(db, priced\.chunks, \{ readOnly: true \}\)/);
    expect(pre.indexOf("assertWithinLineHeadroom")).toBeLessThan(
      pre.indexOf("return priced.total"),
    );
  });
});
