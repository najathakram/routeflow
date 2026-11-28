import {
  headerKeysChanged,
  invoiceHeaderData,
  isNoOpEdit,
  matchEditLines,
  orderSyncLines,
  type EditedLine,
} from "./invoice-edit-plan";

/**
 * SA-1508 commit 5 (gate), the pure half. Red on master: the free-units compare, the issued-only restamp equivalence,
 * `isNoOpEdit`, `headerKeysChanged` and `invoiceHeaderData` do not exist (master: a free-units-only change is "untouched",
 * so it is silently dropped, B1451). Each case names the value a probe flips it to.
 */
const row = (over: Record<string, any> = {}) => ({
  id: "r1",
  productId: "p1",
  qty: 12,
  boxes: 1,
  pieces: 0,
  unitPrice: 10,
  discount: 0,
  taxRate: 0,
  promoFreeUnits: null,
  unitLabel: null,
  subtotal: 120,
  ...over,
});
const sent = (over: Record<string, any> = {}) => ({
  id: "r1",
  productId: "p1",
  qty: 12,
  boxes: 1,
  pieces: 0,
  unitPrice: 10,
  discount: 0,
  taxRate: 0,
  ...over,
});
const untouched = (item: any, stored: any, restampRate?: number | null) =>
  matchEditLines([item], [stored], restampRate)[0].untouched;

describe("free units join the untouched tuple (A2-N1 rule 2, A3-H2)", () => {
  it("a free-units-only change is a money edit [master: untouched, the change is lost]", () => {
    const stored = row({ qty: 72, boxes: 6, promoFreeUnits: 1 });
    expect(untouched(sent({ qty: 72, boxes: 6, promoFreeUnits: 1 }), stored)).toBe(true);
    expect(untouched(sent({ qty: 72, boxes: 6, promoFreeUnits: 2 }), stored)).toBe(false);
  });

  it("free units sent 2 on a line whose editable free units are 1 is a money edit (wrong value on a raw compare: untouched)", () => {
    // 1 free on a 2-box line caps at units - 1 = 1; a screen cannot express 2
    const stored = row({ qty: 24, boxes: 2, promoFreeUnits: 1 });
    expect(untouched(sent({ qty: 24, boxes: 2, promoFreeUnits: 1 }), stored)).toBe(true);
    expect(untouched(sent({ qty: 24, boxes: 2, promoFreeUnits: 2 }), stored)).toBe(false);
  });

  it("the over-cap row (1 free on a 1-box line) comes back at the cap and is untouched [raw compare: a money edit]", () => {
    const stored = row({ qty: 12, boxes: 1, promoFreeUnits: 1, subtotal: 0 });
    expect(untouched(sent({ promoFreeUnits: 0 }), stored)).toBe(true);
    const [m] = matchEditLines([sent({ promoFreeUnits: 0 })], [stored]);
    expect(m.row).toBe(stored);
  });

  it("A4-L5: a client that sends the STORED free units back on an over-cap row reads untouched (not re-priced)", () => {
    const stored = row({ qty: 12, boxes: 1, promoFreeUnits: 1, subtotal: 0 });
    // the screen-shown value (0) and the raw stored value (1) are both "no change"; a different value is a money edit
    expect(untouched(sent({ promoFreeUnits: 1 }), stored)).toBe(true);
    expect(untouched(sent({ promoFreeUnits: 0 }), stored)).toBe(true);
    expect(untouched(sent({ promoFreeUnits: 2 }), stored)).toBe(false);
    const [m] = matchEditLines([sent({ promoFreeUnits: 1 })], [stored]);
    expect(m.untouched).toBe(true);
  });

  it("a screen that omits free units reads 0: a line with none stays untouched", () => {
    expect(untouched(sent(), row())).toBe(true);
  });
});

describe("the issued-only restamp equivalence (A4-HA 1)", () => {
  it("a stored-rate-0 goods line sent at the verified rate is untouched only when the caller passes the rate", () => {
    const stored = row({ taxRate: 0 });
    expect(untouched(sent({ taxRate: 0.0825 }), stored, 0.0825)).toBe(true);
    expect(untouched(sent({ taxRate: 0.0825 }), stored, undefined)).toBe(false); // DRAFT: master's rule, byte for byte
    expect(untouched(sent({ taxRate: 0.0825 }), stored, null)).toBe(false);
  });

  it("a rate other than the verified one is a change; a stored non-zero rate never takes the equivalence", () => {
    expect(untouched(sent({ taxRate: 0.05 }), row({ taxRate: 0 }), 0.0825)).toBe(false);
    expect(untouched(sent({ taxRate: 0.0825 }), row({ taxRate: 0.05 }), 0.0825)).toBe(false);
  });

  it("an NSF fee line never takes it", () => {
    const nsf = row({ taxRate: 0, systemKind: "NSF_FEE" });
    expect(untouched(sent({ taxRate: 0.0825 }), nsf, 0.0825)).toBe(false);
  });

  it("the id-less matcher (the second pass) honours it too", () => {
    const [m] = matchEditLines([sent({ id: undefined, taxRate: 0.0825 })], [row()], 0.0825);
    expect(m.untouched).toBe(true);
  });
});

