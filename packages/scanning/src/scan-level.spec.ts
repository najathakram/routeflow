/**
 * #2717 M4a-1 — the ONE pure scan-level resolver (SA-580 owner rule, supersedes plan cases 6-9;
 * SA-580a buyer rule).
 *
 * RED (M4a-1): ./scan-level does not exist yet — fails on "Cannot find module './scan-level'".
 *
 * Contract these specs pin (names/signatures are the builder's to satisfy, chosen here):
 *   resolveScanSellLevel(product: { unitsPerBox?: number | null }, levels: readonly SellLevel[]): SellLevel
 *     - takes ONE product and the SET OF LEVELS THE HIT CODE HAS (no lineMode, no line).
 *   levelsForScannedCode(code, product { barcode, sku, unitSku, unitsPerBox, barcodes? }): SellLevel[]
 *     - the levels the scanned code has on that product: from `barcodes[]` rows when present,
 *       else the legacy columns exactly as M1's planBarcodeRows/synthesizeLegacyBarcodes would
 *       (barcode -> BOX+UNIT when upb>1 else UNIT; sku -> BOX; unitSku -> UNIT).
 */
import { defaultSellLevel, SELL_LEVEL_VALUES, type SellLevel } from "@routeflow/pricing";
import {
  levelsForScannedCode,
  isSharedScanCode,
  resolveScanSellLevel,
  scanMatchIsForCode,
} from "./scan-level";

const BOX: SellLevel = "BOX";
const UNIT: SellLevel = "UNIT";

describe("resolveScanSellLevel — R1/R2 (the CODE decides the level, never the line)", () => {
  it("R1: a UNIT-only code -> UNIT, on a boxed product", () => {
    expect(resolveScanSellLevel({ unitsPerBox: 6 }, [UNIT])).toBe(UNIT);
  });

  it("R1: a BOX-only code -> BOX, on a boxed product", () => {
    expect(resolveScanSellLevel({ unitsPerBox: 6 }, [BOX])).toBe(BOX);
  });

  it("R2 (SA-580b): a SHARED code (BOX and UNIT) on a boxed product -> the default sell unit (BOX), in either order of the set", () => {
    expect(resolveScanSellLevel({ unitsPerBox: 6 }, [BOX, UNIT])).toBe(BOX);
    expect(resolveScanSellLevel({ unitsPerBox: 6 }, [UNIT, BOX])).toBe(BOX);
  });

  it("R2 (SA-580b): a shared code on upb > 1 -> BOX, on upb <= 1 / null -> UNIT (defaultSellLevel decides, not a fixed BOX)", () => {
    for (const upb of [2, 6, 24]) {
      expect(resolveScanSellLevel({ unitsPerBox: upb }, [BOX, UNIT])).toBe(BOX);
    }
    for (const upb of [1, 0, null, undefined]) {
      expect(resolveScanSellLevel({ unitsPerBox: upb }, [BOX, UNIT])).toBe(UNIT);
      expect(resolveScanSellLevel({ unitsPerBox: upb }, [UNIT, BOX])).toBe(UNIT);
    }
  });

  it("R2 (SA-580b): a distinct code still wins over the default — BOX-only on upb 1 -> BOX, UNIT-only on upb 6 -> UNIT", () => {
    expect(resolveScanSellLevel({ unitsPerBox: 1 }, [BOX])).toBe(BOX);
    expect(resolveScanSellLevel({ unitsPerBox: 6 }, [UNIT])).toBe(UNIT);
  });

  it("supersedes plan cases 7-9: no lineMode input exists, and a smuggled one changes nothing", () => {
    // Plan case 7 said a shared code on a unit-mode line -> UNIT. The line never matters: at upb 6 the default unit is BOX.
    const smuggled = { unitsPerBox: 6, lineMode: "UNIT", sellBy: "unit" } as unknown as {
      unitsPerBox: number;
    };
    expect(resolveScanSellLevel(smuggled, [BOX, UNIT])).toBe(BOX);
    // Case 8 holds: UNIT-only on a case-mode line -> UNIT. Case 9 holds: BOX-only on unit-mode -> BOX.
    const caseLine = { unitsPerBox: 6, lineMode: "CASE" } as unknown as { unitsPerBox: number };
    const unitLine = { unitsPerBox: 6, lineMode: "UNIT" } as unknown as { unitsPerBox: number };
    expect(resolveScanSellLevel(caseLine, [UNIT])).toBe(UNIT);
    expect(resolveScanSellLevel(unitLine, [BOX])).toBe(BOX);
  });

  it("the signature takes ONE product and the levels set (arity 2) — it cannot choose between products", () => {
    expect(resolveScanSellLevel.length).toBe(2);
  });

  it("an empty level set (nothing classifiable) falls back to defaultSellLevel — never a prompt, never undefined", () => {
    expect(resolveScanSellLevel({ unitsPerBox: 6 }, [])).toBe(defaultSellLevel({ unitsPerBox: 6 }));
    expect(resolveScanSellLevel({ unitsPerBox: null }, [])).toBe(defaultSellLevel({}));
  });

  it("TOTAL function (seeded sweep): every product x every level subset returns exactly BOX|UNIT", () => {
    let seed = 580;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const upbs = [null, undefined, 0, 1, 2, 6, 24, -3, 1.5, Number.NaN, 1e9];
    for (let i = 0; i < 500; i += 1) {
      const upb = upbs[Math.floor(rnd() * upbs.length)];
      const levels = SELL_LEVEL_VALUES.filter(() => rnd() < 0.5);
      // duplicate a level sometimes: a set is not guaranteed de-duplicated
      if (levels.length && rnd() < 0.3) levels.push(levels[0]);
      const out = resolveScanSellLevel({ unitsPerBox: upb as number | null }, levels);
      expect(SELL_LEVEL_VALUES).toContain(out);
      // SA-580b: whenever the set holds BOTH levels the answer is the product's default sell unit.
      if (levels.includes(BOX) && levels.includes(UNIT)) {
        expect(out).toBe(defaultSellLevel({ unitsPerBox: upb as number | null }));
      }
    }
  });
});

