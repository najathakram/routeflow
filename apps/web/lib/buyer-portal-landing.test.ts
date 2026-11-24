/**
 * W-1296: the sidebar seller switcher and the seller list on /buyer/portal land the same way,
 * through the portal home (SA-1211 A1.2: 0 counted orders -> Invoices, else Orders). One helper
 * builds that href; both entry points must call it and neither may hardcode the dashboard route.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sellerLandingHref } from "./buyer-portal-landing";

describe("sellerLandingHref", () => {
  it("goes through the portal home with then=orders", () => {
    expect(sellerLandingHref("acme")).toBe("/buyer/portal/acme?then=orders");
  });
});

describe("both seller entry points use the helper", () => {
  const portalDir = join(__dirname, "..", "app", "buyer", "portal");
  const files = ["layout.tsx", "page.tsx"];

  it.each(files)("%s calls sellerLandingHref once and never hardcodes /dashboard", (file) => {
    const src = readFileSync(join(portalDir, file), "utf8");
    expect(src.match(/sellerLandingHref\(/g)).toHaveLength(1);
    expect(src).not.toContain("`/buyer/portal/${seller.tenant.slug}/dashboard`");
  });
});
