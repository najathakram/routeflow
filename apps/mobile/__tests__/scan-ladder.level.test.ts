/**
 * #2717 M4a-1 (SA-580 R1/R2/R5, mobile): the ladder hands `accept` a LEVEL ("BOX" | "UNIT") from the
 * shared resolver, on both the local fast path and the server rung. RED (M4a-1): accept still gets
 * "case" | "piece" from scanUnitKind, so every toBe/toEqual on "BOX"/"UNIT" fails. The older
 * scan-ladder.test.ts / scan-loop.test.ts expectations of "case"/"piece" must move to BOX/UNIT.
 */
import * as fs from "fs";
import * as path from "path";
import { makeScanHandler } from "../lib/scan-ladder";
import type { ScanOutcome } from "../lib/scan-loop";
import type { BarcodeResolveResult } from "../lib/barcode-resolve";
import { sameScanCode } from "../lib/scan-accept-guard";

interface P {
  id?: string | null;
  barcode?: string | null;
  sku?: string | null;
  unitSku?: string | null;
  unitsPerBox?: number | null;
  barcodes?: Array<{ code: string; level: "BOX" | "UNIT" }>;
  scanMatch?: { code: string; levels: Array<"BOX" | "UNIT"> };
  name?: string;
}
const boxed: P = {
  id: "p1",
  name: "6-pack",
  barcode: "4000000000019",
  sku: "COLA-6",
  unitSku: "2000000000012",
  unitsPerBox: 6,
};

function harness(products: P[], resolve?: () => Promise<BarcodeResolveResult<P>>) {
  const accepted: Array<{ id?: string | null; level: unknown }> = [];
  const scan = makeScanHandler<P>({
    products,
    accept: (p: P, level: any): ScanOutcome => {
      accepted.push({ id: p.id, level });
      return { feedback: { kind: "added" as const, text: "ok" } };
    },
    resolve: resolve ?? (async () => ({ notFound: true })),
    onAmbiguous: () => undefined,
    onCreate: () => undefined,
  } as any);
  return { scan, accepted };
}

describe("scan ladder — level from the shared resolver (local fast path)", () => {
  it.each([
    ["barcode hit (shared BOX+UNIT on upb>1)", "4000000000019", "BOX"],
    ["sku hit", "COLA-6", "BOX"],
    ["unitSku-only hit", "2000000000012", "UNIT"],
  ])("%s -> %s", async (_n, code, level) => {
    const { scan, accepted } = harness([boxed]);
    await scan(code);
    expect(accepted).toEqual([{ id: "p1", level }]);
  });

  it("a UNIT-only ProductBarcode row code (unknown to the legacy columns) -> UNIT; a BOX-only row code -> BOX", async () => {
    const p: P = {
      ...boxed,
      barcodes: [
        { code: "ROW-U", level: "UNIT" },
        { code: "ROW-B", level: "BOX" },
      ],
    };
    const u = harness([p]);
    await u.scan("ROW-U");
    expect(u.accepted).toEqual([{ id: "p1", level: "UNIT" }]);
    const b = harness([p]);
    await b.scan("ROW-B");
    expect(b.accepted).toEqual([{ id: "p1", level: "BOX" }]);
  });

  it("a row code held at BOTH levels -> the product default unit, BOX at upb 6 (R2, SA-580b)", async () => {
    const p: P = {
      ...boxed,
      barcodes: [
        { code: "SH", level: "BOX" },
        { code: "SH", level: "UNIT" },
      ],
    };
    const { scan, accepted } = harness([p]);
    await scan("SH");
    expect(accepted).toEqual([{ id: "p1", level: "BOX" }]);
  });
});

