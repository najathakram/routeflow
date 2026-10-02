/**
 * SA-626: a SHARED barcode (resolves at both levels) adds the product's default selling unit on the mobile scan too,
 * through the same @routeflow/scanning rule web uses. A box-only / unit-only code never asks for it (the code decides).
 */
import { makeScanHandler } from "../lib/scan-ladder";
import type { ScanOutcome } from "../lib/scan-loop";
import type { BarcodeResolveResult } from "../lib/barcode-resolve";

interface P {
  id: string;
  name: string;
  barcode?: string | null;
  sku?: string | null;
  unitSku?: string | null;
  unitsPerBox?: number | null;
}

const SHARED_CODE = "4000000000019"; // legacy barcode on a boxed product: BOX + UNIT
const PIECE_CODE = "2000000000012"; // unitSku: UNIT only
const BOX_SKU = "CASE-6PK"; // sku: BOX only
const boxed: P = {
  id: "p1",
  name: "6-pack",
  barcode: SHARED_CODE,
  unitSku: PIECE_CODE,
  sku: BOX_SKU,
  unitsPerBox: 6,
};

function run(code: string, over: Partial<Parameters<typeof makeScanHandler<P>>[0]> = {}) {
  const accepted: Array<{ level: string; opts: unknown }> = [];
  const handler = makeScanHandler<P>({
    products: [boxed],
    accept: (_p, level, opts): ScanOutcome => {
      accepted.push({ level, opts });
      return { feedback: { kind: "added" as const, text: "ok" } };
    },
    resolve: async (): Promise<BarcodeResolveResult<P>> => ({ notFound: true }),
    onAmbiguous: () => undefined,
    ...over,
  });
  return handler(code).then(() => accepted);
}

describe("scan ladder: shared code starts on the default unit (SA-626)", () => {
  it("a shared code asks the screen to start on the default unit", async () => {
    expect(await run(SHARED_CODE)).toEqual([
      { level: "BOX", opts: { startOnDefault: true, code: SHARED_CODE } },
    ]);
  });

  it("every accept carries the scanned code (a repeat of the SAME label is told apart from another)", async () => {
    expect((await run(PIECE_CODE))[0].opts).toMatchObject({ code: PIECE_CODE });
  });

  it("a unit-only code does not", async () => {
    expect(await run(PIECE_CODE)).toEqual([{ level: "UNIT", opts: { code: PIECE_CODE } }]);
  });

  it("a box-only code does not", async () => {
    expect(await run(BOX_SKU)).toEqual([{ level: "BOX", opts: { code: BOX_SKU } }]);
  });

  it("the server-resolved hit follows the same rule", async () => {
    const resolve = async (): Promise<BarcodeResolveResult<P>> => ({
      product: boxed,
      source: "barcode",
    });
    expect(await run(SHARED_CODE, { products: [], resolve })).toEqual([
      { level: "BOX", opts: { startOnDefault: true, code: SHARED_CODE } },
    ]);
  });
});
