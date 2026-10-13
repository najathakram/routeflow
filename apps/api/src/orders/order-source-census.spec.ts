import * as fs from "fs";
import * as path from "path";

/**
 * Census of every place that INSERTS an Order row: each must write `Order.source` (who created the order: APP =
 * buyer, PHONE = office staff, ROUTE = driver). The F1(i) author rule and the legacy-source cutoff trust that column
 * (`line-author-channel.ts`); a create site that leaves it out silently reads as the column default APP, i.e. a
 * buyer. A NEW `order.create(` / `order.createMany(` / `order.upsert(` / raw `INSERT INTO "Order"` without a
 * `source:` turns this spec red until it writes one (or is allow-listed below WITH a reason).
 *
 * Static scan of apps/api/src and apps/api/scripts (spec files and src/testing fixtures are test code, not sites).
 * Counter sales, reorders, copies and the import all go through `OrdersService.create`, the one request-path site
 * (it stamps `orderSourceForRole(user.role)`); the only other src site is the standing-order generator.
 */
const API_ROOT = path.resolve(__dirname, "..", "..");
const ROOTS = ["src", "scripts"];
const SITE =
  /\border\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(|INSERT\s+INTO\s+"?Order"?\b/gi;

/** Allow-list: `path:ordinal` (1-based, per file) -> why it may omit `source`. Every entry must still match a site. */
const ALLOWED_WITHOUT_SOURCE: Record<string, string> = {
  "scripts/reset-and-seed.ts:1":
    "dev-only seed script (rows are dummy test data; the column default applies)",
  "scripts/reset-seed.js:1":
    "dev-only seed script (rows are dummy test data; the column default applies)",
  "scripts/e2e-seed.js:1":
    "Playwright seed for the e2e tenant (dummy data; the column default applies)",
  "scripts/sales-facts-timing.ts:1":
    "timing fixture for the sales-facts rollup (synthetic rows, never a request path)",
};

export interface Site {
  file: string;
  ordinal: number;
  hasSource: boolean;
}

/** The balanced `( ... )` argument text starting at the `(` at `open`. */
function callText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

export function findSites(file: string, text: string): Site[] {
  const out: Site[] = [];
  let ordinal = 0;
  for (const m of text.matchAll(SITE)) {
    ordinal += 1;
    const isRaw = /INSERT/i.test(m[0]);
    const body = isRaw
      ? text.slice(m.index!, m.index! + 600)
      : callText(text, m.index! + m[0].length - 1);
    out.push({
      file,
      ordinal,
      hasSource: isRaw ? /"?source"?\s*[,)]/i.test(body) : /\bsource\s*[:,]/.test(body),
    });
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "testing") continue;
      walk(p, acc);
    } else if (/\.(ts|js|mjs)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const all: Site[] = ROOTS.flatMap((r) => walk(path.join(API_ROOT, r))).flatMap((p) =>
  findSites(path.relative(API_ROOT, p), fs.readFileSync(p, "utf8")),
);
const key = (s: Site) => `${s.file}:${s.ordinal}`;

describe("Order create-site census (Order.source)", () => {
  it("finds the known create sites (the list is the census: a new site shows up here)", () => {
    // eslint-disable-next-line no-console
    console.info(
      `order create-site census: ${all.length} sites\n${all.map((s) => `${key(s)} source=${s.hasSource}`).join("\n")}`,
    );
    expect(all.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        "src/orders/orders.service.ts",
        "src/order-templates/order-templates.service.ts",
      ]),
    );
  });

  it("every create site writes `source:` or is allow-listed with a reason", () => {
    const missing = all.filter((s) => !s.hasSource && !(key(s) in ALLOWED_WITHOUT_SOURCE)).map(key);
    expect(missing).toEqual([]);
  });

  it("the allow-list holds no stale entry (each still names a site that lacks source)", () => {
    const lacking = new Set(all.filter((s) => !s.hasSource).map(key));
    expect(Object.keys(ALLOWED_WITHOUT_SOURCE).filter((k) => !lacking.has(k))).toEqual([]);
  });

  describe("the scanner itself", () => {
    it("flags a create without source, passes one with it, and reads raw INSERTs", () => {
      expect(
        findSites("a.ts", "await tx.order.create({ data: { customerId } });")[0].hasSource,
      ).toBe(false);
      expect(
        findSites("a.ts", "await tx.order.create({ data: { customerId, source: 'APP' } });")[0]
          .hasSource,
      ).toBe(true);
      expect(
        findSites(
          "a.ts",
          "await this.prisma\n  .forTenant()\n  .order.createMany({ data: rows });",
        )[0].hasSource,
      ).toBe(false);
      expect(
        findSites("a.ts", 'await db.$executeRaw`INSERT INTO "Order" (id) VALUES (1)`;')[0]
          .hasSource,
      ).toBe(false);
      expect(findSites("a.ts", "const x = 1; // no sites")).toEqual([]);
    });
  });
});
