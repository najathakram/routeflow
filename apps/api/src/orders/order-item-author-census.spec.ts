import * as fs from "fs";
import * as path from "path";

/**
 * SA ruling (#3418): census of every place that INSERTS an OrderItem row. Each must write the explicit per-line
 * author marker `authorChannel` ('STAFF' | 'BUYER', from the ACTING principal via `lineAuthorFor`, or the folded
 * line's own resolved author) so the F1(i) author rule (`line-author-channel.ts`) never has to guess from a
 * timestamp. A NEW `orderItem.create(` / `createMany(` / `createManyAndReturn(` / `upsert(`, a nested
 * `lineItems: { create ... }` relation write, or a raw `INSERT INTO "OrderItem"` without `authorChannel` turns this
 * spec red until it writes one (or is allow-listed below WITH a reason). A line without the marker reads through the
 * order-level rule (sourceRecorded=false -> STAFF, else the recorded Order.source).
 *
 * Static scan of apps/api/src, apps/api/scripts, apps/api/prisma (the dev seed) and the repo-root scripts/ (spec
 * files and `testing/` fixtures are test code, not sites).
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const ROOTS = ["apps/api/src", "apps/api/scripts", "apps/api/prisma", "scripts"];
const SITE =
  /\borderItem\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(|\blineItems\s*:\s*\{\s*(?=(create|createMany|connectOrCreate|upsert)\s*:)|INSERT\s+INTO\s+"?OrderItem"?(?![A-Za-z])/gi;

/**
 * Allow-list: `path:ordinal` (1-based, per file) -> why it may omit `authorChannel`. Every entry must still match a
 * site that lacks it. These rows read through the order-level rule; none of them is a request path.
 */
const NOT_ORDER_ITEM: Record<string, string> = {
  "apps/api/src/bookkeeping/bookkeeping.service.ts:1":
    "Expense.lineItems (expense line items), a relation of the same name that is not OrderItem",
};

const ALLOWED: Record<string, string> = {
  "apps/api/scripts/reset-and-seed.ts:1":
    "dev-only seed script (dummy rows; it writes no Order.source either, so its lines read as legacy STAFF)",
  "apps/api/scripts/reset-seed.js:1":
    "dev-only seed script (dummy rows; it writes no Order.source either, so its lines read as legacy STAFF)",
  "apps/api/scripts/e2e-seed.js:1":
    "Playwright seed for the e2e tenant (dummy data; no Order.source either). It runs against prod after every " +
    "deploy and changes only through its own reviewed PR, so not in this one",
  "apps/api/scripts/merge-pending-orders.js:1":
    "one-shot local-only backfill (productionGuard refuses prod); an unmarked line reads the order-level rule",
};

export interface Site {
  file: string;
  ordinal: number;
  hasMarker: boolean;
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

/** Comments are not sites: `// ...` tails and `*` / `/*` doc lines are blanked (line count kept). */
function code(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*(\*|\/\*)/.test(line) ? "" : line.replace(/(^|\s)\/\/.*$/, "$1")))
    .join("\n");
}

