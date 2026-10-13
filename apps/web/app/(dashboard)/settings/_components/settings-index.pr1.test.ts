import * as fs from "fs";
import * as path from "path";
import { buildIndex, listGroup, searchSettings, splitHighlight } from "./settings-index";
import { GROUP_META } from "./settings-groups";

/** Settings PR1 (hub + search + rail): groups, new entries, gates, resolving hrefs, search, active row. */

const TAB_KEYS = [
  "profile",
  "notifications",
  "users",
  "email",
  "invoicing",
  "costing",
  "remittance",
  "integrations",
  "gohighlevel",
  "account",
  "regulated",
  "fulfilment",
];
const ROUTES = [
  "/settings",
  "/settings/billing",
  "/settings/import",
  "/settings/migration",
  "/settings/batch-import",
  "/settings/restrictions",
  "/settings/restrictions/rules",
  "/settings/product-categories",
  "/orders",
  "/orders/counter-sale",
];

/** Every gate open: the superset an admin of a fleet + counter + self-serve tenant can reach. */
const ALL = { isAdmin: true, fleet: true, selfServe: true, counter: true };
const full = buildIndex(ALL);
const ids = (o: Partial<typeof ALL>) => buildIndex({ ...ALL, ...o }).map((e) => e.id);

describe("PR1 groups (direction 2b)", () => {
  it("has the 7 groups, in order, with the approved titles", () => {
    expect(GROUP_META.map((g) => [g.key, g.title])).toEqual([
      ["fulfilment", "How you sell"],
      ["business", "Business & team"],
      ["payments", "Invoicing & payments"],
      ["selling", "Selling & pricing"],
      ["notifications", "Notifications"],
      ["compliance", "Compliance"],
      ["integrations", "Integrations & import"],
    ]);
  });

  const rows = (key: string, o = { fleet: true, counter: true }) =>
    listGroup(full, key, o).map((e) => e.id);

  it("places each row exactly where direction 2b says (nothing dropped)", () => {
    expect(rows("business")).toEqual(["business-profile", "user-management"]);
    expect(rows("payments")).toEqual(["invoicing", "how-to-pay", "card-payments"]);
    expect(rows("selling")).toEqual([
      "tier-names",
      "costing",
      "restrictions-selling",
      "restriction-rules",
      "product-labels",
    ]);
    expect(rows("notifications")).toEqual(["notifications", "email-smtp"]);
    expect(rows("compliance")).toEqual([
      "regulated-sections",
      "restrictions-compliance",
      "restriction-rules-compliance",
    ]);
    expect(rows("integrations")).toEqual([
      "claude-scanner",
      "gohighlevel",
      "import-data",
      "migration",
      "batch-invoice-import",
    ]);
  });

  it("Plan & billing is no list row (the Business card holds it) but stays an index entry", () => {
    expect(full.find((x) => x.id === "plan-billing")).toMatchObject({
      label: "Plan & billing",
      href: "/settings/billing",
    });
    for (const g of GROUP_META) expect(rows(g.key)).not.toContain("plan-billing");
  });

  it("How you sell: table order; Route defaults leads for fleet tenants; Counter leads for counter-only", () => {
    expect(rows("fulfilment", { fleet: true, counter: true })).toEqual([
      "route-defaults",
      "fulfillment",
      "counter-sales",
      "out-of-stock-ordering",
      "counter-quick-keys",
      "day-close",
    ]);
    const counterOnly = buildIndex({ ...ALL, fleet: false });
    expect(
      listGroup(counterOnly, "fulfilment", { fleet: false, counter: true }).map((e) => e.id),
    ).toEqual([
      "counter-sales",
      "counter-quick-keys",
      "day-close",
      "fulfillment",
      "out-of-stock-ordering",
    ]);
    const plain = buildIndex({ ...ALL, fleet: false, counter: false });
    expect(
      listGroup(plain, "fulfilment", { fleet: false, counter: false }).map((e) => e.id),
    ).toEqual(["fulfillment", "counter-sales", "out-of-stock-ordering"]);
  });

  it("Selling restrictions stays listed in BOTH Selling & pricing and Compliance", () => {
    expect(
      full.filter((e) => e.href === "/settings/restrictions" && e.kind === "item"),
    ).toHaveLength(2);
  });
});

describe("PR1 gates", () => {
  it("self-serve off hides Fulfillment and Counter sales (rows and cards), nothing else", () => {
    const off = ids({ selfServe: false });
    for (const id of ["fulfillment", "counter-sales", "delivery-method"])
      expect(off).not.toContain(id);
    expect(ids({ selfServe: true })).toEqual(
      expect.arrayContaining(["fulfillment", "counter-sales"]),
    );
    expect(off).toContain("out-of-stock-ordering");
  });

  it("counter capability off hides Counter quick keys and Day close", () => {
    const off = ids({ counter: false });
    for (const id of ["counter-quick-keys", "day-close", "open-counter"])
      expect(off).not.toContain(id);
    expect(ids({ counter: true })).toEqual(
      expect.arrayContaining(["counter-quick-keys", "day-close"]),
    );
  });

  it("fleet off still hides Route defaults; operators never see regulated / product labels / digest", () => {
    expect(ids({ fleet: false })).not.toContain("route-defaults");
    const op = ids({ isAdmin: false });
    for (const id of ["regulated-sections", "product-labels", "low-stock-digest"])
      expect(op).not.toContain(id);
    expect(op).toEqual(expect.arrayContaining(["restrictions-selling", "restrictions-compliance"]));
  });

  it("defaults are dark: no self-serve / counter flag means no Fulfillment or Counter rows", () => {
    const dark = buildIndex({ isAdmin: true, fleet: true }).map((e) => e.id);
    for (const id of ["fulfillment", "counter-sales", "counter-quick-keys", "day-close"])
      expect(dark).not.toContain(id);
  });
});