describe("SA-595: sku/unitSku still resolve when the product has barcode rows (local fast path)", () => {
  const rows = [{ code: "ROW-U", level: "UNIT" as const }];
  it.each([
    ["unitSku hit -> UNIT (not the default BOX)", "2000000000012", 6, "UNIT"],
    ["sku hit -> BOX", "COLA-6", 6, "BOX"],
    [
      "sku hit at upb 1 keeps today's raw BOX (R4 shape is applied by the line)",
      "COLA-6",
      1,
      "BOX",
    ],
  ])("%s", async (_n, code, upb, level) => {
    const { scan, accepted } = harness([{ ...boxed, unitsPerBox: upb, barcodes: rows }]);
    await scan(code);
    expect(accepted).toEqual([{ id: "p1", level }]);
  });
});

describe("SA-595a R4: a sku hit at upb <= 1 reaches accept as BOX with no unit prompt", () => {
  it.each([
    ["upb 1", 1],
    ["upb null", null],
  ] as const)("%s -> one accept, level BOX", async (_n, upb) => {
    const { scan, accepted } = harness([{ ...boxed, unitsPerBox: upb }]);
    await scan("COLA-6");
    expect(accepted).toEqual([{ id: "p1", level: "BOX" }]);
  });
});

describe("scan ladder — a shared code on an upb<=1 product adds a UNIT (SA-580b)", () => {
  it("local shared row code, upb 1 -> UNIT; upb 6 stays BOX", async () => {
    const plain: P = {
      ...boxed,
      unitsPerBox: 1,
      barcodes: [
        { code: "SH", level: "BOX" },
        { code: "SH", level: "UNIT" },
      ],
    };
    const { scan, accepted } = harness([plain]);
    await scan("SH");
    expect(accepted).toEqual([{ id: "p1", level: "UNIT" }]);
  });

  it("shared scanMatch from the server rung, upb 1 -> UNIT", async () => {
    const remote: P = {
      ...boxed,
      unitsPerBox: 1,
      scanMatch: { code: "SH", levels: ["UNIT", "BOX"] },
    };
    const { scan, accepted } = harness(
      [],
      async () => ({ product: remote, source: "barcode" }) as any,
    );
    await scan("SH");
    expect(accepted).toEqual([{ id: "p1", level: "UNIT" }]);
  });
});

describe("SA-580c: a shared code on a units_v1 product = the picker tap as-is (NOT isDefaultSelling)", () => {
  // Follow-up (owner ruling pending): the picker tap AND the scan should honour ProductUnit.isDefaultSelling
  // together. Until then a shared code adds exactly what a tap adds: the default BOX-level line.
  it("upb 6 with a default-selling 'Piece' unit: shared code -> BOX (picker tap's default), no unit-label confirm", async () => {
    const p = {
      ...boxed,
      units: [{ label: "Piece", isDefaultSelling: true }],
      barcodes: [
        { code: "SH", level: "BOX" },
        { code: "SH", level: "UNIT" },
      ],
    } as P;
    const { scan, accepted } = harness([p]);
    await scan("SH");
    expect(accepted).toEqual([{ id: "p1", level: "BOX" }]);
  });
});

describe("scan ladder — level from the server rung", () => {
  it("uses the server's scanMatch levels (UNIT-only) when the local list misses", async () => {
    const remote: P = { ...boxed, scanMatch: { code: "ROW-U", levels: ["UNIT"] } };
    const { scan, accepted } = harness(
      [],
      async () => ({ product: remote, source: "barcode" }) as any,
    );
    await scan("ROW-U");
    expect(accepted).toEqual([{ id: "p1", level: "UNIT" }]);
  });

  it("a shared scanMatch -> the default unit, BOX at upb 6 (SA-580b)", async () => {
    const remote: P = { ...boxed, scanMatch: { code: "SH", levels: ["UNIT", "BOX"] } };
    const { scan, accepted } = harness(
      [],
      async () => ({ product: remote, source: "barcode" }) as any,
    );
    await scan("SH");
    expect(accepted).toEqual([{ id: "p1", level: "BOX" }]);
  });
});

