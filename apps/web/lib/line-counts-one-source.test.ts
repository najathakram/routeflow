/**
 * W-1185 — the count of an order's or invoice's lines and units ("12 lines · 30 boxes · 6 pcs") has ONE source:
 * `summarizeLineCounts` / `formatLineCounts` / `formatLineWord` in `@routeflow/pricing` (`line-counts.ts`).
 * Six surfaces read it (web invoice, web order, order builder, till, invoice PDF, invoice email); a hand-rolled
 * copy is how `summarizeQtyByUnit` and three "N lines" words drifted apart. This pin fails when the old helper
 * returns, when a surface stops using the shared one, or when a second line word is defined.
 *
 * Reads source from the repo root. Excluded: spec/test files and node_modules/.next/dist. Zero files found fails
 * (no fail-open).
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function collect(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist", "coverage"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name))
      out.push(full);
  }
  return out;
}

const sources = [
  ...collect(path.join(ROOT, "apps/web")),
  ...collect(path.join(ROOT, "apps/api/src")),
];
const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");
const read = (f: string) => fs.readFileSync(f, "utf8");

const SURFACES = [
  "apps/web/app/(dashboard)/invoices/[id]/page.tsx",
  "apps/web/app/(dashboard)/orders/[id]/page.tsx",
  "apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx",
  "apps/web/app/(dashboard)/orders/_components/CounterSaleScreen.tsx",
  "apps/api/src/invoices/invoice-pdf-template.tsx",
  "apps/api/src/email/email.service.ts",
];

describe("W-1185 line counts have one source", () => {
  it("scans real files (no fail-open)", () => {
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.some((f) => rel(f).startsWith("apps/web/"))).toBe(true);
    expect(sources.some((f) => rel(f).startsWith("apps/api/src/"))).toBe(true);
  });

  it("summarizeQtyByUnit is gone from the web app and the api", () => {
    const hits = sources.filter((f) => read(f).includes("summarizeQtyByUnit")).map(rel);
    expect(hits).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, "apps/web/lib/order-qty-summary.ts"))).toBe(false);
  });

  it.each(SURFACES)("%s reads the shared helper", (file) => {
    const full = path.join(ROOT, file);
    expect(fs.existsSync(full)).toBe(true);
    expect(/summarizeLineCounts|formatInvoiceLineCounts|LineCountChip/.test(read(full))).toBe(true);
  });

  it("no second line word is defined outside packages/pricing", () => {
    const second = [/=>\s*\(?n === 1 \? "1 line"/, /`\$\{n\} lines`/];
    const hits = sources.filter((f) => second.some((re) => re.test(read(f)))).map(rel);
    expect(hits).toEqual([]);
  });
});
