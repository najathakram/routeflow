import { buildParkPayload } from "./counter-park";

/** W-1187 PR-2b: a parked sale keeps the order its lines were dragged into (the payload is the array, rebuilt in place). */
const line = (id: string, name: string) => ({
  tempId: `t-${id}`,
  productId: `p-${id}`,
  name,
  unitPrice: 2,
  qty: 1,
});

describe("buildParkPayload keeps the dragged order", () => {
  it("lines come out in the order they went in, not sorted by name, product or time", () => {
    const out = buildParkPayload({
      lines: [line("w", "Water"), line("c", "Cola"), line("j", "Juice")],
      customer: null,
      method: "CASH",
      tendered: "",
      reference: "",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.lines.map((l) => (l as { name: string }).name)).toEqual([
      "Water",
      "Cola",
      "Juice",
    ]);
  });
});
