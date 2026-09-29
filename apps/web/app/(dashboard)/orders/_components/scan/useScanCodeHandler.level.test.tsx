import { renderHook, waitFor } from "@testing-library/react";
import { useScanCodeHandler, type ScanCodeHandlerDeps } from "./useScanCodeHandler";

/**
 * #2717 M4a-1 (SA-580 R1/R2, web): the scan handler works out WHICH LEVEL the scanned code is and
 * hands it to addLineItem as its second argument — the code decides, never the line's mode.
 *
 * RED (M4a-1): the handler calls `addLineItem(product)` with ONE argument today, so every
 * `toHaveBeenCalledWith(product, <level>)` fails on the missing 2nd arg. The pre-existing
 * "routes a hit to addLineItem" test in useScanCodeHandler.test.tsx asserts `(product)` alone and
 * must be updated by the builder to the two-arg form.
 */
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolve(code),
}));

const boxed = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Sample Chips",
  sku: "CHIPS-12",
  barcode: "4005006000012",
  unitSku: "CHIPS-1",
  unitsPerBox: 12,
  ...over,
});

function deps(): ScanCodeHandlerDeps {
  return { addLineItem: jest.fn(), onUnknownCode: jest.fn(), toast: jest.fn() };
}

async function scan(code: string, product: unknown) {
  mockResolve.mockResolvedValue({ notFound: false, archived: false, product });
  const d = deps();
  const { result } = renderHook(() => useScanCodeHandler(d));
  result.current.current(code);
  await waitFor(() => expect(d.addLineItem).toHaveBeenCalled());
  return d;
}

describe("useScanCodeHandler — passes the scanned level (R1/R2)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("server scanMatch UNIT-only -> addLineItem(product, 'UNIT')", async () => {
    const p = boxed({ scanMatch: { code: "UNITCODE", levels: ["UNIT"] } });
    const d = await scan("UNITCODE", p);
    expect(d.addLineItem).toHaveBeenCalledWith(p, "UNIT");
  });

  it("server scanMatch BOX-only -> 'BOX'", async () => {
    const p = boxed({ scanMatch: { code: "BOXCODE", levels: ["BOX"] } });
    const d = await scan("BOXCODE", p);
    expect(d.addLineItem).toHaveBeenCalledWith(p, "BOX");
  });

  it("R2 (SA-580b): a shared code (BOX and UNIT) -> the product default unit: 'BOX' at upb>1", async () => {
    const p = boxed({ scanMatch: { code: "SH", levels: ["UNIT", "BOX"] } });
    const d = await scan("SH", p);
    expect(d.addLineItem).toHaveBeenCalledWith(p, "BOX");
  });

  it("R2 (SA-580b): a shared code on an upb<=1 product -> 'UNIT' (the default unit, not BOX)", async () => {
    const p = boxed({ unitsPerBox: 1, scanMatch: { code: "SH", levels: ["UNIT", "BOX"] } });
    const d = await scan("SH", p);
    expect(d.addLineItem).toHaveBeenCalledWith(p, "UNIT");
  });

  it("SA-580c: a shared code on a units_v1 product (default-selling 'Piece') = the picker tap as-is -> 'BOX', NOT isDefaultSelling", async () => {
    // Follow-up (owner ruling pending): picker tap AND scan honour isDefaultSelling together.
    const p = boxed({
      units: [{ label: "Piece", isDefaultSelling: true }],
      scanMatch: { code: "SH", levels: ["UNIT", "BOX"] },
    });
    const d = await scan("SH", p);
    expect(d.addLineItem).toHaveBeenCalledWith(p, "BOX");
  });

  it("web unitSku scan -> a piece (named behaviour change, SA-578 Q2): no scanMatch, code equals unitSku, upb>1 -> 'UNIT'", async () => {
    const p = boxed();
    const d = await scan("CHIPS-1", p);
    expect(d.addLineItem).toHaveBeenCalledWith(p, "UNIT");
  });

  it("no scanMatch, code equals sku -> 'BOX'; equals barcode (shared with the synthesized UNIT row) -> 'BOX'", async () => {
    const p = boxed();
    expect((await scan("CHIPS-12", p)).addLineItem).toHaveBeenCalledWith(p, "BOX");
    jest.clearAllMocks();
    expect((await scan("4005006000012", p)).addLineItem).toHaveBeenCalledWith(p, "BOX");
  });

  it("no scanMatch but cached row barcodes[]: a UNIT-only row code -> 'UNIT'", async () => {
    const p = boxed({ barcodes: [{ code: "ROW-U", level: "UNIT" }, { code: "ROW-B", level: "BOX" }] });
    expect((await scan("ROW-U", p)).addLineItem).toHaveBeenCalledWith(p, "UNIT");
  });

  it("upb <= 1 product still passes a BOX|UNIT level (the modal keeps today's line shape, R4)", async () => {
    const p = boxed({ unitsPerBox: null, unitSku: null, scanMatch: { code: "X", levels: ["UNIT"] } });
    const d = await scan("X", p);
    const level = (d.addLineItem as jest.Mock).mock.calls[0][1];
    expect(["BOX", "UNIT"]).toContain(level);
  });
});
