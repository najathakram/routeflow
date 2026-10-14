import { readFileSync } from "fs";
import { join } from "path";

/**
 * Opus/SA #2860 (a): the ONE-sorted-lock-set rule is pinned for EVERY deactivate path, not only update(): each of
 * update() (deactivating), remove() and clearAll() must take its code locks BEFORE the first `releaseProductCodes` and hand the
 * locked set to it. Dropping the lock (or moving it after the release) turns the matching test red: the revert probe.
 * Source-order pins, because the deadlock itself is timing-dependent (see products-code-reuse.db.spec.ts for the races).
 */
const src = readFileSync(join(__dirname, "products.service.ts"), "utf8");
const deleteSrc = readFileSync(join(__dirname, "product-delete-classify.ts"), "utf8");
const body = (startMarker: string, endMarker: string) => {
  const a = src.indexOf(startMarker);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(endMarker, a + startMarker.length);
  return src.slice(a, b === -1 ? undefined : b);
};

describe("every deactivate path locks its codes (one sorted set) BEFORE releasing them", () => {
  it("update(): lockBarcodeCodes(lockList) precedes releaseProductCodes, which receives lockedCodes", () => {
    const fn = body("async update(", "async remove(");
    expect(fn.indexOf("lockBarcodeCodes(tx, tenantId, lockList)")).toBeGreaterThan(-1);
    expect(fn.indexOf("lockBarcodeCodes(tx, tenantId, lockList)")).toBeLessThan(
      fn.indexOf("releaseProductCodes("),
    );
    expect(fn).toMatch(/releaseProductCodes\(tx, \{[^}]*lockedCodes: new Set\(lockList\)/);
  });

  it("remove(): peek + ONE lockBarcodeCodes precede releaseProductCodes, which receives lockedCodes", () => {
    const fn = body("async remove(", "async clearAll(");
    const lock = fn.indexOf("lockBarcodeCodes(");
    expect(lock).toBeGreaterThan(-1);
    expect(fn.indexOf("peekProductCodes(")).toBeLessThan(lock);
    expect(lock).toBeLessThan(fn.indexOf("releaseProductCodes("));
    expect(fn).toMatch(/releaseProductCodes\(tx, \{[^}]*lockedCodes/);
  });

  it("the soft-delete path (clearAll / bulkDelete): ONE lockCodesOfProducts over EVERY id precedes the row locks and the per-id releases, which receive lockedCodes", () => {
    const fn = deleteSrc.slice(deleteSrc.indexOf("export async function applyProductDelete("));
    const lock = fn.indexOf("lockCodesOfProducts(");
    expect(lock).toBeGreaterThan(-1);
    // house order: code advisory locks, THEN the product rows, THEN the authoritative classification
    expect(lock).toBeLessThan(fn.indexOf("lockProductsForDelete("));
    expect(fn.indexOf("lockProductsForDelete(")).toBeLessThan(fn.indexOf("planProductDelete("));
    expect(lock).toBeLessThan(fn.indexOf("releaseProductCodes("));
    expect(fn).toMatch(/releaseProductCodes\(tx, \{[^}]*lockedCodes/);
    // never lock-then-release per product inside the loop
    expect((fn.match(/lockBarcodeCodes\(/g) ?? []).length).toBe(0);
  });
});
