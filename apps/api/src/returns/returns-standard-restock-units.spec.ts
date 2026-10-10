/**
 * B665 — a STANDARD return stores the qty the operator typed in the order line's OWN unit (boxes for a
 * box-unaware boxed line: every creator is capped by the raw line qty), but stock is counted in PIECES, so
 * receive() used to restock 3 boxes as +3 pieces (12x too few for a 12-pack). The fix converts through the
 * shared pack resolver (`legacyLinePieces`: own split, else the line's linked InvoiceItem when it carries a
 * split — no sibling guess; NEVER the live product's unitsPerBox), parks a restock whose pack is unknown, and makes cancel() undo exactly
 * the RET-<id> movements receive() booked. INLINE captures store true pieces and are untouched.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ReturnsService } from "./returns.service";
import { restockReturnItems } from "./returns-restock.util";
import { standardRestockResolver } from "./returns-restock-pieces";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

/** A box-unaware boxed line: a standing-order line of 6 BOXES of a 12-pack (no split, no snapshot). */
const boxLine = (over: Record<string, unknown> = {}) => ({
  id: "oi-1",
  productId: "p1",
  qty: 6,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  product: { unitsPerBox: 12 }, // the LIVE pack: only a trigger, never a factor
  ...over,
});
/** The InvoiceItem billed from that line, WITH a split: 6 boxes = 72 pieces. */
const invoiceWithSplit = (over: Record<string, unknown> = {}) => ({
  orderItemId: "oi-1",
  qty: 72,
  boxes: 6,
  pieces: 0,
  unitsPerBox: 12,
  ...over,
});

