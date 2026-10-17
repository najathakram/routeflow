import * as fs from "fs";
import * as path from "path";

/**
 * Census of every place that INSERTS an Order row: each must write `Order.source` (who created the order: APP =
 * buyer, PHONE = office staff, ROUTE = driver) AND `sourceRecorded: true`. The F1(i) author rule
 * (`line-author-channel.ts`) trusts `source` only on a row whose `sourceRecorded` is true; a row that leaves it out
 * reads as UNKNOWN_LEGACY (STAFF), and one that leaves out `source` reads as the column default APP. A NEW
 * `order.create(` / `order.createMany(` / `order.upsert(`, a nested `orders: { create ... }` / `order: { create ... }`
 * relation write, or a raw `INSERT INTO "Order"` without both turns this spec red until it writes them (or is
 * allow-listed below WITH a reason).
 *
 * Static scan of apps/api/src, apps/api/scripts, apps/api/prisma (the dev seed) and the repo-root scripts/ (spec
 * files and `testing/` fixtures are test code, not sites). Counter sales, reorders, copies and the import all go
 * through `OrdersService.create`, the one request-path site; the only other src site is the standing-order generator.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const ROOTS = ["apps/api/src", "apps/api/scripts", "apps/api/prisma", "scripts"];
const SITE =
  /\border\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(|\borders?\s*:\s*\{\s*(?=(create|createMany|connectOrCreate|upsert)\s*:)|INSERT\s+INTO\s+"?Order"?\b/gi;

/**
 * Allow-list: `path:ordinal` (1-based, per file) -> why it may omit `source` / `sourceRecorded`. Every entry must still
 * match a site that lacks one of them. Seeds that write no `source` stay here (their rows read as legacy STAFF, the
 * column defaults); a seed that writes `source` writes `sourceRecorded: true` too, so it is not listed.
 */
const ALLOWED: Record<string, string> = {
  "apps/api/scripts/reset-and-seed.ts:1":
    "dev-only seed script (rows are dummy test data; the column defaults apply)",
  "apps/api/scripts/reset-seed.js:1":
    "dev-only seed script (rows are dummy test data; the column defaults apply)",
  "apps/api/scripts/e2e-seed.js:1":
    "Playwright seed for the e2e tenant (dummy data; the column defaults apply). It runs against prod after every " +
    "deploy and changes only through its own reviewed PR, so not in this one",
  "apps/api/scripts/sales-facts-timing.ts:1":
    "timing fixture for the sales-facts rollup (synthetic rows, never a request path)",
};

export interface Site {
  file: string;
  ordinal: number;
  hasSource: boolean;
  hasRecorded: boolean;
}

/** The balanced argument text starting at the bracket at `open` (`(` or `{`). */
function balanced(text: string, open: number): string {
  const o = text[open];
  const c = o === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return text.slice(open, i + 1);
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
      : balanced(text, m.index! + m[0].trimEnd().length - 1); // the `(` of a call, the `{` of a relation
    out.push({
      file,
      ordinal,
      hasSource: isRaw ? /"?source"?\s*[,)]/i.test(body) : /\bsource\s*[:,]/.test(body),
      hasRecorded: isRaw
        ? /"sourceRecorded"/.test(body)
        : /\bsourceRecorded\s*:\s*true\b/.test(body),
    });
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", "testing", "migrations"].includes(e.name)) continue;
      walk(p, acc);
    } else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const all: Site[] = ROOTS.flatMap((r) => walk(path.join(REPO_ROOT, r))).flatMap((p) =>
  findSites(path.relative(REPO_ROOT, p).split(path.sep).join("/"), fs.readFileSync(p, "utf8")),
);
const key = (s: Site) => `${s.file}:${s.ordinal}`;
const complete = (s: Site) => s.hasSource && s.hasRecorded;