describe("resolveScanSellLevel — R4 (upb <= 1: no box/unit distinction)", () => {
  it("is still total and BOX|UNIT at upb null/0/1 for every level set (the CLIENT keeps today's line shape; parity is pinned on the client outcome, not this raw level — SA-578 Q2a)", () => {
    for (const upb of [null, 0, 1]) {
      for (const levels of [[BOX], [UNIT], [BOX, UNIT], []] as SellLevel[][]) {
        expect(SELL_LEVEL_VALUES).toContain(resolveScanSellLevel({ unitsPerBox: upb }, levels));
      }
    }
  });

  it("an upb=1 product's synthesized barcode row is UNIT-only (M1 rule), so the raw level differs from mobile scanUnitKind's 'case' — the divergence SA-578 Q2(a) says NOT to pin at the level", () => {
    const levels = levelsForScannedCode("012345678905", {
      barcode: "012345678905",
      sku: "S",
      unitSku: null,
      unitsPerBox: 1,
    });
    expect(levels).toEqual([UNIT]);
  });
});

describe("levelsForScannedCode — legacy columns (parity with mobile scanUnitKind on upb>1, R5)", () => {
  const boxed = {
    barcode: "4000000000019",
    sku: "COLA-6",
    unitSku: "2000000000012",
    unitsPerBox: 6,
  };

  it.each([
    ["barcode hit", "4000000000019", [BOX, UNIT], BOX],
    ["sku hit", "COLA-6", [BOX], BOX],
    ["unitSku-only hit", "2000000000012", [UNIT], UNIT],
  ] as const)("%s at upb 6: levels %j, resolves to %s", (_n, code, levels, level) => {
    const got = levelsForScannedCode(code, boxed);
    expect([...got].sort()).toEqual([...levels].sort());
    expect(resolveScanSellLevel(boxed, got)).toBe(level);
  });

  it("unitSku == barcode (shared) at upb 6 -> BOX (R2, default unit)", () => {
    const p = { ...boxed, unitSku: boxed.barcode };
    expect(resolveScanSellLevel(p, levelsForScannedCode(boxed.barcode, p))).toBe(BOX);
  });

  it("unitSku == sku (shared) at upb 6 -> BOX (R2, default unit)", () => {
    const p = { ...boxed, unitSku: "COLA-6" };
    expect(resolveScanSellLevel(p, levelsForScannedCode("COLA-6", p))).toBe(BOX);
  });

  it("SA-580b: unitSku == sku (shared) on an upb-1 product -> UNIT (default unit), not BOX", () => {
    const p = { barcode: null, sku: "PLAIN-1", unitSku: "PLAIN-1", unitsPerBox: 1 };
    expect([...levelsForScannedCode("PLAIN-1", p)].sort()).toEqual([BOX, UNIT]);
    expect(resolveScanSellLevel(p, levelsForScannedCode("PLAIN-1", p))).toBe(UNIT);
  });

  it("matches case-insensitively and through the normalizeScanCode candidate set (UPC-A 12 vs EAN-13 zero-padded)", () => {
    expect(levelsForScannedCode("cola-6", boxed)).toEqual([BOX]);
    const p = { ...boxed, barcode: "0042100005264" };
    expect(levelsForScannedCode("042100005264", p)).toContain(BOX);
  });

  it("a code that hits nothing on the product has no levels (the caller then uses the default level)", () => {
    expect(levelsForScannedCode("999", boxed)).toEqual([]);
  });
});

