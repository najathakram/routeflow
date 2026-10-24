import * as fs from "fs";
import * as path from "path";

/**
 * BillingShellBanner reads useSearchParams() (the ?paid=1 return from Checkout). Next's static prerender fails the
 * build ("missing Suspense boundary") unless a <Suspense> is above it; jest mocks next/navigation and cannot see that,
 * so this pins the boundary in the layout source.
 */
describe("dashboard layout: BillingShellBanner sits under a Suspense boundary", () => {
  it("wraps every <BillingShellBanner> in <React.Suspense>", () => {
    const src = fs.readFileSync(path.join(__dirname, "layout.tsx"), "utf8");
    const uses = src.match(/<BillingShellBanner\b/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    const wrapped = src.match(/<React\.Suspense[^>]*>\s*<BillingShellBanner\b/g) ?? [];
    expect(wrapped.length).toBe(uses.length);
  });
});
