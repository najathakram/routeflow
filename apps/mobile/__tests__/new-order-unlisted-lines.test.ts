import {
  unlistedPatched,
  unlistedWithPrice,
  unlistedWithQty,
} from "../components/new-order/unlisted-lines";

/** New order's ad-hoc line edits (moved out of NewOrderScreen unchanged). */
const LINES = [
  { id: "a", name: "Ice", unitPrice: 2, qty: 1 },
  { id: "b", name: "Bag", unitPrice: 1, qty: 3 },
];

describe("unlisted line edits", () => {
  it("a quantity sets that line; 0 or less removes it", () => {
    expect(unlistedWithQty(LINES, "a", 4)[0].qty).toBe(4);
    expect(unlistedWithQty(LINES, "a", 0).map((x) => x.id)).toEqual(["b"]);
    expect(unlistedWithQty(LINES, "b", -1).map((x) => x.id)).toEqual(["a"]);
  });
  it("a missing or negative price reads as $0 (a comped line is still sent)", () => {
    expect(unlistedWithPrice(LINES, "a", 5)[0].unitPrice).toBe(5);
    expect(unlistedWithPrice(LINES, "a", null)[0].unitPrice).toBe(0);
    expect(unlistedWithPrice(LINES, "a", -3)[0].unitPrice).toBe(0);
  });
  it("a patch touches only its line", () => {
    const out = unlistedPatched(LINES, "b", (x) => ({ noteOpen: !x.noteOpen, note: "n" }));
    expect(out[1]).toMatchObject({ noteOpen: true, note: "n" });
    expect(out[0]).toBe(LINES[0]);
  });
});