describe("levelsForScannedCode — ProductBarcode rows (R1/R2 on rows)", () => {
  const withRows = {
    barcode: null,
    sku: "S",
    unitSku: null,
    unitsPerBox: 6,
    barcodes: [
      { code: "BOXCODE", level: BOX },
      { code: "UNITCODE", level: UNIT },
      { code: "SHARED", level: BOX },
      { code: "SHARED", level: UNIT },
    ],
  };

  it("a UNIT-only row code -> [UNIT] -> UNIT; a BOX-only row code -> [BOX] -> BOX", () => {
    expect(levelsForScannedCode("UNITCODE", withRows)).toEqual([UNIT]);
    expect(resolveScanSellLevel(withRows, levelsForScannedCode("UNITCODE", withRows))).toBe(UNIT);
    expect(levelsForScannedCode("BOXCODE", withRows)).toEqual([BOX]);
    expect(resolveScanSellLevel(withRows, levelsForScannedCode("BOXCODE", withRows))).toBe(BOX);
  });

  it("a row code at BOTH levels -> shared -> the product default unit (R2, SA-580b): BOX at upb 6, UNIT at upb 1", () => {
    const got = levelsForScannedCode("SHARED", withRows);
    expect([...got].sort()).toEqual([BOX, UNIT]);
    expect(resolveScanSellLevel(withRows, got)).toBe(BOX);
    const plain = { ...withRows, unitsPerBox: 1 };
    expect(resolveScanSellLevel(plain, levelsForScannedCode("SHARED", plain))).toBe(UNIT);
  });

  it("SA-595: rows are authoritative over the barcode column only (a unitSku equal to a BOX row code adds UNIT: shared)", () => {
    const p = { ...withRows, unitSku: "BOXCODE" };
    expect([...levelsForScannedCode("BOXCODE", p)].sort()).toEqual([BOX, UNIT]);
  });

  it("an empty barcodes[] array means 'no rows' -> legacy fallback (L-159: one presence check, not per field)", () => {
    const p = { barcode: "4000000000019", sku: "S", unitSku: null, unitsPerBox: 6, barcodes: [] };
    expect([...levelsForScannedCode("4000000000019", p)].sort()).toEqual([BOX, UNIT]);
  });
});

