import { serverHoldsWhatWasSent } from "./own-replay";

const server = (lineItems: any[], shippingFee: number | null = null) => ({
  lineItems,
  shippingFee,
});
const L = (id: string, qty: number, unitPrice = 2, extra: object = {}) => ({
  id,
  qty,
  unitPrice,
  status: "CONFIRMED",
  ...extra,
});
const base = (lines: any[], fee: number | undefined = undefined) => ({ lines, fee });
const A0 = base([L("a", 4)]);

describe("serverHoldsWhatWasSent (row 698: only a PROVEN own replay is success)", () => {
  it("true when the server is exactly baseline + the sent edit", () => {
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitPrice: 2.5 }],
        server([L("a", 7, 2.5)]),
        A0,
      ),
    ).toBe(true);
    expect(
      serverHoldsWhatWasSent([{ id: "a", action: "UPDATE", qty: 7 }], server([L("a", 7)]), A0),
    ).toBe(true);
  });
  it("false when qty, price or a note differs (someone else's value)", () => {
    const sent = [{ id: "a", action: "UPDATE", qty: 7 }];
    expect(serverHoldsWhatWasSent(sent, server([L("a", 12)]), A0)).toBe(false);
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitPrice: 3 }],
        server([L("a", 7, 2)]),
        A0,
      ),
    ).toBe(false);
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, notes: "x" }],
        server([L("a", 7, 2, { notes: "y" })]),
        A0,
      ),
    ).toBe(false);
  });
  it("false when the same qty came with a field the edit did NOT send (price, note, name, unit label, reason)", () => {
    const sent = [{ id: "a", action: "UPDATE", qty: 7 }];
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7, 2.5)]), A0)).toBe(false);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7, 2, { notes: "n" })]), A0)).toBe(false);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7, 2, { name: "Renamed" })]), A0)).toBe(
      false,
    );
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7, 2, { unitLabel: "Case" })]), A0)).toBe(
      false,
    );
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7, 2, { status: "CANCELLED" })]), A0)).toBe(
      false,
    );
    // a price sent but the other user also wrote a note
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitPrice: 3 }],
        server([L("a", 7, 3, { notes: "n" })]),
        A0,
      ),
    ).toBe(false);
  });
  it("money is compared in cents: 0.01 apart is a difference", () => {
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitPrice: 2.5 }],
        server([L("a", 7, 2.51)]),
        A0,
      ),
    ).toBe(false);
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitPrice: 2.5 }],
        server([L("a", 7, "2.50" as any)]),
        A0,
      ),
    ).toBe(true);
  });
  it("false when another line moved, or another user added a line", () => {
    const b = base([L("a", 4), L("b", 3)]);
    const sent = [{ id: "a", action: "UPDATE", qty: 7 }];
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7), L("b", 3)]), b)).toBe(true);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7), L("b", 9)]), b)).toBe(false);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7)]), b)).toBe(false);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7), L("b", 3), L("c", 1)]), b)).toBe(false);
  });
  it("CANCEL / DELETE hold when the line is cancelled or gone", () => {
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "CANCEL" }],
        server([L("a", 4, 2, { status: "CANCELLED" })]),
        A0,
      ),
    ).toBe(true);
    expect(serverHoldsWhatWasSent([{ id: "a", action: "DELETE" }], server([]), A0)).toBe(true);
    expect(serverHoldsWhatWasSent([{ id: "a", action: "CANCEL" }], server([L("a", 4)]), A0)).toBe(
      false,
    );
    expect(serverHoldsWhatWasSent([{ id: "a", action: "DELETE" }], server([L("a", 4)]), A0)).toBe(
      false,
    );
  });
  it("false for anything it cannot check exactly", () => {
    const s = server([L("a", 7)]);
    expect(serverHoldsWhatWasSent([{ productId: "p", qty: 1 }], s, A0)).toBe(false); // new line
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitLabel: "Case", productId: "p" }],
        s,
        A0,
      ),
    ).toBe(false);
    const one = [{ id: "a", action: "UPDATE", qty: 7 }];
    expect(serverHoldsWhatWasSent(one, s, A0, { unverifiable: true })).toBe(false);
    expect(serverHoldsWhatWasSent([], s, A0)).toBe(false);
    expect(serverHoldsWhatWasSent(one, undefined, A0)).toBe(false);
    expect(serverHoldsWhatWasSent(one, s, undefined)).toBe(false); // no opening baseline
  });
  it("shipping fee: a sent fee must match to the cent, an unsent one must be the opened one", () => {
    const sent = [{ id: "a", action: "UPDATE", qty: 7 }];
    const b = base([L("a", 4)], 5);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7)], 9), b, { fee: 9 })).toBe(true);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7)], 9.01), b, { fee: 9 })).toBe(false);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7)], 5), b)).toBe(true);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7)], 6), b)).toBe(false);
  });
});
