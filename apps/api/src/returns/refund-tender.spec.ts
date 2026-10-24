/**
 * SA-740r/r2 item 8: ONE tender vocabulary. A counter refund tender (CASH | CARD | CHECK) is stored in `Return.refundTender`
 * as the existing `PaymentMethod` (CARD -> CREDIT_CARD) through the SAME `toPrismaMethod` the counter payment legs use, and
 * read back through its exact inverse. One writer (`setRefundTender`) backs the backfill; the claims write the column in their
 * own CAS data (`refundTenderData`).
 */
import { REFUND_TENDERS } from "./inline-return-refund";
import {
  refundTenderColumn,
  refundTenderData,
  refundTenderOfColumn,
  refundTenderOfReturn,
  setRefundTender,
} from "./refund-tender";

describe("refund tender <-> Return.refundTender (PaymentMethod)", () => {
  it("maps CASH / CARD / CHECK through toPrismaMethod: CARD is CREDIT_CARD", () => {
    expect(refundTenderColumn("CASH")).toBe("CASH");
    expect(refundTenderColumn("CARD")).toBe("CREDIT_CARD");
    expect(refundTenderColumn("CHECK")).toBe("CHECK");
  });

  it("the inverse round-trips every tender, and anything else is unknown (null), never CASH", () => {
    for (const t of REFUND_TENDERS) expect(refundTenderOfColumn(refundTenderColumn(t))).toBe(t);
    for (const v of [
      "ACH",
      "ZELLE",
      "OTHER",
      "CREDIT_NOTE",
      "ADVANCE",
      "cash",
      "",
      null,
      undefined,
    ])
      expect(refundTenderOfColumn(v as any)).toBeNull();
  });

  it("refundTenderData is the claim's data: the column value, or null when no tender was given", () => {
    expect(refundTenderData("CARD")).toEqual({ refundTender: "CREDIT_CARD" });
    expect(refundTenderData(undefined)).toEqual({ refundTender: null });
    expect(refundTenderData(null)).toEqual({ refundTender: null });
  });

  describe("refundTenderOfReturn: the column first, the audit tender only for a pre-backfill row", () => {
    it("the column wins over a disagreeing audit tender", () => {
      expect(refundTenderOfReturn({ refundTender: "CREDIT_CARD" }, { tender: "CASH" })).toBe(
        "CARD",
      );
    });
    it("a null column falls back to a VALID audit tender", () => {
      expect(refundTenderOfReturn({ refundTender: null }, { tender: "CHECK" })).toBe("CHECK");
    });
    it("a null column and a missing / unknown audit tender is unknown", () => {
      expect(refundTenderOfReturn({ refundTender: null }, { tender: "BITCOIN" })).toBeNull();
      expect(refundTenderOfReturn({ refundTender: null }, null)).toBeNull();
      expect(refundTenderOfReturn({}, {})).toBeNull();
    });
  });
});

describe("setRefundTender: the one idempotent writer", () => {
  it("writes only a resolved EXTERNAL_REFUND of this tenant whose column is still null", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const n = await setRefundTender(
      { return: { updateMany } },
      { id: "r1", tenantId: "t1", tender: "CARD" },
    );
    expect(n).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "r1",
        tenantId: "t1",
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundTender: null,
      },
      data: { refundTender: "CREDIT_CARD" },
    });
  });

  it("a second call writes nothing (the where clause no longer matches)", async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const db = { return: { updateMany } };
    expect(await setRefundTender(db, { id: "r1", tenantId: "t1", tender: "CASH" })).toBe(1);
    expect(await setRefundTender(db, { id: "r1", tenantId: "t1", tender: "CASH" })).toBe(0);
  });

  it("refuses an unknown tender instead of writing a guess", async () => {
    const updateMany = jest.fn();
    await expect(
      setRefundTender(
        { return: { updateMany } },
        { id: "r1", tenantId: "t1", tender: "ACH" as any },
      ),
    ).rejects.toThrow(/tender/i);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
