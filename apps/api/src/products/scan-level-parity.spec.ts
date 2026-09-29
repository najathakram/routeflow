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
  return got?.scanMatch.levels ?? [];
}

const CODES = [
  ["legacy barcode column", "4000000000019"],
  ["sku", "COLA-6"],
  ["unitSku", "2000000000012"],
  ["row UNIT code", "ROW-U"],
  ["row BOX code", "ROW-B"],
] as const;

describe("SA-595 parity: client levelsForScannedCode == server findScanMatches", () => {
  const cases = CODES.flatMap(([name, code]) =>
    [6, 1].flatMap((upb) => [true, false].map((withRows) => [name, code, upb, withRows] as const)),
  );
  it.each(cases)("%s (%s) upb %i rows=%s", async (_n, code, upb, withRows) => {
    const p = make(upb, withRows);
    const client = levelsForScannedCode(code, p);
    const server = await serverLevels(p, code);
    expect([...client].sort()).toEqual([...server].sort());
    expect(resolveScanSellLevel(p, client)).toBe(resolveScanSellLevel(p, server));
  });
});