describe("figure-free = orderSyncLines(...) === null, with the new tuple", () => {
  const edited = (r: any, untouchedLine: boolean): EditedLine[] => [
    { rowId: r.id, untouched: untouchedLine, data: { ...r } },
  ];
  it("an all-untouched save is figure-free; a changed line or a moved discount is not", () => {
    const stored = row();
    expect(
      orderSyncLines(edited(stored, true), [stored], { discount: 0, shippingFee: 0 }, 0, 0),
    ).toBeNull();
    expect(
      orderSyncLines(edited(stored, false), [stored], { discount: 0, shippingFee: 0 }, 0, 0),
    ).not.toBeNull();
    expect(
      orderSyncLines(edited(stored, true), [stored], { discount: 0, shippingFee: 0 }, 5, 0),
    ).not.toBeNull();
  });
});

describe("invoiceHeaderData (one builder for the header branch and the issued gate)", () => {
  const due = { dueDate: new Date("2026-12-01T00:00:00Z"), depositDueDate: null };
  it("carries only the keys the save sent; '' clears a label, reference or subject to null", () => {
    expect(
      invoiceHeaderData({ notes: "n" }, { dueDate: null, depositDueDate: null }, undefined),
    ).toEqual({
      notes: "n",
    });
    expect(
      invoiceHeaderData(
        { paymentTermsLabel: "", referenceNumber: "", subject: "", terms: "t" },
        { dueDate: null, depositDueDate: null },
        undefined,
      ),
    ).toEqual({ paymentTermsLabel: null, referenceNumber: null, subject: null, terms: "t" });
  });
  it("dates are the stamps; a deposit date key present with no date clears it", () => {
    const issue = new Date("2026-11-01T00:00:00Z");
    expect(invoiceHeaderData({ depositDueDate: null, depositPercent: 20 }, due, issue)).toEqual({
      dueDate: due.dueDate,
      issueDate: issue,
      depositPercent: 20,
      depositDueDate: null,
    });
  });
});

describe("headerKeysChanged and isNoOpEdit (A2-N1 rule 5)", () => {
  const cur = {
    dueDate: new Date("2026-12-01T00:00:00Z"),
    issueDate: new Date("2026-11-01T00:00:00Z"),
    notes: "n",
    terms: null,
    depositPercent: 20,
    paymentTermsLabel: null,
  };
  it.each([
    ["dueDate", { dueDate: new Date("2026-12-02T00:00:00Z") }],
    ["issueDate", { issueDate: new Date("2026-11-02T00:00:00Z") }],
    ["notes", { notes: "other" }],
    ["terms", { terms: "net 30" }],
    ["depositPercent", { depositPercent: 25 }],
    ["paymentTermsLabel", { paymentTermsLabel: "Net 15" }],
  ])("a changed %s is a change (and the save is not a no-op)", (key, patch) => {
    expect(headerKeysChanged(patch, cur)).toEqual([key]);
    expect(isNoOpEdit({ figureFree: true, linePatches: 0, headerData: patch, row: cur })).toBe(
      false,
    );
  });
  it("every key equal (dates by stamp, a Decimal by value, null with null) changes nothing", () => {
    const data = {
      dueDate: new Date("2026-12-01T00:00:00Z"),
      issueDate: new Date("2026-11-01T00:00:00.000Z"),
      notes: "n",
      terms: null,
      depositPercent: { toNumber: () => 20, valueOf: () => "20" },
    };
    expect(headerKeysChanged(data, cur)).toEqual([]);
    expect(isNoOpEdit({ figureFree: true, linePatches: 0, headerData: data, row: cur })).toBe(true);
  });
  it("a line patch, or a save that is not figure-free, is never a no-op", () => {
    expect(isNoOpEdit({ figureFree: true, linePatches: 1, headerData: {}, row: cur })).toBe(false);
    expect(isNoOpEdit({ figureFree: false, linePatches: 0, headerData: {}, row: cur })).toBe(false);
  });
});