describe("standardRestockResolver (B665)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  const resolver = () => standardRestockResolver(prisma, "ord-1");
  const item = (qty: number, productId = "p1") => ({ id: "ri-1", productId, qty, restock: true });
  const arm = (lines: unknown[], invoiceItems: unknown[] = []) => {
    prisma.orderItem.findMany.mockReset();
    prisma.orderItem.findMany.mockResolvedValueOnce(lines);
    prisma.invoiceItem.findMany.mockReset();
    prisma.invoiceItem.findMany.mockResolvedValue(invoiceItems);
  };

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it("MONEY-SHAPE: 3 boxes typed on a box-unaware 12-pack line restock 36 PIECES, via the InvoiceItem's split", async () => {
    arm([boxLine()], [invoiceWithSplit()]);
    expect(await resolver()(item(3))).toEqual({ pieces: 36 });
  });

  it("does NOT fall back: an InvoiceItem with no split is UNKNOWN (parks)", async () => {
    arm(
      [boxLine()],
      [{ orderItemId: "oi-1", qty: 6, boxes: null, pieces: null, unitsPerBox: null }],
    );
    expect(await resolver()(item(3))).toMatchObject({ unknown: true });
  });

  it("a box-AWARE line and a product with no pack restock the typed qty as today (factor 1)", async () => {
    arm([boxLine({ qty: 72, boxes: 6, unitsPerBox: 12 })]);
    expect(await resolver()(item(12))).toEqual({ pieces: 12 });
    arm([boxLine({ qty: 10, product: { unitsPerBox: null } })]);
    expect(await resolver()(item(4))).toEqual({ pieces: 4 });
  });

  it("an UNKNOWN pack (no InvoiceItem split) is unknown even though the live product says 12", async () => {
    arm([boxLine()]);
    expect(await resolver()(item(3))).toMatchObject({ unknown: true });
  });

  it("a no-split line WITH a pack snapshot (the B644/B656 shape) counts pieces: never x12", async () => {
    arm([boxLine({ qty: 72, unitsPerBox: 12 })], [invoiceWithSplit()]);
    expect(await resolver()(item(12))).toEqual({ pieces: 12 });
  });

  it("a line billed across TWO invoice items is UNKNOWN: none of them is a 1:1 source, so it parks", async () => {
    // relation "full" unlocks the box-count inference (qty === source.boxes). That is only sound for a
    // single WHOLE billing; against a partial, a coincidental match is a known false positive.
    arm([boxLine()], [invoiceWithSplit(), invoiceWithSplit({ qty: 36, boxes: 3 })]);
    expect(await resolver()(item(3))).toMatchObject({ unknown: true });
  });

  it("the two-invoice-item answer does NOT depend on the row order the query happens to return", async () => {
    // The COUNT decides, so both orderings give the same result. Before this, the last row won and the
    // same data could restock differently from run to run.
    arm([boxLine()], [invoiceWithSplit(), invoiceWithSplit({ qty: 36, boxes: 3 })]);
    const first = await resolver()(item(3));
    arm([boxLine()], [invoiceWithSplit({ qty: 36, boxes: 3 }), invoiceWithSplit()]);
    const second = await resolver()(item(3));
    expect(first).toEqual(second);
    expect(first).toMatchObject({ unknown: true });
  });

  it("excludes VOID invoices from the pack source: a cancelled billing is not evidence of how the line sold", async () => {
    arm([boxLine()], [invoiceWithSplit()]);
    await resolver()(item(3));
    expect(prisma.invoiceItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ invoice: { status: { not: "VOID" } } }),
      }),
    );
  });

  it("refuses a FRACTIONAL pack: an internally inconsistent source never books a fractional movement", async () => {
    // qty 75 over 6 boxes is 12.5 pieces per box — the source row cannot be right, so restocking 3 boxes
    // would book 37.5 pieces. Refuse and park instead of writing a fraction into stock.
    arm([boxLine()], [invoiceWithSplit({ qty: 75 })]);
    expect(await resolver()(item(3))).toMatchObject({ unknown: true });
  });

  it("a zero-qty ambiguous line is UNKNOWN, not a silent factor 1 that outvotes a real sibling line", async () => {
    arm([boxLine({ qty: 0 })], [invoiceWithSplit()]);
    expect(await resolver()(item(3))).toMatchObject({ unknown: true });
  });

  it("a product with NO live order line PARKS instead of silently restocking the typed qty as pieces", async () => {
    // The line was cancelled or replaced after the return was created (updateOrderItems recreates lines
    // under fresh ids; cancelling one marks it CANCELLED and zeroes it), so the order has no live line for
    // this product. Without a guard the empty factor set fell through to the factor-1 default and booked 3
    // boxes as 3 PIECES — the B665 defect itself, un-parked and unlogged.
    arm([], [invoiceWithSplit()]);
    expect(await resolver()(item(3))).toMatchObject({ unknown: true });

    // Also when the order has live lines, but none of them is this product.
    arm([boxLine({ productId: "p2" })], [invoiceWithSplit()]);
    expect(await resolver()(item(3, "p1"))).toMatchObject({ unknown: true });
  });

  it("a product on lines with DIFFERENT packs (one box-aware, one box-unaware) is unknown: it parks, no guess", async () => {
    arm(
      [boxLine(), boxLine({ id: "oi-2", qty: 72, boxes: 6, unitsPerBox: 12 })],
      [invoiceWithSplit()],
    );
    expect(await resolver()(item(3))).toMatchObject({
      unknown: true,
      reason: expect.stringMatching(/different packs/),
    });
  });

  it("two box-unaware lines of the same pack agree on one factor", async () => {
    arm(
      [boxLine(), boxLine({ id: "oi-2" })],
      [invoiceWithSplit(), invoiceWithSplit({ orderItemId: "oi-2" })],
    );
    expect(await resolver()(item(2))).toEqual({ pieces: 24 });
  });

  it("loads the order once for many items", async () => {
    arm(
      [boxLine(), boxLine({ id: "oi-9", productId: "p9", product: { unitsPerBox: null } })],
      [invoiceWithSplit()],
    );
    const r = resolver();
    await r(item(1));
    await r(item(2, "p9"));
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1); // the order's lines, loaded once (the split on the InvoiceItem needs no sibling query)
  });
});

/**
 * A4-F3 (units_v1) — a unit-aware line (non-blank `unitLabel`) already stores its qty in BASE PIECES
 * (`unit-line-build.ts`: a factor-1 unit keeps boxes/pieces null and snapshots unitsPerBox 1; a factor > 1
 * unit stores a boxes/pieces split), which is exactly `regulatedUnitBasis`'s branch 1. The restock resolver
 * must read the label and take factor 1 for it, never park it on the live product's pack.
 */