describe("Order create-site census (Order.source + sourceRecorded)", () => {
  it("finds the known create sites (the list is the census: a new site shows up here)", () => {
    // eslint-disable-next-line no-console
    console.info(
      `order create-site census: ${all.length} sites\n${all
        .map((s) => `${key(s)} source=${s.hasSource} sourceRecorded=${s.hasRecorded}`)
        .join("\n")}`,
    );
    expect(all.map(key).sort()).toEqual(
      [
        "apps/api/prisma/seed.ts:1",
        "apps/api/scripts/demo-seed.js:1",
        "apps/api/scripts/e2e-seed.js:1",
        "apps/api/scripts/reset-and-seed.ts:1",
        "apps/api/scripts/reset-seed.js:1",
        "apps/api/scripts/sales-facts-timing.ts:1",
        "apps/api/src/order-templates/order-templates.service.ts:1",
        "apps/api/src/orders/orders.service.ts:1",
      ].sort(),
    );
  });

  it("the two request-path sites write source AND sourceRecorded: true (never allow-listed)", () => {
    const src = all.filter((s) => s.file.startsWith("apps/api/src/"));
    expect(src.map((s) => [key(s), complete(s), key(s) in ALLOWED])).toEqual([
      ["apps/api/src/order-templates/order-templates.service.ts:1", true, false],
      ["apps/api/src/orders/orders.service.ts:1", true, false],
    ]);
  });

  it("every create site writes `source:` and `sourceRecorded: true`, or is allow-listed with a reason", () => {
    expect(all.filter((s) => !complete(s) && !(key(s) in ALLOWED)).map(key)).toEqual([]);
  });

  it("a site that writes `source` also writes `sourceRecorded: true` unless allow-listed", () => {
    expect(
      all.filter((s) => s.hasSource && !s.hasRecorded && !(key(s) in ALLOWED)).map(key),
    ).toEqual([]);
  });

  it("the allow-list holds no stale entry (each still names a site that lacks one of them)", () => {
    const lacking = new Set(all.filter((s) => !complete(s)).map(key));
    expect(Object.keys(ALLOWED).filter((k) => !lacking.has(k))).toEqual([]);
  });

  describe("the scanner itself", () => {
    const one = (text: string) => findSites("a.ts", text)[0];

    it("flags a create without source, passes one with it, and reads raw INSERTs", () => {
      expect(one("await tx.order.create({ data: { customerId } });").hasSource).toBe(false);
      expect(one("await tx.order.create({ data: { customerId, source: 'APP' } });").hasSource).toBe(
        true,
      );
      expect(
        one("await this.prisma\n  .forTenant()\n  .order.createMany({ data: rows });").hasSource,
      ).toBe(false);
      expect(one('await db.$executeRaw`INSERT INTO "Order" (id) VALUES (1)`;').hasSource).toBe(
        false,
      );
      expect(findSites("a.ts", "const x = 1; // no sites")).toEqual([]);
    });

    it("requires sourceRecorded: true (false, a variable or its absence do not count)", () => {
      expect(
        one("tx.order.create({ data: { source: 'APP', sourceRecorded: true } })"),
      ).toMatchObject({ hasSource: true, hasRecorded: true });
      expect(
        one("tx.order.create({ data: { source: 'APP', sourceRecorded: false } })"),
      ).toMatchObject({ hasSource: true, hasRecorded: false });
      expect(
        one("tx.order.create({ data: { source: 'APP', sourceRecorded: flag } })"),
      ).toMatchObject({
        hasRecorded: false,
      });
      expect(one("tx.order.create({ data: { source: 'APP' } })").hasRecorded).toBe(false);
      expect(
        one('db.$executeRaw`INSERT INTO "Order" (id, source, "sourceRecorded") VALUES (1)`'),
      ).toMatchObject({ hasSource: true, hasRecorded: true });
    });

    it("finds nested relation writes (`orders: { create }`, `order: { create }`) and reads their own object", () => {
      const nested = findSites(
        "a.ts",
        "tx.customer.create({ data: { name, orders: { create: [{ source: 'APP', sourceRecorded: true }] } } })",
      );
      expect(nested).toHaveLength(1);
      expect(nested[0]).toMatchObject({ hasSource: true, hasRecorded: true });
      const bare = one(
        "tx.orderItem.create({ data: { qty, order: {\n create: { customerId } } } })",
      );
      expect(bare).toMatchObject({ hasSource: false, hasRecorded: false });
      expect(findSites("a.ts", "include: { order: { select: { id: true } } }")).toEqual([]);
      expect(findSites("a.ts", "where: { orders: { some: { status } } }")).toEqual([]);
    });
  });
});