describe("scanMatch snapshots never outlive the code that produced them (Opus blocker, #2764)", () => {
  // The server stamps scanMatch on the product the FIRST scan resolved; addOne snapshots that row and
  // the local fast path reuses the snapshot for the NEXT scan. A level list for code B must not decide
  // the level of code U.
  const snapshot = (code: string, levels: Array<"BOX" | "UNIT">): P => ({
    ...boxed,
    unitsPerBox: 24,
    barcode: "SHARED-B",
    sku: "COLA-24",
    unitSku: "UNIT-U",
    scanMatch: { code, levels },
  });

  it("box+unit code via the server (+1 case), then unitSku locally -> UNIT, not the stale [BOX, UNIT] default", async () => {
    const hit = snapshot("SHARED-B", ["UNIT", "BOX"]);
    const first = harness([], async () => ({ product: hit, source: "barcode" }) as any);
    await first.scan("SHARED-B");
    expect(first.accepted).toEqual([{ id: "p1", level: "BOX" }]);
    const second = harness([hit]); // the snapshot is now the cached row
    await second.scan("UNIT-U");
    expect(second.accepted).toEqual([{ id: "p1", level: "UNIT" }]);
  });

  it("the reverse: unitSku via the server (UNIT), then the shared code locally -> the default BOX", async () => {
    const hit = snapshot("UNIT-U", ["UNIT"]);
    const first = harness([], async () => ({ product: hit, source: "barcode" }) as any);
    await first.scan("UNIT-U");
    expect(first.accepted).toEqual([{ id: "p1", level: "UNIT" }]);
    const second = harness([hit]);
    await second.scan("SHARED-B");
    expect(second.accepted).toEqual([{ id: "p1", level: "BOX" }]);
  });

  it("a rescan of the SAME code keeps the server's levels (the guard only drops foreign snapshots)", async () => {
    const hit = snapshot("UNIT-U", ["UNIT"]);
    const again = harness([hit]);
    await again.scan("UNIT-U");
    expect(again.accepted).toEqual([{ id: "p1", level: "UNIT" }]);
  });
});

describe("scan-accept-guard sameScanCode is unchanged on the package normaliser (SA-578 test 23)", () => {
  it("still treats UPC-A and its zero-padded EAN-13 as one label, and different labels as different", () => {
    expect(sameScanCode("042100005264", "0042100005264")).toBe(true);
    expect(sameScanCode("042100005264", "036000291452")).toBe(false);
    expect(sameScanCode("", "042100005264")).toBe(false);
    expect(sameScanCode("cola-6", "COLA-6")).toBe(true);
  });

  it("imports normalizeScanCode from @routeflow/scanning directly, not via the mobile shim", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "scan-accept-guard.ts"), "utf8");
    expect(src).toMatch(/from "@routeflow\/scanning"/);
    expect(src).not.toMatch(/from "\.\/barcode-normalize"/);
  });
});

describe("no caller keeps the deleted scanUnitKind (SA-580: every caller moves to the shared resolver)", () => {
  const ROOT = path.join(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "__tests__", ".expo", "dist"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const FILES = ["app", "components", "lib"].flatMap((d) => walk(path.join(ROOT, d)));

  it("scanned a real tree (L-202)", () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("no mobile source file mentions scanUnitKind", () => {
    const offenders = FILES.filter((f) => fs.readFileSync(f, "utf8").includes("scanUnitKind")).map(
      (f) => path.relative(ROOT, f),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    "components/NewOrderScreen.tsx",
    "components/edit-items/ProductPicker.tsx",
    "app/(operator)/(tabs)/invoices/new.tsx",
    "lib/scan-ladder.ts",
  ])("%s resolves the level with the shared resolveScanSellLevel", (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    expect(src).toContain("resolveScanSellLevel");
  });

  it("the buyer scan screen does NOT apply R1: no resolveScanSellLevel there (SA-580a — default unit only, v1)", () => {
    const src = fs.readFileSync(path.join(ROOT, "app/(customer)/scan.tsx"), "utf8");
    expect(src).not.toContain("resolveScanSellLevel");
    expect(src).not.toContain("levelsForScannedCode");
  });
});