describe("PR1 every href resolves", () => {
  const settingsDir = path.resolve(__dirname, "..");
  const sources = [
    path.join(settingsDir, "page.tsx"),
    ...fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
      .map((f) => path.join(__dirname, f)),
  ]
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");

  it.each(full.filter((e) => e.href).map((e) => [e.id, e.href as string]))(
    "%s -> %s",
    (_id, href) => {
      const [pathAndQuery, hash] = href.split("#");
      const [p, query] = pathAndQuery.split("?");
      expect(ROUTES).toContain(p === "" ? "/settings" : p);
      const tab = query?.match(/(?:^|&)tab=([a-z]+)/)?.[1];
      if (tab) expect(TAB_KEYS).toContain(tab);
      if (hash) expect(sources).toMatch(new RegExp(`\\bid="${hash}"`));
    },
  );

  it("a card whose id the page never renders is a plain tab link (no dangling hash)", () => {
    expect(full.some((e) => e.href === "/settings?tab=profile#business-info")).toBe(false);
  });
});

describe("PR1 search", () => {
  const q = (s: string, o = ALL) => searchSettings(s, buildIndex(o)).map((e) => e.id);

  it.each([
    "counter",
    "carrier",
    "backorder",
    "low stock",
    "time zone",
    "timezone",
    "receipt footer",
    "stripe",
    "pay bill",
    "past due",
    "card declined",
    "read only",
    "locked",
    "walk-in",
    "till",
    "z report",
    "end of day",
    "pos mode",
    "fedex",
    "tracking",
    "pickup",
    "sold out",
    "oversell",
    "price level",
    "permissions",
    "sales tax",
    "invoice prefix",
  ])("'%s' finds at least one setting", (word) => {
    expect(q(word).length).toBeGreaterThan(0);
  });

  it("a group title alone matches nothing", () => {
    for (const t of ["how you sell", "integrations import", "business team"])
      expect(q(t)).toEqual([]);
  });

  it("each intent opens the most specific target first", () => {
    const first = (s: string) => full.find((e) => e.id === q(s)[0]);
    expect(first("counter")).toMatchObject({
      id: "counter-sales",
      href: "/settings?tab=fulfilment#counter-sales",
    });
    expect(first("time zone")?.href).toBe("/settings?tab=profile#settings-timezone");
    expect(first("carrier")?.href).toBe("/settings?tab=fulfilment#delivery-method");
    expect(first("backorder")?.href).toBe("#out-of-stock-ordering");
    expect(first("low stock")?.href).toBe("/settings?tab=notifications#low-stock-digest");
    expect(first("stripe")?.href).toBe("/settings#card-payments");
    expect(first("pay bill")?.href).toBe("/settings/billing");
  });

  it("with self-serve off, 'carrier' and 'counter' still answer (info rows), no dead link", () => {
    const o = { ...ALL, selfServe: false, counter: false };
    expect(searchSettings("carrier", buildIndex(o))[0].kind).toBe("info");
    expect(searchSettings("counter", buildIndex(o)).some((e) => e.kind === "info")).toBe(true);
  });

  it("collapses identical href+label (one answer per destination), and an info row a linked row already answers", () => {
    const hits = searchSettings("counter", full);
    const keys = hits.map((e) => `${e.href}|${e.label}|${e.groupKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(hits.filter((e) => e.label === "Counter sales")).toHaveLength(1);
    // OK-2 (apple-ux U1, Lead ruling): a row in two groups is ONE search answer (browsing keeps both rows).
    expect(
      searchSettings("restrictions", full).filter((e) => e.href === "/settings/restrictions"),
    ).toHaveLength(1);
  });

  it("linked results rank before info answers", () => {
    const kinds = searchSettings("ship", full).map((e) => (e.kind === "info" ? 1 : 0));
    expect(kinds).toEqual([...kinds].sort());
  });

  it("splitHighlight marks the matched words (hyphen and case folded)", () => {
    expect(splitHighlight("Counter sales", "counter")).toEqual([
      { text: "Counter", hit: true },
      { text: " sales", hit: false },
    ]);
    expect(
      splitHighlight("Low-stock digest", "low stock")
        .filter((p) => p.hit)
        .map((p) => p.text),
    ).toEqual(["Low", "stock"]);
    expect(splitHighlight("Costing", "")).toEqual([{ text: "Costing", hit: false }]);
  });
});

describe("apple-ux U1: one search result per destination", () => {
  it("'state' lists Selling restrictions once (it lives in two groups) and Portal limits & rules once", () => {
    const labels = searchSettings("state", full).map((e) => e.label);
    expect(labels.filter((l) => l === "Selling restrictions")).toHaveLength(1);
    expect(labels.filter((l) => l === "Portal limits & rules")).toHaveLength(1);
  });
});
