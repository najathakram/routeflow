/**
 * SA-595 — client/server PARITY for the scan level. The same product + scanned code must give the
 * same level through the client path (levelsForScannedCode -> resolveScanSellLevel, what mobile's
 * local fast path and web's cached list use) and the server path (findScanMatches scanMatch.levels
 * -> the same resolver). Table-driven over one shared fixture set.
 */
import { levelsForScannedCode, normalizeScanCode, resolveScanSellLevel } from "@routeflow/scanning";
import type { SellLevel } from "@routeflow/pricing";
import { findScanMatches } from "./scan-match";

const ROWS = [
  { code: "ROW-U", level: "UNIT" as SellLevel },
  { code: "ROW-B", level: "BOX" as SellLevel },
];

const make = (upb: number, withRows: boolean) => ({
  id: "p1",
  name: "Sample Cola",
  isActive: true,
  barcode: "4000000000019",
  sku: "COLA-6",
  unitSku: "2000000000012",
  unitsPerBox: upb,
  barcodes: withRows
    ? ROWS.map((r) => ({ ...r, productId: "p1", symbology: "CODE128", origin: "ENTERED" }))
    : [],
});

async function serverLevels(product: ReturnType<typeof make>, code: string) {
  const db = {
    productBarcode: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          product.barcodes.filter((r) => normalizeScanCode(code).includes(r.code)),
        ),
    },
    product: { findMany: jest.fn().mockResolvedValue([product]) },
  };
  const got = await findScanMatches(db, normalizeScanCode(code));
  return (got?.scanMatch.levels ?? []) as SellLevel[];
}

const CODES = [
  ["legacy barcode column", "4000000000019"],
  ["sku", "COLA-6"],
  ["unitSku", "2000000000012"],
  ["row UNIT code", "ROW-U"],
  ["row BOX code", "ROW-B"],
] as const;

// Independent literal expectations (NOT derived from either path), keyed "code|upb|withRows":
// a regression in the shared levelsForScannedCode fails here even though both paths call it.
const EXPECTED: Record<string, SellLevel[]> = {
  "4000000000019|6|false": ["BOX", "UNIT"],
  "4000000000019|6|true": [],
  "4000000000019|1|false": ["UNIT"],
  "4000000000019|1|true": [],
  "COLA-6|6|false": ["BOX"],
  "COLA-6|6|true": ["BOX"],
  "COLA-6|1|false": ["BOX"],
  "COLA-6|1|true": ["BOX"],
  "2000000000012|6|false": ["UNIT"],
  "2000000000012|6|true": ["UNIT"],
  "2000000000012|1|false": ["UNIT"],
  "2000000000012|1|true": ["UNIT"],
  "ROW-U|6|true": ["UNIT"],
  "ROW-U|1|true": ["UNIT"],
  "ROW-B|6|true": ["BOX"],
  "ROW-B|1|true": ["BOX"],
};

describe("SA-595 parity: client levelsForScannedCode == server findScanMatches", () => {
  const cases = CODES.flatMap(([name, code]) =>
    [6, 1].flatMap((upb) => [true, false].map((withRows) => [name, code, upb, withRows] as const)),
  );
  it.each(cases)("%s (%s) upb %i rows=%s", async (_n, code, upb, withRows) => {
    const p = make(upb, withRows);
    const client = levelsForScannedCode(code, p);
    const server = await serverLevels(p, code);
    const expected = EXPECTED[`${code}|${upb}|${withRows}`] ?? [];
    expect([...client].sort()).toEqual([...expected].sort());
    expect([...server].sort()).toEqual([...expected].sort());
    expect([...client].sort()).toEqual([...server].sort());
    expect(resolveScanSellLevel(p, client)).toBe(resolveScanSellLevel(p, server));
  });
});
