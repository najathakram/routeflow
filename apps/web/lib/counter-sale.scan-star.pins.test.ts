import { parseScanField } from "./counter-sale";

/** SA-1256 K6: the scan field's own "qty*code" grammar is untouched by typed sums. */
describe("parseScanField keeps its own star grammar (SA-1256 K6)", () => {
  it('"5*2" is code "2" with quantity 5, never a worked-out 10', () => {
    expect(parseScanField("5*2")).toEqual({ kind: "code", code: "2", qty: 5 });
  });
});
