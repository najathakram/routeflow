import { getPoBillRefusal } from "./po-bill-refusal";

const conflict = (data: Record<string, unknown>) => ({ response: { status: 409, data } });

describe("getPoBillRefusal", () => {
  it("returns null for any other error, so the caller toasts it", () => {
    expect(getPoBillRefusal(conflict({ code: "PO_ALREADY_BILLED", message: "x" }))).toBeNull();
    expect(getPoBillRefusal(new Error("network"))).toBeNull();
    expect(getPoBillRefusal(undefined)).toBeNull();
  });

  it("turns every violation into one plain-language line", () => {
    const r = getPoBillRefusal(
      conflict({
        code: "BILL_EXCEEDS_PO",
        poNumber: "PO-0007",
        violations: [
          { reason: "QTY_EXCEEDS_PO", description: "Cola 24pk", billed: "30", allowed: "24" },
          { reason: "PRICE_EXCEEDS_PO", description: "Chips", billed: "1.50", allowed: "1.25" },
          { reason: "NOT_ON_PO", description: "Mints", billed: "5", allowed: "" },
          { reason: "UNMAPPED_LINE", description: "Freight", billed: "20", allowed: "" },
          { reason: "TOTAL_EXCEEDS_PO", description: "", billed: "$120.00", allowed: "$100.00" },
        ],
      }),
    );
    expect(r?.poNumber).toBe("PO-0007");
    expect(r?.lines).toEqual([
      "“Cola 24pk”: billed 30 pcs, PO-0007 allows 24.",
      "“Chips”: billed at 1.50 per piece, PO-0007 allows 1.25.",
      "“Mints” is not on PO-0007.",
      "“Freight” isn't linked to a product on PO-0007 — freight and other charges belong on their own bill.",
      "The bill totals $120.00, PO-0007 authorised $100.00.",
    ]);
    expect(r?.advice).toMatch(/Edit the purchase order/);
  });

  it("falls back to a FIXED line (never the server's message) when it sends no violations", () => {
    const r = getPoBillRefusal(conflict({ code: "BILL_EXCEEDS_PO", message: "Too much." }));
    expect(r?.lines).toEqual(["This bill is more than the purchase order allows."]);
    expect(r?.poNumber).toBe("the purchase order");
  });
});