export function findSites(file: string, raw: string): Site[] {
  const text = code(raw);
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
      hasMarker: isRaw
        ? /"authorChannel"/.test(body)
        : /\bauthorChannel\b|\bwithAuthor\(/.test(body), // the marker, or the stamping helper
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

const key = (s: Site) => `${s.file}:${s.ordinal}`;
const scanned: Site[] = ROOTS.flatMap((r) => walk(path.join(REPO_ROOT, r))).flatMap((p) =>
  findSites(path.relative(REPO_ROOT, p), fs.readFileSync(p, "utf8")),
);
const all: Site[] = scanned.filter((s) => !(key(s) in NOT_ORDER_ITEM));
const perFile = (sites: Site[]) =>
  sites.reduce<Record<string, number>>(
    (acc, s) => ({ ...acc, [s.file]: (acc[s.file] ?? 0) + 1 }),
    {},
  );

describe("OrderItem create-site census (authorChannel)", () => {
  it("finds the known create sites (the list is the census: a new site shows up here)", () => {
    // eslint-disable-next-line no-console
    console.info(
      `order-item create-site census: ${all.length} sites\n${all
        .map((s) => `${key(s)} authorChannel=${s.hasMarker}`)
        .join("\n")}`,
    );
    expect(perFile(all)).toEqual({
      "apps/api/prisma/seed.ts": 1,
      "apps/api/scripts/demo-seed.js": 1,
      "apps/api/scripts/e2e-seed.js": 1,
      "apps/api/scripts/merge-pending-orders.js": 1,
      "apps/api/scripts/reset-and-seed.ts": 1,
      "apps/api/scripts/reset-seed.js": 1,
      "apps/api/src/invoices/invoices.service.ts": 1,
      "apps/api/src/order-templates/order-templates.service.ts": 1,
      "apps/api/src/orders/orders.service.ts": 12,
      "apps/api/src/orders/unit-line-edit.ts": 1,
    });
  });

  it("every apps/api/src site writes authorChannel (never allow-listed)", () => {
    const src = all.filter((s) => s.file.startsWith("apps/api/src/"));
    expect(src.filter((s) => !s.hasMarker || key(s) in ALLOWED).map(key)).toEqual([]);
  });

  it("every create site writes authorChannel, or is allow-listed with a reason", () => {
    expect(all.filter((s) => !s.hasMarker && !(key(s) in ALLOWED)).map(key)).toEqual([]);
  });

  it("the not-an-OrderItem list holds no stale entry (each still names a scanned site)", () => {
    const seen = new Set(scanned.map(key));
    expect(Object.keys(NOT_ORDER_ITEM).filter((k) => !seen.has(k))).toEqual([]);
  });

  it("the allow-list holds no stale entry (each still names a site that lacks the marker)", () => {
    const lacking = new Set(all.filter((s) => !s.hasMarker).map(key));
    expect(Object.keys(ALLOWED).filter((k) => !lacking.has(k))).toEqual([]);
  });

  describe("the scanner itself", () => {
    const one = (text: string) => findSites("a.ts", text)[0];

    it("flags a create without the marker, passes one with it, and reads raw INSERTs", () => {
      expect(one("await tx.orderItem.create({ data: { orderId, qty } });").hasMarker).toBe(false);
      expect(
        one("await tx.orderItem.create({ data: { orderId, qty, authorChannel } });").hasMarker,
      ).toBe(true);
      expect(
        one("await this.prisma\n  .forTenant()\n  .orderItem.createMany({ data: rows });")
          .hasMarker,
      ).toBe(false);
      expect(one("db.orderItem.upsert({ where, update: {}, create: { qty } })").hasMarker).toBe(
        false,
      );
      expect(one('db.$executeRaw`INSERT INTO "OrderItem" (id) VALUES (1)`;').hasMarker).toBe(false);
      expect(
        one('db.$executeRaw`INSERT INTO "OrderItem" (id, "authorChannel") VALUES (1, 2)`;')
          .hasMarker,
      ).toBe(true);
      expect(findSites("a.ts", 'INSERT INTO "OrderItemComponent" (id) VALUES (1)')).toEqual([]);
      expect(findSites("a.ts", "const x = 1; // no sites")).toEqual([]);
    });

    it("finds nested `lineItems: { create }` writes and reads their own object", () => {
      const bare = one("tx.order.create({ data: { lineItems: {\n create: lineItemsData } } })");
      expect(bare).toMatchObject({ hasMarker: false });
      const stamped = one(
        "tx.order.create({ data: { lineItems: { create: rows.map((li) => ({ ...li, authorChannel })) } } })",
      );
      expect(stamped).toMatchObject({ hasMarker: true });
      expect(
        one("tx.order.create({ data: { lineItems: { create: withAuthor(rows, m) } } })"),
      ).toMatchObject({
        hasMarker: true,
      });
      expect(findSites("a.ts", "include: { lineItems: { select: { id: true } } }")).toEqual([]);
      expect(findSites("a.ts", "where: { lineItems: { some: { status } } }")).toEqual([]);
    });

    it("skips comments (a `// orderItem.create()` remark or a doc line is not a site)", () => {
      expect(findSites("a.ts", "// orderItem.create() below\nconst x = 1;")).toEqual([]);
      expect(findSites("a.ts", "  x(); // tx.orderItem.create({ data })")).toEqual([]);
      expect(findSites("a.ts", " * tx.orderItem.create({ data })\n")).toEqual([]);
      expect(
        findSites("a.ts", "const u = 'http://x'; tx.orderItem.create({ data: { authorChannel } })"),
      ).toHaveLength(1);
    });

    it("does not count an orderItem update / findMany / deleteMany as a create site", () => {
      expect(findSites("a.ts", "tx.orderItem.update({ where, data })")).toEqual([]);
      expect(findSites("a.ts", "tx.orderItem.findMany({ where })")).toEqual([]);
      expect(findSites("a.ts", "tx.orderItem.deleteMany({ where })")).toEqual([]);
    });
  });
});
