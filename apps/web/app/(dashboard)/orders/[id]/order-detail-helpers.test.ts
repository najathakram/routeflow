import { creditSelectionsFromOrder, formatDateOnly } from "./order-detail-helpers";

describe("order detail helpers (moved out of the page, no behaviour change)", () => {
  it("formatDateOnly shows the stored calendar day, not a day behind", () => {
    expect(formatDateOnly("2026-09-01T00:00:00.000Z")).toBe("Sep 1, 2026");
  });

  it("creditSelectionsFromOrder maps ids and numeric amounts; a missing amount stays undefined", () => {
    expect(
      creditSelectionsFromOrder({
        orderCreditNotes: [
          { creditNoteId: "cn1", amount: "12.5" },
          { creditNoteId: "cn2", amount: null },
        ],
      }),
    ).toEqual([
      { creditNoteId: "cn1", amount: 12.5 },
      { creditNoteId: "cn2", amount: undefined },
    ]);
    expect(creditSelectionsFromOrder({})).toEqual([]);
  });
});
