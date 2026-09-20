/**
 * Lane B A3 F7 — the platform-admin console's phone/tablet tap-target floor (audit 2026-09-20:
 * nav menu button, "+ Create Tenant", "View all", row actions all under 40 px at <= 768 px).
 * A static net, not a measurement: the shared rule must exist and stay scoped to the admin
 * surface, the hamburger must be 40 px square, and plain text links (which the rule deliberately
 * does not touch) must keep their `max-[768px]:min-h-10` opt-in. Browser proof is the prover's job.
 */
import * as fs from "fs";
import * as path from "path";

const WEB = path.join(__dirname, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

describe("platform-admin tap targets (F7)", () => {
  const css = read("app/globals.css");

  it("globals.css floors admin buttons and button-styled links at 40 px on small screens", () => {
    const block = css
      .match(/@media \(max-width: 768px\) \{[\s\S]*?\n\}\n/g)
      ?.find((b) => b.includes(".surface-admin"));
    expect(block).toBeDefined();
    expect(block).toMatch(
      /\.surface-admin button,\s*\.surface-admin a\[class\*="rounded"\]\s*\{\s*min-height: 40px;/,
    );
    expect(block).toMatch(
      /a\[class\*="rounded"\]:not\(\[class\*="hidden"\]\)\s*\{\s*display: flex;\s*align-items: center;/,
    );
    expect(block).toMatch(/\.surface-admin button:has\(> svg:only-child\)\s*\{\s*min-width: 40px;/);
  });

  it("the admin layout is the .surface-admin scope and its hamburger is 40 px square", () => {
    const layout = read("app/(platform-admin)/layout.tsx");
    expect(layout).toContain("surface-admin");
    // both hamburgers (the drawer-open one and the top bar one)
    expect(layout.match(/rounded-lg p-2\.5 text-slate-400/g)?.length).toBe(2);
    expect(layout).not.toMatch(/rounded-lg p-2 text-slate-400/);
  });

  it.each([
    ["app/(platform-admin)/admin/dashboard/page.tsx", 3],
    ["app/(platform-admin)/admin/tenants/[id]/page.tsx", 2],
    ["app/(platform-admin)/admin/tenants/new/page.tsx", 1],
    ["app/(platform-admin)/admin/buyers/page.tsx", 1],
  ])("%s keeps %i plain text link(s) on the 768 px tap-target opt-in", (file, n) => {
    const hits = read(file).match(/max-\[768px\]:min-h-10/g) ?? [];
    expect(hits.length).toBe(n);
  });
});
