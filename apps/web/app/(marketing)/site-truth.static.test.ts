/**
 * @jest-environment node
 */
// Site audit 2026-11-02 §3 and §7: sentences on the public pages that the code does not back. Each one is pinned to
// what the code says, so a wording pass cannot bring the false version back. Evidence is in the comment above each.
import * as fs from "fs";
import * as path from "path";

const SITE = path.resolve(__dirname, "../../public/site");
const page = (name: string) => fs.readFileSync(path.join(SITE, `${name}.html`), "utf8");

describe("public site sentences the code backs", () => {
  // order-status-invoicing.ts / pending-mirror.ts: an order's invoice is locked until the order is DELIVERED, or SHIPPED on
  // a shipping account. There is no "ready" step that unlocks it, and a delivery-only sentence is wrong for a carrier order.
  it("landing: the invoice follows delivery or shipment, never 'ready' or delivery alone", () => {
    const html = page("landing");
    expect(html).toContain("<h3>The order is delivered or shipped.</h3>");
    expect(html).not.toContain("<h3>The order is delivered.</h3>");
    expect(html).not.toMatch(/The order is ready/i);
  });

  // plan-catalog-v11.definitions.ts: Starter $99, Growth $249, Scale $499, Enterprise custom. $99 is the lowest, not the price.
  it("landing: the headline price is a starting price", () => {
    const html = page("landing");
    expect(html).toContain('<h2 id="p">From $99 a month.');
    expect(html).not.toContain('<h2 id="p">$99 a month.');
  });

  // orders.service.ts creditGate reads credit_limit.enforce_new_orders (off, no tenant screen sets it); only order edits and
  // change requests always block. The counter shows the overage for information only.
  it("product: credit limits stop a change to an order, not a new order", () => {
    const html = page("product");
    expect(html).toContain("RouteFlow stops a change to an order that takes the store over it.");
    expect(html).not.toMatch(/stop the order/i);
  });

  // plan-catalog-v11.definitions.ts: logins differ too (3 / 10 / 25), and logins over the limit can be switched off on downgrade.
  it("home, pricing, product: plans differ by customers and logins, not customers alone", () => {
    for (const name of ["home", "pricing", "product"]) {
      const html = page(name);
      expect(html).toMatch(/The plans differ by how many customers and logins they include\./);
      expect(html).not.toMatch(/differ by how many customers they include/);
    }
  });

  // /login offers "Continue with Google" (auth.controller.ts); only company single sign-on is absent (feature-registry.ts).
  it("does-and-doesnt: names Google sign-in and rules out only company single sign-on", () => {
    const html = page("does-and-doesnt");
    expect(html).toMatch(/You sign in with a password or a Google account/);
    expect(html).toContain("company single sign-on");
    expect(html).not.toMatch(/None of these are in RouteFlow\.<\/td>/);
  });

  // inventory.service.ts: weighted average by default; settings offers Last cost. The screen label is not "Give back as".
  it("does-and-doesnt, product: cost is a weighted average by default, with last cost as the other choice", () => {
    for (const name of ["does-and-doesnt", "product"]) {
      expect(page(name)).toContain("weighted average by default. You can switch to last cost.");
    }
    for (const name of ["home", "product", "getting-started"]) {
      expect(page(name)).not.toMatch(/Give back as/);
    }
  });

  // apps/mobile/app/_layout.tsx: a pure DRIVER on a tenant without the staff-only developer_mode add-on lands on the
  // "Desktop Only" screen, so a new account's driver has no phone app. The web StopSheet (routes/my-runs) starts or skips a
  // stop; its "Delivered / Refused / Collect payment" button is disabled. Photo and signature exist only in the native app.
  it("drivers: the pages say what a new account's driver can do on the web, not the phone app", () => {
    for (const name of [
      "home",
      "pricing",
      "product",
      "getting-started",
      "security",
      "does-and-doesnt",
    ]) {
      const html = page(name);
      expect(html).not.toMatch(/phone app/i);
      expect(html).not.toMatch(/driver app/i);
      expect(html).not.toMatch(/with no signal/i);
      expect(html).not.toMatch(/the driver (can take|takes) a (photo|signature)/i);
      expect(html).not.toMatch(/Complete stop/);
    }
    expect(page("product")).toContain("drivers can’t finish a stop");
    expect(page("product")).toContain("Staff mark the order delivered.");
    expect(page("home")).toContain(
      "Drivers see the stops on the web and can start or skip a stop.",
    );
    expect(page("getting-started")).toContain("Drivers sign in on the web and see their route.");
  });

  // The only path that records a short delivery is the driver app's stop-complete call (routes.controller.ts
  // POST :id/stops/:stopId/complete); the web has no per-line delivered quantity, and "mark delivered" stamps the full
  // quantity. So a new account's staff cannot make a draft invoice follow a short delivery, and the pages must not say it.
  it("home, product: no claim that the invoice follows what was delivered", () => {
    for (const name of ["home", "product"]) {
      expect(page(name)).not.toMatch(/what was delivered/i);
    }
    expect(page("home")).not.toContain("jr-upd");
    expect(page("product")).toContain("Delivering the order unlocks its invoice.");
  });
});
