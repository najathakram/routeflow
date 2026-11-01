import { creditDriftTol } from "../credit-notes/line-credit-headroom";
import { creditRoomRefusal, type CreditRowInput } from "./credit-reversal-room";

/**
 * SA-1054 A-3 (rows CD-2 to CD-8 and CD-12), no database: the room's two reads are a stub over a fixed ledger. 10.00 over 6 pcs with
 * 1 pc back twice: the ledger leaves 6.66 / 4 pcs (it books a share of what is left), the money side 6.67. A row that takes ALL the qty
 * left may pass the money remaining by `creditDriftTol` (a cent plus half a cent per prior row, capped at five cents); every other
 * row keeps 0.005, and the qty arm never changes. The DB rows CD-1, CD-5, CD-9 to CD-11 run in credit-reversal-room-a4.db.spec.ts.
 */

type Row = Record<string, unknown>;
const sale = (over: Row = {}): Row => ({
  id: "s1",
  entryType: "SALE",
  correctsEntryId: null,
  invoiceItemId: "ii1",
  orderItemId: "oi1",
  invoiceId: "inv1",
  orderId: "o1",
  trackedCategoryId: "cat",
  trackedSubcategoryId: null,
  returnId: null,
  creditNoteId: null,
  netSales: 10,
  qty: 6,
  unitBasisQty: 6,
  categoryTax: 1,
  createdAt: new Date("2026-10-01"),
  ...over,
});
const reversal = (id: string, net: number, qty: number, over: Row = {}): Row =>
  sale({
    id,
    entryType: "REVERSAL",
    returnId: `ret-${id}`,
    netSales: -net,
    qty: -qty,
    unitBasisQty: -qty,
    categoryTax: 0,
    createdAt: new Date("2026-10-02"),
    ...over,
  });

/** A stub db: the credited item, then the live SALE read (entryType "SALE"), then the line read (entryType { in }). */
function dbOf(rows: Row[]) {
  return {
    invoiceItem: {
      findMany: jest.fn().mockResolvedValue([{ id: "ii1", orderItemId: "oi1", invoiceId: "inv1" }]),
    },
    regulatedSalesLedger: {
      findMany: jest.fn(async (args: any) =>
        typeof args.where.entryType === "string"
          ? rows.filter((r) => r.entryType === "SALE" && r.correctsEntryId == null)
          : rows,
      ),
    },
  };
}
const row = (amount: number, qty: number): CreditRowInput => ({
  invoiceItemId: "ii1",
  trackedCategoryId: "cat",
  amount,
  qty,
});

// two 1-pc returns: 10.00 / 6 -> 8.33 / 5 -> 6.66 / 4 on the ledger
const afterTwoReturns = () => [sale(), reversal("r1", 1.67, 1), reversal("r2", 1.67, 1)];

describe("creditDriftTol (CD-12)", () => {
  it("is a cent plus half a cent per prior item, capped at five cents", () => {
    expect(creditDriftTol(0)).toBeCloseTo(0.01, 6);
    expect(creditDriftTol(2)).toBeCloseTo(0.02, 6);
    expect(creditDriftTol(4)).toBeCloseTo(0.03, 6);
    expect(creditDriftTol(8)).toBeCloseTo(0.05, 6);
    expect(creditDriftTol(50)).toBeCloseTo(0.05, 6);
  });
});

describe("creditRoomRefusal: a row that takes all the qty left gets the drift allowance (SA-1054 A-3)", () => {
  it("CD-1 shape: 6.67 / 4 pcs on the 6.66 / 4 the ledger holds is accepted", async () => {
    expect(await creditRoomRefusal(dbOf(afterTwoReturns()), [row(6.67, 4)])).toBeNull();
  });

  it("CD-2: 6.67 / 3 of the 4 left is not closing: refused", async () => {
    expect(await creditRoomRefusal(dbOf(afterTwoReturns()), [row(6.67, 3)])).toMatchObject({
      requestedAmount: 6.67,
      remainingAmount: 6.66,
      remainingQty: 4,
    });
  });

  it("CD-3: 6.66 / 4 is accepted", async () => {
    expect(await creditRoomRefusal(dbOf(afterTwoReturns()), [row(6.66, 4)])).toBeNull();
  });

  it("CD-4: 6.70 / 4 is past the allowance (two prior rows: two cents): refused", async () => {
    expect(await creditRoomRefusal(dbOf(afterTwoReturns()), [row(6.7, 4)])).not.toBeNull();
    expect(await creditRoomRefusal(dbOf(afterTwoReturns()), [row(6.69, 4)])).not.toBeNull();
  });

  it("CD-5: two rows, 3.34 / 2 then 3.33 / 2: the second closes and passes by the cent", async () => {
    expect(
      await creditRoomRefusal(dbOf(afterTwoReturns()), [row(3.34, 2), row(3.33, 2)]),
    ).toBeNull();
  });

  it("CD-6: a closed line (nothing left) refuses 0.03 at qty 0: the allowance needs qty left", async () => {
    // six returns close the line, so the allowance would be 4 cents (> 0.03) if a closed line could read as closing
    const nets = [1.67, 1.67, 1.67, 1.67, 1.66, 1.66];
    const closed = [sale(), ...nets.map((n, i) => reversal(`r${i}`, n, 1))];
    expect(await creditRoomRefusal(dbOf(closed), [row(0.03, 0)])).not.toBeNull();
  });

  it("CD-7: R-L1 / S1 unchanged: 50.00 / 200 on a closed line is refused", async () => {
    const closed = [sale({ netSales: 50, qty: 200, unitBasisQty: 200 }), reversal("r1", 50, 200)];
    expect(await creditRoomRefusal(dbOf(closed), [row(50, 200)])).not.toBeNull();
  });

  it("CD-8: a line a re-sync offset and never re-booked is refused with 0 left", async () => {
    const offset = [sale(), reversal("r1", 10, 6, { returnId: null })];
    expect(await creditRoomRefusal(dbOf(offset), [row(10, 6)])).toMatchObject({
      remainingAmount: 0,
      remainingQty: 0,
    });
  });

  it("the allowance does not reach the qty arm: 6.66 / 5 pcs on 4 left is refused", async () => {
    expect(await creditRoomRefusal(dbOf(afterTwoReturns()), [row(6.66, 5)])).not.toBeNull();
  });

  it("A5: 6.66 / 4.01 pcs is refused: the money fits, a hundredth of a piece past the 4 left does not", async () => {
    expect(await creditRoomRefusal(dbOf(afterTwoReturns()), [row(6.66, 4.01)])).toMatchObject({
      requestedQty: 4.01,
      remainingQty: 4,
    });
    expect(await creditRoomRefusal(dbOf(afterTwoReturns()), [row(6.66, 4)])).toBeNull();
  });

  it("a reissue's exclude drops the old note's own reversal from the room and from the prior-row count", async () => {
    const withNote = [
      ...afterTwoReturns(),
      reversal("c1", 6.66, 4, { returnId: null, creditNoteId: "cn-old" }),
    ];
    const db = dbOf(withNote);
    expect(await creditRoomRefusal(db, [row(6.67, 4)])).not.toBeNull(); // the old note holds the room
    expect(
      await creditRoomRefusal(dbOf(withNote), [row(6.67, 4)], { excludeCreditNoteId: "cn-old" }),
    ).toBeNull();
  });
});
