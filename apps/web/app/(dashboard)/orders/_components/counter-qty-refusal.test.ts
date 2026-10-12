import {
  QTY_NEGATIVE_COPY,
  QTY_NOT_A_NUMBER_COPY,
  QTY_NOT_WHOLE_COPY,
  QTY_TOO_LARGE_COPY,
  QTY_ZERO_BOXED_COPY,
  QTY_ZERO_COPY,
  qtyRefusalMessage,
} from "./counter-qty-refusal";
import { setLineQty } from "./counter-sale-line-edit";
import type { SaleLine } from "./counter-sale-scan";

/** CQ-12: every text the screen refuses gets a sentence; what is accepted is `setLineQty`'s and is not changed here. */
const plain = { tempId: "t", productId: "p", name: "Cola", unitPrice: 2.5, qty: 3 } as SaleLine;
const boxed = {
  tempId: "t2",
  productId: "p2",
  name: "Water",
  unitPrice: 12,
  qty: 12,
  unitsPerBox: 12,
  boxes: 1,
  pieces: 0,
} as SaleLine;

describe("qtyRefusalMessage (CQ-12)", () => {
  it.each([
    ["0", "qty", QTY_ZERO_COPY],
    ["-2", "qty", QTY_NEGATIVE_COPY],
    ["abc", "qty", QTY_NOT_A_NUMBER_COPY],
    ["", "qty", QTY_NOT_A_NUMBER_COPY],
    ["1.5", "qty", QTY_NOT_WHOLE_COPY],
    ["99999999999999999999", "qty", QTY_TOO_LARGE_COPY],
    ["0", "boxes", QTY_ZERO_BOXED_COPY],
    ["1.5", "pieces", QTY_NOT_WHOLE_COPY],
  ] as const)("%j in a %s field reads %j", (text, kind, copy) => {
    expect(qtyRefusalMessage(text, kind)).toBe(copy);
  });

  it("explains exactly the texts setLineQty refuses (and none it accepts would reach it)", () => {
    for (const text of ["0", "-2", "abc", "", "1.5", " "]) {
      expect(setLineQty(plain, { qty: text })).toBeNull();
      expect(qtyRefusalMessage(text, "qty").length).toBeGreaterThan(0);
    }
    for (const text of ["1", "7", " 4 "]) expect(setLineQty(plain, { qty: text })).not.toBeNull();
    // a boxed line: zero boxes AND zero pieces leaves nothing, so the single zero is refused only in total
    expect(setLineQty({ ...boxed, pieces: 0 }, { boxes: "0" })).toBeNull();
    expect(setLineQty({ ...boxed, pieces: 3 }, { boxes: "0" })).not.toBeNull();
  });
});
