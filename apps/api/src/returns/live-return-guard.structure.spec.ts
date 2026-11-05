/**
 * SA-1101 A-4 census: the live-return guard (`assertNoLiveReturn`, or its lock-first form `lockThenAssertNoLiveReturn`)
 * has exactly two callers, and each takes the Order row lock(s) first.
 *   - orders/deliver-again.ts   deliverAgainInTx   (Deliver again: REFUSED -> CONFIRMED; locks the Order itself)
 *   - routes/routes.service.ts  reopenStop         (Undo the stop; lockThenAssertNoLiveReturn locks the stop's Orders)
 * A third caller (the planned office DELIVERED -> CONFIRMED / PARTIALLY_DELIVERED demotion of an off-route order with a
 * live return) must be added here on purpose, with the proof that it locks the Order first.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..");
const strip = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(path.join(dir, e.name));
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)
      ? [path.join(dir, e.name)]
      : [];
  });
}

const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");
const read = (r: string) => strip(fs.readFileSync(path.join(SRC, r), "utf8"));

describe("assertNoLiveReturn census (SA-1101 A-4)", () => {
  it("is called from exactly orders/deliver-again.ts and routes/routes.service.ts, once each", () => {
    const guard = /\b(?:assertNoLiveReturn|lockThenAssertNoLiveReturn)\(/g;
    const callers = walk(SRC)
      .filter((f) => rel(f) !== "returns/live-return-guard.ts")
      .filter((f) => new RegExp(guard.source).test(strip(fs.readFileSync(f, "utf8"))))
      .map(rel)
      .sort();
    expect(callers).toEqual(["orders/deliver-again.ts", "routes/routes.service.ts"]);
    for (const r of callers) expect(read(r).match(guard)).toHaveLength(1);
  });

  it("deliverAgainInTx locks the Order row before the check; reopenStop locks the stop's Orders before the check and before anything it writes", () => {
    const again = read("orders/deliver-again.ts");
    expect(again.indexOf("FOR UPDATE")).toBeGreaterThan(0);
    expect(again.indexOf("FOR UPDATE")).toBeLessThan(again.indexOf("assertNoLiveReturn("));

    const routes = read("routes/routes.service.ts");
    const reopen = routes.slice(routes.indexOf("async reopenStop("));
    const guard = reopen.indexOf("lockThenAssertNoLiveReturn(tx, orderIds,");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(reopen.indexOf("tenantTransaction(async (tx)"));
    expect(guard).toBeLessThan(reopen.indexOf("reverseRunAdvancesInTx("));
    expect(guard).toBeLessThan(reopen.indexOf("deliveryMutation.deleteMany("));

    const wrapper = read("returns/live-return-guard.ts");
    const body = wrapper.slice(wrapper.indexOf("export async function lockThenAssertNoLiveReturn"));
    expect(body.indexOf("lockOrderRows(tx, null, orderIds)")).toBeGreaterThan(0);
    expect(body.indexOf("lockOrderRows(")).toBeLessThan(body.indexOf("assertNoLiveReturn("));
  });

  it("counts every live status: only REJECTED / CANCELLED are dead, over the given order ids", () => {
    const src = read("returns/live-return-guard.ts");
    expect(src).toContain("orderId: { in: [...orderIds] }");
    expect(src).toContain("status: { notIn: DEAD_RETURN_STATUSES }");
  });
});
