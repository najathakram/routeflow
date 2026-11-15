import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * SA-1149 D2-8: every write of an existing line's quantity below what was delivered goes through ONE helper,
 * `assertQtyNotBelowDelivered`. Count pin: a new writer of an existing line's qty must call it (and bump this count).
 */
const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const calls = (src: string) => src.match(/assertQtyNotBelowDelivered\(/g)?.length ?? 0;

describe("quantity floor call sites (SA-1149 D2-8)", () => {
  it("is defined once, in delivered-line-lock.ts", () => {
    expect(read("delivered-line-lock.ts")).toMatch(/export function assertQtyNotBelowDelivered\(/);
  });

  it.each([
    ["orders.service.ts", 1, "the per-line UPDATE, after normalizeBoxesPieces"],
    ["unit-line-edit.ts", 1, "updateUnitLine (unit-aware lines, non-substitute)"],
    ["delivered-stamp.ts", 1, "the replace-all recreated carry"],
  ])("%s calls it %i time(s): %s", (file, n) => {
    expect(calls(read(file))).toBe(n);
  });

  it("the per-line UPDATE call sits after the qty<=0 skip and before the price work", () => {
    const src = read("orders.service.ts");
    const skip = src.indexOf(
      "if (qty <= 0) continue;\n                assertQtyNotBelowDelivered(",
    );
    expect(skip).toBeGreaterThan(0);
  });
});

/**
 * SA-1149 round 2, pins P-a to P-e (they replace the D2-21 body, which any later deleteMany satisfied).
 * The replace-all refusal is thrown once; both replace sites mark and delete as ADJACENT statements; every
 * `orderItem.deleteMany(` in the api is known; the merge predicate is one fragment read by every merge path.
 */
const SRC = join(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}
const FILES = walk(SRC);
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, "/");
const text = (f: string) => readFileSync(join(SRC, f), "utf8");
/** Identifier uses outside import statements and comment lines. */
const uses = (src: string, ident: string) =>
  src
    .replace(/import[\s\S]*?from "[^"]+";/g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
    .match(new RegExp(ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length ?? 0;
const countAcross = (ident: string) =>
  Object.fromEntries(
    FILES.map((f): [string, number] => [rel(f), uses(readFileSync(f, "utf8"), ident)]).filter(
      ([, n]) => n > 0,
    ),
  );

describe("replace-all refusal and line-delete pins (SA-1149 P-a..P-e)", () => {
  it("P-a: at each replace site the delete is the very next statement after markLinesRecreated (exactly 2)", () => {
    const src = text("orders/orders.service.ts");
    const sites = src.match(
      /lineIdentity = await markLinesRecreated\(tx, orderId, heldItems\);[^\n]*\n\s*await tx\.orderItem\.deleteMany\(/g,
    );
    expect(sites).toHaveLength(2);
  });

  it("P-b: every orderItem.deleteMany( in non-spec api source is a known site", () => {
    expect(countAcross("orderItem.deleteMany(")).toEqual({
      "customers/customers.service.ts": 3, // customer delete and merge cleanups (no order is merged here)
      "inventory/testing/order-stock-world.ts": 1, // test harness teardown
      "orders/merge-lock-recheck.ts": 1, // the guarded loser delete (never a delivered line, P-d)
      "orders/order-line-removal.ts": 1, // a removal of a non-delivered line
      "orders/orders.service.ts": 3, // the two marked replace sites and the order hard delete
      "orders/testing/merge-recheck.ts": 1, // test harness
      "orders/testing/units-fold-db-harness.ts": 1, // test harness
    });
  });

  it("markLinesRecreated is defined once, in delivered-stamp.ts, and called twice, both in orders.service.ts", () => {
    expect(
      text("orders/delivered-stamp.ts").match(/export async function markLinesRecreated\(/g),
    ).toHaveLength(1);
    expect(countAcross("markLinesRecreated(")).toEqual({
      "orders/delivered-stamp.ts": 1,
      "orders/orders.service.ts": 2,
    });
  });

  it("P-c: the code is thrown from delivered-stamp.ts only, keyed once, two throw sites", () => {
    expect(countAcross("API_ERROR_CODES.ORDER_EDIT_DELIVERED_LINES")).toEqual({
      "orders/delivered-stamp.ts": 1,
    });
    expect(text("common/api-error-codes.ts").match(/ORDER_EDIT_DELIVERED_LINES:/g)).toHaveLength(1);
    expect(
      text("orders/delivered-stamp.ts").match(/throw deliveredLinesReplaced\(\)/g),
    ).toHaveLength(2);
  });

  it("P-d: the merge fragment is defined once and used once in orders.service, twice in merge-lock-recheck", () => {
    expect(countAcross("ORDER_HAS_NO_LIVE_DELIVERED_LINE")).toEqual({
      "orders/delivered-line-lock.ts": 1,
      "orders/orders.service.ts": 1,
      "orders/merge-lock-recheck.ts": 2,
    });
    expect(countAcross("isLiveDeliveredLine")).toEqual({
      "orders/delivered-line-lock.ts": 1,
      "orders/delivered-stamp.ts": 1,
    });
  });

  it("P-e: the sweep's candidate where is mergeEligibleWhere, never a local copy", () => {
    const src = text("orders/order-sweep.ts");
    expect(src.match(/mergeEligibleWhere\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/status: OrderStatus\.PENDING/);
  });

  it("P-f: heldAtBookedFloor( is called once in orders.service.ts, and both edit-site floors read flooredDelivered", () => {
    const svc = text("orders/orders.service.ts");
    const unit = text("orders/unit-line-edit.ts");
    expect(uses(svc, "heldAtBookedFloor(")).toBe(1);
    // the each-unit floor and the unit-line floor: the delivered argument is the floored row
    expect(svc).toMatch(/assertQtyNotBelowDelivered\(\s*flooredDelivered\.get\(li\.id\)/);
    expect(unit).toMatch(/assertQtyNotBelowDelivered\(\s*ctx\.flooredDelivered\.get\(lineId\)/);
    // the two edit sites; the carry net in delivered-stamp.ts is outside the count
    expect(
      uses(svc, "assertQtyNotBelowDelivered(") + uses(unit, "assertQtyNotBelowDelivered("),
    ).toBe(2);
  });
});

/** SA-1149 20:55Z: round 1's `delivered` seed (a DELIVERED line with d below qty and no evidence) must not come back. */
describe("a2 delivered-line spec seed", () => {
  it("has no delivered: seed key and no SeedShape.delivered", () => {
    const src = readFileSync(join(__dirname, "a2-delivered-line-live-pack.db.spec.ts"), "utf8");
    expect(src).not.toMatch(/\{[^}]*\bdelivered: \d+/);
    expect(src).not.toMatch(/shape\.delivered/);
    expect(src).not.toMatch(/^\s*delivered\?: number/m);
    expect(src.match(/shortRouteDrop\(await seed\(/g)?.length).toBe(7);
  });
});
