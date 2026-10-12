/** Row 262 wiring pins: the editor sends the opened revision and owns the stale 409 (no toast). */
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const screen = read("app/(operator)/(tabs)/orders/[id]/edit-items.tsx");

describe("edit-items stale revision wiring", () => {
  it("spreads the opened revision into the save and handles the stale 409 before any toast", () => {
    expect(screen).toContain("useOrderStaleRevision(order, id, rebase)");
    expect(screen).toContain("...stale.body()");
    const onError = screen.slice(screen.indexOf("onError: (e: any) =>"));
    expect(onError.indexOf("stale.capture(e)")).toBeGreaterThan(-1);
    expect(onError.indexOf("stale.capture(e)")).toBeLessThan(onError.indexOf("showToast("));
    expect(screen).toContain("{stale.node}");
  });
  it("the mutation sends expectedRevisionNumber only via the guard helper", () => {
    const api = read("lib/api/orders.ts");
    expect(api).toContain("...expectedRevisionBody(expectedRevisionNumber)");
  });
  it("reload refetches without resetting local edit state", () => {
    const c = read("components/edit-items/StaleOrderNotice.tsx");
    expect(c).toContain("refetchQueries");
    expect(c).not.toMatch(/hydrateFromOrder/);
  });
  it("diffs and hydrates against the order as opened, not the refetched one", () => {
    expect(screen).toContain("stale.baseline as unknown as BaselineOrderLike");
    expect(screen).not.toContain("hydrateFromOrder(order)");
    const c = read("components/edit-items/StaleOrderNotice.tsx");
    expect(c).toContain("rebaseEditOnReload");
  });
});
