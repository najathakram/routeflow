import fs from "node:fs";
import path from "node:path";

/**
 * SA-1063 MUST 10 — a pin in the `no-bare-cron.spec.ts` style. `notifyStaffEvent` was built with no production
 * caller (#2822), so env `on` plus a policy of `on` still sent nothing. Every route a CUSTOMER principal reaches
 * that creates, edits or cancels an order must tell the office, and a NEW such route must fail this spec until it
 * does. The handler text is read from source (a dependency-injected mock proves the call, not that a route exists).
 */
const SRC = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** One chunk per route decorator: the decorators and body up to the next route decorator. */
function handlers(file: string): Array<{ route: string; body: string }> {
  const src = strip(read(file));
  const marks = [...src.matchAll(/^ {2}@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/gm)];
  return marks.map((m, i) => ({
    route: `${m[1].toUpperCase()} ${m[2].replace(/["']/g, "") || "/"}`,
    body: src.slice(m.index!, i + 1 < marks.length ? marks[i + 1].index : src.length),
  }));
}

/** A call into the order write path that a customer's request can reach. */
const WRITES_ORDER =
  /(ordersService\.(create|updateOrderItems|changeStatus)\(|templatesService\.generateOrder\(|service\.generateOrderForUser\()/;
/** The call that tells the office (`?.` because the controller's dependency is optional). */
const TELLS_OFFICE = /(staffOrderEmail\??\.(notify|orderIsDraft)|tellOfficeOfCustomerOrder\()/;

/** Handlers that call the order write path but are not a customer's create / edit / cancel. */
const EXEMPT: Record<string, string[]> = {
  "buyer/buyer.controller.ts": [],
  "orders/orders.controller.ts": [],
  "order-templates/order-templates.controller.ts": [],
};

describe("SA-1063: every customer order write route tells the office", () => {
  for (const [file, exempt] of Object.entries(EXEMPT)) {
    const all = handlers(file);

    it(`${file}: the scan finds route handlers (a spec that finds nothing must fail)`, () => {
      expect(all.length).toBeGreaterThan(3);
    });

    it(`${file}: each handler that writes an order names the staff order email call`, () => {
      const writers = all.filter((h) => WRITES_ORDER.test(h.body) && !exempt.includes(h.route));
      expect(writers.length).toBeGreaterThan(0);
      const missing = writers.filter((h) => !TELLS_OFFICE.test(h.body)).map((h) => h.route);
      expect(missing).toEqual([]);
    });
  }

  it("the nine routes of the spec are all present (id of each by decorator path)", () => {
    const has = (file: string, route: string) =>
      expect(handlers(file).map((h) => h.route)).toContain(route);
    has("buyer/buyer.controller.ts", "POST orders");
    has("buyer/buyer.controller.ts", "PATCH orders/:id/items");
    has("buyer/buyer.controller.ts", "POST orders/:id/cancel");
    has("buyer/buyer.controller.ts", "POST templates/:id/reorder");
    has("orders/orders.controller.ts", "POST /");
    has("orders/orders.controller.ts", "PATCH :id/status");
    has("orders/orders.controller.ts", "PATCH :id/items");
    has("order-templates/order-templates.controller.ts", "POST :id/generate");
  });

  it("add-all-low delegates to POST buyer/orders and calls no order write itself", () => {
    const h = handlers("buyer/buyer.controller.ts").find((x) => x.route.includes("add-all-low"));
    expect(h).toBeDefined();
    expect(WRITES_ORDER.test(h!.body)).toBe(false);
  });

  it("the modules that own these controllers import MessagingModule (so the dependency resolves)", () => {
    for (const mod of [
      "buyer/buyer.module.ts",
      "orders/orders.module.ts",
      "order-templates/order-templates.module.ts",
    ]) {
      expect(strip(read(mod))).toMatch(/imports:\s*\[[\s\S]*\bMessagingModule\b[\s\S]*\]/);
    }
  });

  it("the staff-facing controllers only tell the office for a CUSTOMER principal", () => {
    const orders = strip(read("orders/orders.controller.ts"));
    expect(orders).toMatch(/user\.role === UserRole\.CUSTOMER/);
    const tpl = strip(read("order-templates/order-templates.controller.ts"));
    expect(tpl).toMatch(/user\.role === UserRole\.CUSTOMER && order\?\.id/);
  });
});
