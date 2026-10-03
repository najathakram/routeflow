import { readFileSync } from "fs";
import { join } from "path";
import { ProductFamiliesService } from "./product-families.service";
import { ACTOR, T, makeTx, product } from "./product-code-release.fake-tx";

/**
 * Opus #2881 B4 / F2 gap: the ONE-sorted-lock-set rule of the families writers is pinned behaviourally. The P2002
 * backstop masks a dropped or per-row lock in the DB lane, so these probes go RED on unsorted, per-row or missing code
 * locking (the same probe pattern as products.code-release-wiring.spec.ts for update()/remove()).
 */
function harness(seed: Parameters<typeof makeTx>[0]) {
  const tx = makeTx(seed);
  const locks: Array<{ kind: "code" | "name"; key: string }> = [];
  const order: string[] = [];
  // Record every advisory lock with its family + key (the fake only counts them), in issue order.
  (tx as any).$executeRaw = jest.fn((_s: TemplateStringsArray, ...values: unknown[]) => {
    const kind = values[0] === "product-barcode" ? "code" : "name";
    locks.push({ kind, key: String(values[1]) });
    order.push(`lock:${kind}`);
    return Promise.resolve(1);
  });
  const rowLock = (tx as any).$queryRaw as jest.Mock;
  (tx as any).$queryRaw = jest.fn((s: TemplateStringsArray, ...values: unknown[]) => {
    order.push(`row:${String(values[0])}`);
    return rowLock(s, ...values);
  });
  const prisma = {
    getTenantId: () => T,
    tenantTransaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    forTenant: () => tx,
  };
  const service = new ProductFamiliesService(
    prisma as never,
    { emitProductUpdated: jest.fn() } as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    { getEffectiveMode: jest.fn().mockResolvedValue("off") } as never,
  );
  const codeLocks = () =>
    locks.filter((l) => l.kind === "code").map((l) => l.key.slice(`${T}:`.length));
  return { service, tx, locks, order, codeLocks };
}
/**
 * The FIRST lock run must be the whole set, ascending (claimCodes later re-takes some of them reentrantly, which is
 * fine as long as it never takes a code OUTSIDE the set): per-row / request-order / partial locking breaks this.
 */
const expectOneSortedRun = (codes: string[], expected: string[]) => {
  const want = [...new Set(expected)].sort();
  expect(codes.slice(0, want.length)).toEqual(want);
  expect(codes.every((c) => want.includes(c))).toBe(true);
};
const v = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  pricePerUnit: "1.00",
  ...over,
});

describe("families writers take ONE sorted code-lock set", () => {
  it("POST: every code of every row is locked in one ascending run, before the name lock and any insert", async () => {
    const h = harness({ products: [] });
    await h.service.createFamily(
      {
        family: { pricePerUnit: "1.00", name: "Soda" },
        variants: [
          v("Z", { sku: "ZZ-9", barcode: "900" }),
          v("A", { sku: "AA-1", barcode: "100" }),
          v("M", { unitSku: "MM-5" }),
        ],
      } as never,
      ACTOR,
    );
    const codes = h.codeLocks();
    expectOneSortedRun(codes, ["ZZ-9", "900", "AA-1", "100", "MM-5"]); // request order Z, A, M would be RED
    const firstName = h.order.indexOf("lock:name");
    expect(firstName).toBeGreaterThan(-1);
    // every code lock precedes the first name lock (one code run, then the name), and both precede the first insert
    expect(h.order.indexOf("lock:code")).toBeLessThan(firstName);
    expect(
      h.order.slice(0, firstName).every((o) => o === "lock:code" || o.startsWith("row:")),
    ).toBe(true);
    expect(h.tx.calls.indexOf("product.create")).toBeGreaterThan(-1);
  });

  it("PATCH: the family row is locked FIRST, then ONE ascending code run (written + held codes), then name locks, then touched rows in id order", async () => {
    const fam = { ...product({ id: "fam", name: "Soda" }), kind: "FAMILY" };
    const kid = (id: string, over: Record<string, unknown> = {}) => ({
      ...product({ id, name: `Kid ${id}`, ...over }),
      kind: "VARIANT",
      parentProductId: "fam",
    });
    const h = harness({
      products: [
        fam,
        kid("k9", { sku: "K-9" }),
        kid("k1", { sku: "K-1" }),
        kid("k5", { sku: "K-5" }),
      ],
    });
    await h.service.updateVariants(
      "fam",
      {
        add: [v("Newbie", { sku: "Q-2" })],
        update: [{ id: "k9", name: "Renamed", sku: "B-1" }],
        deactivate: ["k5", "k1"],
      } as never,
      ACTOR,
    );
    const codes = h.codeLocks();
    expectOneSortedRun(codes, ["Q-2", "B-1", "K-9", "K-1", "K-5"]);
    // family row first, before the first code lock
    expect(h.order[0]).toBe("row:fam");
    expect(h.order.indexOf("row:fam")).toBeLessThan(h.order.indexOf("lock:code"));
    // the touched-row locks are taken in id order: k1, k5, k9
    const rows = h.order.filter((o) => /^row:k/.test(o));
    expect(rows.slice(0, 3)).toEqual(["row:k1", "row:k5", "row:k9"]);
  });
});

describe("families PATCH hands its locked set to every release (#2860 r3 B1)", () => {
  const src = readFileSync(join(__dirname, "product-families.service.ts"), "utf8");
  it("releaseProductCodes receives lockedCodes and the code lock precedes it", () => {
    const fn = src.slice(src.indexOf("async updateVariants("));
    expect(fn).toMatch(/releaseProductCodes\(tx, \{[^}]*lockedCodes/);
    expect(fn.indexOf("lockBarcodeCodes(tx, tenantId, lockList)")).toBeGreaterThan(-1);
    expect(fn.indexOf("lockBarcodeCodes(tx, tenantId, lockList)")).toBeLessThan(
      fn.indexOf("releaseProductCodes("),
    );
    expect(fn.indexOf("lockFamilyRow(")).toBeLessThan(fn.indexOf("lockBarcodeCodes("));
  });
  it("POST takes exactly one code-lock call (never per row)", () => {
    const fn = src.slice(
      src.indexOf("async createFamily("),
      src.indexOf("private async reattribute("),
    );
    expect((fn.match(/lockBarcodeCodes\(/g) ?? []).length).toBe(1);
  });
});
