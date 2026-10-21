import { BadRequestException, Logger } from "@nestjs/common";
import { checkQtySplitConsistency, qtySplitMismatch, warnQtySplit } from "./qty-split-consistency";

/**
 * Row 531 F2. The one rule, two modes: BUYER paths enforce (coded 400, nothing saved), staff /
 * shared paths and counter sale only warn (a log naming the path, tenant and product; behaviour
 * unchanged).
 */
const UPB = 12;

describe("qtySplitMismatch: the rule", () => {
  it.each([
    // [qty, boxes, pieces, mismatch?]
    [12, 1, 0, false],
    [24, 2, 0, false],
    [25, 2, 1, false],
    [14, 0, 14, false], // pieces >= pack still adds up; the writer rolls it over
    [2, 1, 0, true], // the P0 shape
    [30, 1, 0, true], // the drifted stepper shape
    [12, 2, 0, true],
    [2, 0, 2, false],
    [12, 0, 1, true],
  ])("qty %i / boxes %i / pieces %i -> mismatch %s", (qty, boxes, pieces, bad) => {
    const m = qtySplitMismatch({ productId: "p1", qty, boxes, pieces }, UPB);
    expect(m !== null).toBe(bad);
    if (m) expect(m).toEqual({ productId: "p1", qty, boxes, pieces, unitsPerBox: UPB });
  });

  it("is silent when the product is not boxed, when no split is sent, or when no qty is sent", () => {
    expect(qtySplitMismatch({ qty: 2, boxes: 1, pieces: 0 }, null)).toBeNull();
    expect(qtySplitMismatch({ qty: 2, boxes: 1, pieces: 0 }, 1)).toBeNull();
    expect(qtySplitMismatch({ qty: 2 }, UPB)).toBeNull();
    expect(qtySplitMismatch({ qty: 2, boxes: 0, pieces: 0 }, UPB)).toBeNull(); // "not using box entry"
    expect(qtySplitMismatch({ qty: 2, boxes: null, pieces: null }, UPB)).toBeNull();
    expect(qtySplitMismatch({ boxes: 1, pieces: 0 }, UPB)).toBeNull();
    expect(qtySplitMismatch({ qty: null, boxes: 1 }, UPB)).toBeNull();
    expect(qtySplitMismatch({ qty: "abc", boxes: 1 }, UPB)).toBeNull();
  });

  it("reads a Decimal-string qty", () => {
    expect(qtySplitMismatch({ qty: "24", boxes: 2, pieces: 0 }, UPB)).toBeNull();
    expect(qtySplitMismatch({ qty: "2", boxes: 1, pieces: 0 }, UPB)).not.toBeNull();
  });
});

describe("checkQtySplitConsistency: enforce", () => {
  const items = [
    { productId: "ok", qty: 24, boxes: 2, pieces: 0 },
    { productId: "bad-1", qty: 2, boxes: 1, pieces: 0 },
    { productId: "bad-2", qty: 5, boxes: 1, pieces: 1 },
  ];

  it("throws a coded 400 QTY_SPLIT_MISMATCH naming every disagreeing product", () => {
    let thrown: unknown;
    try {
      checkQtySplitConsistency({
        mode: "enforce",
        path: "buyer.createOrder",
        items,
        upbFor: () => UPB,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const res = (thrown as BadRequestException).getResponse() as Record<string, unknown>;
    expect((thrown as BadRequestException).getStatus()).toBe(400);
    expect(res.code).toBe("QTY_SPLIT_MISMATCH");
    expect(res.productIds).toEqual(["bad-1", "bad-2"]);
  });

  it("passes a clean payload through and returns nothing", () => {
    expect(
      checkQtySplitConsistency({
        mode: "enforce",
        path: "buyer.createOrder",
        items: [items[0]],
        upbFor: () => UPB,
      }),
    ).toEqual([]);
  });

  it("looks up each line's own pack size", () => {
    const packs: Record<string, number> = { a: 12, b: 6 };
    const out = checkQtySplitConsistency({
      mode: "warn",
      path: "t",
      items: [
        { productId: "a", qty: 12, boxes: 1, pieces: 0 },
        { productId: "b", qty: 12, boxes: 1, pieces: 0 }, // a 6-pack: 1 box is 6, not 12
      ],
      upbFor: (l) => packs[l.productId as string],
      logger: { warn: jest.fn() } as unknown as Logger,
    });
    expect(out.map((m) => m.productId)).toEqual(["b"]);
  });
});

describe("checkQtySplitConsistency: warn", () => {
  const logger = { warn: jest.fn() } as unknown as Logger;
  beforeEach(() => (logger.warn as jest.Mock).mockReset());

  it("never throws; logs the path, tenant and product once per mismatching line", () => {
    const out = checkQtySplitConsistency({
      mode: "warn",
      path: "orders.update",
      tenantId: "t-123",
      items: [
        { productId: "p9", qty: 2, boxes: 1, pieces: 0 },
        { productId: "p8", qty: 24, boxes: 2, pieces: 0 },
      ],
      upbFor: () => UPB,
      logger,
    });
    expect(out).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = (logger.warn as jest.Mock).mock.calls[0][0] as string;
    expect(msg).toContain("path=orders.update");
    expect(msg).toContain("tenantId=t-123");
    expect(msg).toContain("productId=p9");
  });

  it("stays silent for a consistent line", () => {
    warnQtySplit(
      logger,
      "t-1",
      "orders.create",
      { productId: "p", qty: 12, boxes: 1, pieces: 0 },
      12,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warnQtySplit is the one-line form of the same check", () => {
    warnQtySplit(
      logger,
      "t-1",
      "counter.sale",
      { productId: "p", qty: 2, boxes: 1, pieces: 0 },
      12,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toContain("path=counter.sale");
  });
});