describe("standardRestockResolver — unit-aware lines (A4-F3)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  const resolver = () => standardRestockResolver(prisma, "ord-1");
  const item = (qty: number, productId = "p1") => ({ id: "ri-1", productId, qty, restock: true });
  const arm = (lines: unknown[], invoiceItems: unknown[] = []) => {
    prisma.orderItem.findMany.mockReset();
    prisma.orderItem.findMany.mockResolvedValueOnce(lines);
    prisma.invoiceItem.findMany.mockReset();
    prisma.invoiceItem.findMany.mockResolvedValue(invoiceItems);
  };
  /** 10 loose Pieces of a product whose pack is 12: factor-1 unit, no split, snapshot 1. */
  const pieceLine = (over: Record<string, unknown> = {}) =>
    boxLine({ qty: 10, unitsPerBox: 1, unitLabel: "Piece", ...over });
  /** Its invoice copy: also no split, snapshot 1 (invoice-unit-line.ts). */
  const pieceInvoice = { orderItemId: "oi-1", qty: 10, boxes: null, pieces: null, unitsPerBox: 1 };

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it("REG-A4F3-1: 4 returned from a factor-1 Piece line on a 12-pack product restocks 4 pieces, never parks", async () => {
    arm([pieceLine()], [pieceInvoice]);
    expect(await resolver()(item(4))).toEqual({ pieces: 4 });
  });

  it("REG-A4F3-2: the restock loader reads the line's unitLabel", async () => {
    arm([pieceLine()], [pieceInvoice]);
    await resolver()(item(4));
    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ unitLabel: true }) }),
    );
  });

  it("a Case line (factor 144, stored as a split) is unchanged: factor 1 on its base-piece qty", async () => {
    arm([pieceLine({ qty: 432, boxes: 3, pieces: 0, unitsPerBox: 144, unitLabel: "Case" })]);
    expect(await resolver()(item(144))).toEqual({ pieces: 144 });
  });

  it("a blank or whitespace unitLabel means the pack: the box-unaware line still resolves x12 via its InvoiceItem", async () => {
    for (const unitLabel of ["", "   ", null]) {
      arm([boxLine({ unitLabel })], [invoiceWithSplit()]);
      expect(await resolver()(item(3))).toEqual({ pieces: 36 });
    }
  });

  it("a STALE label on a box-count line (moved back to the pack, label left behind) is not trusted: it resolves via its InvoiceItem or parks", async () => {
    const stale = pieceLine({ qty: 3, unitsPerBox: null }); // label "Piece", no split, no snapshot
    arm([stale], [invoiceWithSplit({ qty: 36, boxes: 3 })]);
    expect(await resolver()(item(3))).toEqual({ pieces: 36 });
    arm([stale], []);
    expect(await resolver()(item(3))).toMatchObject({ unknown: true });
  });

  it("a product sold as loose Pieces AND as box-unaware boxes on one order still parks: two packs, no guess", async () => {
    arm(
      [pieceLine({ id: "oi-2" }), boxLine()],
      [{ ...pieceInvoice, orderItemId: "oi-2" }, invoiceWithSplit()],
    );
    expect(await resolver()(item(2))).toEqual({
      unknown: true,
      reason: "the product is on order lines with different packs",
    });
  });
});

