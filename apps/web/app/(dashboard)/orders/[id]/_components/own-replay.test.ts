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

describe("serverHoldsWhatWasSent (row 698: only a PROVEN own replay is success)", () => {
  it("true when every UPDATE is already on the server", () => {
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitPrice: 2.5 }],
        server([L("a", 7, 2.5)]),
      ),
    ).toBe(true);
  });
  it("false when qty, price or a note differs (someone else's value)", () => {
    const sent = [{ id: "a", action: "UPDATE", qty: 7 }];
    expect(serverHoldsWhatWasSent(sent, server([L("a", 12)]))).toBe(false);
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitPrice: 3 }],
        server([L("a", 7, 2)]),
      ),
    ).toBe(false);
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, notes: "x" }],
        server([L("a", 7, 2, { notes: "y" })]),
      ),
    ).toBe(false);
  });
  it("CANCEL / DELETE hold when the line is cancelled or gone", () => {
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "CANCEL" }],
        server([L("a", 1, 2, { status: "CANCELLED" })]),
      ),
    ).toBe(true);
    expect(serverHoldsWhatWasSent([{ id: "a", action: "DELETE" }], server([]))).toBe(true);
    expect(serverHoldsWhatWasSent([{ id: "a", action: "CANCEL" }], server([L("a", 1)]))).toBe(
      false,
    );
    expect(serverHoldsWhatWasSent([{ id: "a", action: "DELETE" }], server([L("a", 1)]))).toBe(
      false,
    );
  });
  it("false for anything it cannot check exactly", () => {
    const s = server([L("a", 7)]);
    expect(serverHoldsWhatWasSent([{ productId: "p", qty: 1 }], s)).toBe(false); // new line
    expect(
      serverHoldsWhatWasSent(
        [{ id: "a", action: "UPDATE", qty: 7, unitLabel: "Case", productId: "p" }],
        s,
      ),
    ).toBe(false);
    expect(
      serverHoldsWhatWasSent([{ id: "a", action: "UPDATE", qty: 7 }], s, { unverifiable: true }),
    ).toBe(false);
    expect(serverHoldsWhatWasSent([], s)).toBe(false);
    expect(serverHoldsWhatWasSent([{ id: "a", action: "UPDATE", qty: 7 }], undefined)).toBe(false);
  });
  it("a changed shipping fee must match too", () => {
    const sent = [{ id: "a", action: "UPDATE", qty: 7 }];
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7)], 5), { fee: 5 })).toBe(true);
    expect(serverHoldsWhatWasSent(sent, server([L("a", 7)], 9), { fee: 5 })).toBe(false);
  });
});
