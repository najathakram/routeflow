import { applyReturnScan, type InlineReturnLineDraft } from "./index";

/**
 * #2694 — a scanned product lands in "What came back": a NEW product is a line with 1 piece, a
 * REPEAT scan adds 1 piece to its line. Shared by the web InlineReturnSection and mobile
 * returns/inline.tsx, so both scanners behave the same.
 */
type KeyedLine = InlineReturnLineDraft & { lineKey: string };

const widget = { id: "p-widget", name: "Widget", unit: "ea", unitsPerBox: null };
const cased = { id: "p-cased", name: "Cased Cola", unit: "can", unitsPerBox: 24 };
let seq = 0;
const makeLine = (base: InlineReturnLineDraft): KeyedLine => ({ ...base, lineKey: `k${++seq}` });

describe("#2694 applyReturnScan", () => {
  it("a new product becomes a line with 1 piece (boxes blank, reason/note empty)", () => {
    const { lines, created } = applyReturnScan<KeyedLine>([], widget, makeLine);
    expect(created).toBe(true);
    expect(lines).toEqual([
      {
        lineKey: expect.any(String),
        productId: "p-widget",
        productName: "Widget",
        unit: "ea",
        unitsPerBox: null,
        boxes: "",
        pieces: "1",
        reason: "",
        note: "",
      },
    ]);
  });

  it("a repeat scan adds 1 piece to the existing line and keeps its key and position", () => {
    const first = applyReturnScan<KeyedLine>([], widget, makeLine).lines;
    const withOther = applyReturnScan<KeyedLine>(first, cased, makeLine).lines;
    const { lines, created } = applyReturnScan<KeyedLine>(withOther, widget, makeLine);
    expect(created).toBe(false);
    expect(lines.map((l) => [l.productId, l.pieces])).toEqual([
      ["p-widget", "2"],
      ["p-cased", "1"],
    ]);
    expect(lines[0].lineKey).toBe(first[0].lineKey);
  });

  it("a repeat scan onto a line whose pieces are blank (picked, nothing typed) sets 1", () => {
    const picked: KeyedLine = {
      ...makeLine({
        productId: "p-widget",
        productName: "Widget",
        boxes: "",
        pieces: "",
        reason: "",
        note: "",
      }),
    };
    const { lines } = applyReturnScan<KeyedLine>([picked], widget, makeLine);
    expect(lines[0].pieces).toBe("1");
  });

  it("a boxed line keeps its typed boxes; the scan adds a PIECE", () => {
    const line = makeLine({
      productId: "p-cased",
      productName: "Cased Cola",
      unitsPerBox: 24,
      boxes: "2",
      pieces: "3",
      reason: "DAMAGED",
      note: "dented",
    });
    const { lines } = applyReturnScan<KeyedLine>([line], cased, makeLine);
    expect(lines[0]).toMatchObject({ boxes: "2", pieces: "4", reason: "DAMAGED", note: "dented" });
  });

  it("never mutates its input", () => {
    const input = applyReturnScan<KeyedLine>([], widget, makeLine).lines;
    const snapshot = JSON.stringify(input);
    applyReturnScan<KeyedLine>(input, widget, makeLine);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
