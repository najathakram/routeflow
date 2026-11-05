/**
 * B1103 / SA-1104 (B-6) - the price an add-on row is written at has ONE home.
 *
 * `subscribe()` once wrote `meta.monthlyPrice` (the catalog price) straight into the row and onto the ledger, ignoring
 * that the target plan INCLUDES the SKU; SA-786/787's $0 was overwritten on every re-listed, bundled add-on. The class
 * is "a TenantAddon row is written at a price no rule judged". So, under `apps/api/src` (specs excluded):
 *   - `upsertAddonRowTx` takes the price as a REQUIRED `price` parameter, and its `create` / `update` literals may not
 *     carry `priceSnapshot` (so a caller that skips the parameter fails to compile, not to review);
 *   - every call site passes `price:`;
 *   - `subscription-mutation.service.ts` never reads a catalog price off a SKU definition directly into a row
 *     (`meta.monthlyPrice`): the subscribe loop takes `priceAtPlan(...)`, whose verdict is `stopBilling`'s.
 * Shaped like `tenant-addon-writer.pin.spec.ts`: comments blanked, the detector has a self-test, an empty scan fails.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  API_SRC_ROOT,
  codeOnly,
  collectSourceFiles,
  findCalls,
  scanSource,
} from "../testing/source-scan";

const WRITER = "billing/tenant-addon-writer.ts";
const SUBSCRIBE = "billing/subscription-mutation.service.ts";
const UPSERT = /\bupsertAddonRowTx\s*\(/;
const HAS_PRICE_KEY = /(^|[\s{,])price\s*[:,}]/;
const HAS_PRICE_SNAPSHOT_KEY = /\bpriceSnapshot\s*:/;

/** The `a: { ... }` argument type of `upsertAddonRowTx`, comments blanked. */
function upsertParamType(): string {
  const code = codeOnly(fs.readFileSync(path.join(API_SRC_ROOT, WRITER), "utf8"));
  const at = code.indexOf("export async function upsertAddonRowTx");
  return at < 0 ? "" : code.slice(at, code.indexOf("\n) {", at) + 4);
}

describe("B1103 / SA-1104 - one home for the price of an add-on row", () => {
  it("walks a non-trivial number of source files and finds the upsert call sites (an empty scan must not read green)", () => {
    expect(collectSourceFiles().length).toBeGreaterThan(200);
    expect(scanSource(UPSERT).filter((s) => s.file !== WRITER).length).toBeGreaterThanOrEqual(3);
  });

  it("the detector flags a call with no price key and a call that writes priceSnapshot, and ignores a comment", () => {
    const planted = `
      class Bad {
        async noPrice(tx: any) {
          await upsertAddonRowTx(tx, ev, { tenantId, addonKey, create: { active: true }, update: {}, actor });
        }
        async direct(tx: any) {
          await upsertAddonRowTx(tx, ev, { price: 1, create: { priceSnapshot: 5 }, update: {}, actor });
        }
        async fine(tx: any) {
          // await upsertAddonRowTx(tx, ev, { create: {} });
          await upsertAddonRowTx(tx, ev, { price, create: { active: true }, update: {}, actor });
        }
      }`.replace(/^ {6}/gm, "");
    const sites = findCalls("billing/planted.ts", planted, UPSERT);
    expect(sites.map((s) => s.fn)).toEqual(["noPrice", "direct", "fine"]);
    expect(sites.map((s) => HAS_PRICE_KEY.test(s.args))).toEqual([false, true, true]);
    expect(sites.map((s) => HAS_PRICE_SNAPSHOT_KEY.test(s.args))).toEqual([false, true, false]);
  });

  it("`upsertAddonRowTx` takes a REQUIRED `price: number` and its create/update cannot carry priceSnapshot", () => {
    const type = upsertParamType();
    expect(type).not.toBe("");
    expect(type).toMatch(/\bprice\s*:\s*number\b/);
    expect(type).toMatch(/Omit<[^>]*"priceSnapshot"/);
  });

  it("every upsertAddonRowTx call passes `price:` and none writes `priceSnapshot:` itself", () => {
    const sites = scanSource(UPSERT).filter((s) => s.file !== WRITER);
    expect(
      sites.filter((s) => !HAS_PRICE_KEY.test(s.args)).map((s) => `${s.file}#${s.fn}:${s.line}`),
    ).toEqual([]);
    expect(
      sites
        .filter((s) => HAS_PRICE_SNAPSHOT_KEY.test(s.args))
        .map((s) => `${s.file}#${s.fn}:${s.line}`),
    ).toEqual([]);
  });

  it("subscription-mutation.service.ts writes no catalog price off a SKU definition (`meta.monthlyPrice`)", () => {
    const code = codeOnly(fs.readFileSync(path.join(API_SRC_ROOT, SUBSCRIBE), "utf8"));
    const lines = code
      .split("\n")
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /\bmeta\.monthlyPrice\b/.test(l))
      .map(({ n }) => `${SUBSCRIBE}:${n}`);
    expect(lines).toEqual([]);
  });
});
