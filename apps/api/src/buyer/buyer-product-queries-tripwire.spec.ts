import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-606 WS6 tripwire (Opus #2856 M1, L-167): EVERY product read a BUYER can reach is built by the one visibility
 * builder or sits on a NAMED allow-list. A new `product.findMany|findFirst|findUnique|count|groupBy|aggregate` in
 * `buyer/` or `stock-alert.service.ts` that is neither fails here, so a new unfiltered buyer query cannot ship
 * silently (the older call-site spec only counted a literal `isActive: true`). The three order-write gates in
 * `orders.service.ts` are pinned to the ONE helper, `assertBuyerMayOrder`, with no inline copy of the rule.
 */
const SRC = join(__dirname, "..");
const BUILDER_CALL = /buyerVisibleProduct(ById)?Where\(|\bbaseWhere\b/;
const PRODUCT_READ =
  /\bproduct\s*\.\s*(findMany|findFirst|findUnique|count|groupBy|aggregate)\(|\.product\s*$/;

/** file -> how many product reads are allowed WITHOUT the builder, and why. */
const ALLOW: Record<string, { count: number; why: string }> = {
  "buyer/buyer.controller.ts": {
    count: 1,
    why: "units-per-box lookup for ids ALREADY on the buyer's own order lines",
  },
  "buyer/buyer-qty-split.ts": {
    count: 1,
    why:
      "row 531: the pack size of the ids in the buyer's OWN payload, compared with that payload's qty / box split " +
      "and never returned (the 400 echoes only the ids the buyer sent)",
  },
  "buyer/buyer-dashboard.service.ts": {
    count: 1,
    why: "category derivation from the buyer's order history, then the suggestion query uses the builder",
  },
  "buyer/shelf.service.ts": {
    count: 1,
    why: "existence check for a snooze/dismiss on a product id the buyer already holds",
  },
  "stock-alerts/stock-alert.service.ts": {
    count: 1,
    why: "the notify loop for ids with an existing subscription; subscribe itself uses the builder",
  },
};

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function unguardedProductReads(source: string): number {
  const lines = strip(source).split("\n");
  let n = 0;
  lines.forEach((l, i) => {
    if (!PRODUCT_READ.test(l)) return;
    if (!BUILDER_CALL.test(lines.slice(i, i + 14).join("\n"))) n += 1;
  });
  return n;
}

const files = [
  ...readdirSync(join(SRC, "buyer"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
    .map((f) => `buyer/${f}`),
  "stock-alerts/stock-alert.service.ts",
];

describe("buyer product reads are built by the ONE visibility builder (WS6 M1)", () => {
  it("the scanner is not vacuous: it sees an unguarded read and accepts a builder-built one", () => {
    expect(unguardedProductReads("const a = await db.product.findMany({ where: { id } });")).toBe(
      1,
    );
    expect(
      unguardedProductReads(
        "db.product.findMany({ where: buyerVisibleProductWhere(NO, { id }) });",
      ),
    ).toBe(0);
    expect(unguardedProductReads("db.product.count({ where: baseWhere });")).toBe(0);
  });

  it.each(files)("%s: unguarded product reads == its allow-list entry", (f) => {
    const n = unguardedProductReads(readFileSync(join(SRC, f), "utf8"));
    expect({ file: f, n }).toEqual({ file: f, n: ALLOW[f]?.count ?? 0 });
  });

  it("every allow-list row names a file that exists and carries a reason", () => {
    for (const [f, { why }] of Object.entries(ALLOW)) {
      expect(files).toContain(f);
      expect(why.length).toBeGreaterThan(20);
    }
  });

  it("orders.service.ts: the three buyer order-write gates are the ONE helper, with no inline copy of the rule", () => {
    const src = strip(readFileSync(join(SRC, "orders", "orders.service.ts"), "utf8"));
    // each of the three order-write paths loads its products WITH the parent flag and runs the ONE gate helper
    expect((src.match(/assertBuyerLines\(/g) ?? []).length).toBe(3);
    expect((src.match(/portalGateArgs\(/g) ?? []).length).toBe(3);
    expect(src).not.toMatch(/assertBuyerMayOrder\(/); // the rule itself lives only in buyer-product-visibility.ts
    expect(src).not.toMatch(/isBuyerVisible\w*\(/);
    // no inline portalVisible read in the service: the parent include is portalGateArgs' (PORTAL_PARENT_INCLUDE)
    expect(src).not.toMatch(/portalVisible/);
  });
});