describe("levelsForScannedCode — SA-595: rows supersede ONLY the barcode column", () => {
  const p = {
    barcode: "4000000000019",
    sku: "COLA-6",
    unitSku: "2000000000012",
    unitsPerBox: 6,
    barcodes: [
      { code: "ROW-U", level: UNIT },
      { code: "ROW-B", level: BOX },
    ],
  };

  it("with rows present a unitSku hit -> [UNIT] and a sku hit -> [BOX]", () => {
    expect(levelsForScannedCode("2000000000012", p)).toEqual([UNIT]);
    expect(levelsForScannedCode("COLA-6", p)).toEqual([BOX]);
  });

  it("same at upb 1 (sku -> BOX raw level, unitSku -> UNIT)", () => {
    const plain = { ...p, unitsPerBox: 1 };
    expect(levelsForScannedCode("COLA-6", plain)).toEqual([BOX]);
    expect(levelsForScannedCode("2000000000012", plain)).toEqual([UNIT]);
  });

  it("a legacy Product.barcode value with rows present adds no levels; a row code does", () => {
    expect(levelsForScannedCode("4000000000019", p)).toEqual([]);
    expect(levelsForScannedCode("ROW-U", p)).toEqual([UNIT]);
    expect(levelsForScannedCode("ROW-B", p)).toEqual([BOX]);
  });

  it("a sku equal to a UNIT row code is shared (BOX+UNIT)", () => {
    const q = { ...p, sku: "ROW-U" };
    expect([...levelsForScannedCode("ROW-U", q)].sort()).toEqual([BOX, UNIT]);
  });
});

describe("scanMatchIsForCode — a scanMatch only speaks for the code that produced it (#2764)", () => {
  it("same code (case / whitespace) and UPC-A vs EAN-13 forms agree; a different code does not", () => {
    expect(scanMatchIsForCode(" shared-b ", "SHARED-B")).toBe(true);
    expect(scanMatchIsForCode("042100005264", "0042100005264")).toBe(true);
    expect(scanMatchIsForCode("UNIT-U", "SHARED-B")).toBe(false);
  });
  it("a missing code cannot be disproved", () => {
    expect(scanMatchIsForCode("X", undefined)).toBe(true);
    expect(scanMatchIsForCode("X", "")).toBe(true);
  });
});

describe("levelsForScannedCode — a row whose level is not BOX/UNIT never contributes (#2764)", () => {
  it("CASE + UNIT rows on one code -> [UNIT] only", () => {
    const rows = [
      { code: "SH", level: "CASE" },
      { code: "SH", level: "UNIT" },
    ] as any;
    expect(levelsForScannedCode("SH", { barcodes: rows, unitsPerBox: 6 })).toEqual(["UNIT"]);
  });
});

describe("isSharedScanCode (SA-626): the ONE rule web and mobile share for 'start on the default unit'", () => {
  it("is true only when the code resolves at BOTH levels", () => {
    expect(isSharedScanCode(["BOX", "UNIT"])).toBe(true);
    expect(isSharedScanCode(["UNIT", "BOX"])).toBe(true);
  });

  it("is false for a box-only, a unit-only and an unmatched code (the code decides the level)", () => {
    expect(isSharedScanCode(["BOX"])).toBe(false);
    expect(isSharedScanCode(["UNIT"])).toBe(false);
    expect(isSharedScanCode([])).toBe(false);
  });
});

describe("no second 'which unit label' rule lives in @routeflow/scanning (SA-626a)", () => {
  it("resolveScanSellChoice / ScanSellChoice / ScanDefaultUnits are not exported (defaultSellingLabel in pricing is the one rule)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./scan-level") as Record<string, unknown>;
    expect(mod.resolveScanSellChoice).toBeUndefined();
  });
});