describe("restockReturnItems with a resolver (B665)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let errorSpy: jest.SpyInstance;
  const ret = (items: any[]) => ({ id: "ret-12345678-abcd", items });
  const boxItem = { id: "ri-1", productId: "p1", qty: 3, restock: true };

  beforeEach(() => {
    prisma = createMockPrisma();
    prisma.product.findFirst.mockResolvedValue({
      currentStock: new Prisma.Decimal(100),
      averageCost: new Prisma.Decimal(2),
    } as any);
    errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it("books the RESOLVED pieces on the movement, the stock and stockAfter (36, not 3)", async () => {
    await restockReturnItems(prisma as any, ret([boxItem]), "u1", async () => ({ pieces: 36 }));
    const mv = prisma.stockMovement.create.mock.calls[0][0].data;
    expect(Number(mv.quantity)).toBe(36);
    expect(Number(mv.stockAfter)).toBe(136);
    expect(mv.reference).toBe("RET-ret-1234");
    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { currentStock: { increment: expect.anything() } },
    });
    expect(Number(prisma.product.update.mock.calls[0][0].data.currentStock.increment)).toBe(36);
    expect(prisma.returnParkedRestock.createMany).not.toHaveBeenCalled();
  });

  it("an UNKNOWN pack books NO stock movement and PARKS the typed qty (skipDuplicates), with an error log", async () => {
    await restockReturnItems(prisma as any, ret([boxItem]), "u1", async () => ({
      unknown: true,
      reason: "no own split and no same-product source line with a split",
    }));
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    const arg = prisma.returnParkedRestock.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(1);
    expect(arg.data[0]).toMatchObject({
      returnId: "ret-12345678-abcd",
      returnItemId: "ri-1",
      productId: "p1",
      reason: expect.stringMatching(/no own split/),
    });
    expect(Number(arg.data[0].returnedQty)).toBe(3); // as typed, in the line's own unit
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/PARKED/));
  });

  it("only the unknown item parks: a known item in the same return still restocks", async () => {
    const known = { id: "ri-2", productId: "p2", qty: 5, restock: true };
    await restockReturnItems(prisma as any, ret([boxItem, known]), "u1", async (i) =>
      i.productId === "p1" ? { unknown: true, reason: "x" } : { pieces: 5 },
    );
    expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(prisma.returnParkedRestock.createMany).toHaveBeenCalledTimes(1);
  });

  it("WITHOUT a resolver (INLINE captures, true pieces) it restocks the raw qty exactly as before", async () => {
    await restockReturnItems(prisma as any, ret([{ ...boxItem, qty: 12 }]), "u1");
    expect(Number(prisma.stockMovement.create.mock.calls[0][0].data.quantity)).toBe(12);
    expect(prisma.returnParkedRestock.createMany).not.toHaveBeenCalled();
  });

  it("a restock:false item is skipped before it is ever resolved", async () => {
    const resolve = jest.fn();
    await restockReturnItems(prisma as any, ret([{ ...boxItem, restock: false }]), "u1", resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

describe("ReturnsService receive() and cancel() (B665)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() },
        },
        { provide: CreditNotesService, useValue: { create: jest.fn() } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
  });

  it("receive() restocks a STANDARD return's box-unaware line in PIECES (3 boxes -> +36)", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-12345678",
      status: "APPROVED",
      kind: "STANDARD",
      orderId: "ord-1",
      items: [{ id: "ri-1", productId: "p1", qty: 3, restock: true }],
    });
    prisma.orderItem.findMany.mockReset();
    prisma.orderItem.findMany.mockResolvedValueOnce([boxLine()]).mockResolvedValueOnce([]);
    prisma.invoiceItem.findMany.mockResolvedValue([invoiceWithSplit()]);
    prisma.product.findFirst.mockResolvedValue({
      currentStock: new Prisma.Decimal(0),
      averageCost: new Prisma.Decimal(2),
    } as any);
    await service.receive("ret-12345678", "u1");
    expect(Number(prisma.stockMovement.create.mock.calls[0][0].data.quantity)).toBe(36);
  });

  it("cancel() undoes EXACTLY the movements receive() booked (36 pieces), not the typed qty (3), and voids parked rows", async () => {
    const tx = {
      return: {
        findUnique: jest.fn().mockResolvedValue({
          id: "ret-12345678",
          status: "RECEIVED",
          items: [{ id: "ri-1", productId: "p1", qty: 3, restock: true }],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // B562 PR-2: update() returns the written row — the reversing movement reads its counter.
      product: { update: jest.fn().mockResolvedValue({ currentStock: 4, averageCost: 2 }) },
      stockMovement: {
        findMany: jest.fn().mockResolvedValue([{ productId: "p1", quantity: 36 }]),
        deleteMany: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: "mv-rev" }),
      },
      returnParkedRestock: { deleteMany: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-12345678",
      status: "APPROVED",
      customerId: "cust-1",
      items: [{ id: "ri-1", productId: "p1", qty: 3, restock: true }],
    });
    await service.cancel("ret-12345678", { sub: "u1", role: "OPERATOR" } as any);
    expect(tx.stockMovement.findMany).toHaveBeenCalledWith({
      where: { reference: "RET-ret-1234", type: "RETURN" },
      select: { productId: true, quantity: true },
    });
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { currentStock: { decrement: 36 } },
    });
    // B562 PR-2: the 36 pieces are reversed by an APPENDED RETURN row, never a delete.
    expect(tx.stockMovement.deleteMany).not.toHaveBeenCalled();
    const rev = tx.stockMovement.create.mock.calls[0][0].data;
    expect(rev).toMatchObject({ type: "RETURN", reference: "RET-ret-1234", stockAfter: 4 });
    expect(rev.quantity.toString()).toBe("-36");
    expect(tx.returnParkedRestock.deleteMany).toHaveBeenCalledWith({
      where: { returnId: "ret-12345678", resolvedAt: null },
    });
  });

  it("cancel() of a return whose restock was PARKED (no movement) decrements nothing", async () => {
    const tx = {
      return: {
        findUnique: jest.fn().mockResolvedValue({
          id: "ret-12345678",
          status: "RECEIVED",
          items: [{ id: "ri-1", productId: "p1", qty: 3, restock: true }],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      product: { update: jest.fn() },
      stockMovement: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
      returnParkedRestock: { deleteMany: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-12345678",
      status: "APPROVED",
      customerId: "cust-1",
      items: [{ id: "ri-1", productId: "p1", qty: 3, restock: true }],
    });
    await service.cancel("ret-12345678", { sub: "u1", role: "OPERATOR" } as any);
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.returnParkedRestock.deleteMany).toHaveBeenCalledTimes(1);
  });
});
