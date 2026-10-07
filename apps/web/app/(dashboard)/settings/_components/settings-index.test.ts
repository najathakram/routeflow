import {
  GROUP_TITLES,
  buildIndex,
  breadcrumb,
  normalize,
  searchIndex,
  type IndexEntry,
} from "./settings-index";

/** Every hub link that existed before the index (master SettingsHub GROUPS), restrictions twice. */
const MASTER_GROUP_HREFS: Record<string, string[]> = {
  business: ["/settings?tab=profile", "/settings?tab=users"],
  selling: [
    "/settings?tab=invoicing",
    "/settings?tab=costing",
    "/settings?tab=remittance",
    "/settings/restrictions",
    "/settings/import",
    "/settings/migration",
  ],
  orders: ["#route-defaults", "/settings/batch-import"],
  notifications: ["/settings?tab=notifications", "/settings?tab=email"],
  compliance: ["/settings?tab=regulated", "/settings/restrictions", "/settings/product-categories"],
  integrations: ["/settings?tab=integrations", "/settings?tab=gohighlevel"],
  billing: ["/settings/billing"],
};

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
];

const admin = buildIndex({ isAdmin: true, fleet: true });
const operator = buildIndex({ isAdmin: false, fleet: true });

describe("normalize", () => {
  it("folds hyphens and punctuation to spaces and drops one trailing s", () => {
    expect(normalize("Low-stock")).toBe("low stock");
    expect(normalize("  Walk-in  ")).toBe("walk in");
    expect(normalize("restrictions")).toBe("restriction");
    expect(normalize("Plan & billing")).toBe("plan billing");
    expect(normalize("pos")).toBe("pos"); // short words keep their s
    expect(normalize("?!")).toBe("");
  });
});

describe("the index", () => {
  it("ids are unique", () => {
    const ids = admin.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every hub link that existed before is still an item in its group, in order", () => {
    for (const [group, hrefs] of Object.entries(MASTER_GROUP_HREFS)) {
      const items = admin.filter((e) => e.kind === "item" && e.groupKey === group);
      expect(items.map((e) => e.href)).toEqual(hrefs);
    }
    expect(admin.filter((e) => e.kind === "item")).toHaveLength(
      Object.values(MASTER_GROUP_HREFS).flat().length,
    );
  });

  it("every ?tab= key an entry links to is one of the existing tabs", () => {
    for (const e of admin) {
      const m = e.href?.match(/[?&]tab=([a-z]+)/);
      if (m) expect(TAB_KEYS).toContain(m[1]);
    }
  });

  it("every entry belongs to a known group, an info row has an answer and no link, others have a link", () => {
    for (const e of admin) {
      expect(GROUP_TITLES[e.groupKey]).toBeTruthy();
      if (e.kind === "info") {
        expect(e.answer).toBeTruthy();
        expect(e.href).toBeUndefined();
      } else {
        expect(e.href).toBeTruthy();
      }
    }
  });

  it("admin-only entries are absent for an operator, present for an admin", () => {
    const adminOnly = admin.filter((e) => e.show === "admin").map((e) => e.id);
    expect(adminOnly.sort()).toEqual(["product-labels", "regulated-sections"]);
    for (const id of adminOnly) expect(operator.find((e) => e.id === id)).toBeUndefined();
  });

  it("fleet-only entries are absent when the tenant has no fleet", () => {
    const noFleet = buildIndex({ isAdmin: true, fleet: false });
    expect(admin.find((e) => e.id === "route-defaults")).toBeTruthy();
    expect(noFleet.find((e) => e.id === "route-defaults")).toBeUndefined();
    expect(noFleet.length).toBe(admin.length - admin.filter((e) => e.needs === "fleet").length);
  });

  it("every hash an entry points at is one of the documented anchors", () => {
    const anchors = new Set([
      "business-info",
      "business-address",
      "logo",
      "tax",
      "payment-terms",
      "original-price",
      "deposits",
      "invoice-numbering",
      "invoice-defaults",
      "costing-method",
      "margin-floors",
      "remit-to",
      "payment-instructions",
      "notification-rules",
      "quiet-hours",
      "low-stock-digest",
      "push",
      "delivery-health",
      "smtp",
      "sending-domain",
      "mailbox",
      "password",
      "google-sign-in",
      "sessions",
      "driver-access",
      "route-defaults",
      "card-payments",
      "tier-names",
    ]);
    for (const e of admin) {
      const hash = e.href?.split("#")[1];
      if (hash) expect(anchors).toContain(hash);
    }
  });
});

describe("searchIndex", () => {
  const ids = (q: string, set: IndexEntry[] = admin) => searchIndex(q, set).map((e) => e.id);

  it("an empty or punctuation-only query is no search", () => {
    expect(searchIndex("", admin)).toEqual([]);
    expect(searchIndex("   ", admin)).toEqual([]);
    expect(searchIndex("?", admin)).toEqual([]);
  });

  it("the words from the walks all find something", () => {
    for (const q of [
      "counter",
      "walk-in",
      "shipping",
      "carrier",
      "fulfil",
      "low stock",
      "stripe",
      "tier",
      "stock",
    ]) {
      expect(ids(q).length).toBeGreaterThan(0);
    }
  });

  it("every word must match, and the words may come from different fields", () => {
    expect(ids("defaults service")).toContain("route-defaults");
    expect(ids("defaults zzzz")).toEqual([]);
  });

  it("the group title is not searched", () => {
    expect(ids("orders stock")).not.toContain("route-defaults");
    expect(ids("stock")).not.toContain("batch-invoice-import");
  });

  it("a label hit outranks a keyword hit outranks a description hit; ties keep index order", () => {
    const entries: IndexEntry[] = [
      {
        id: "d",
        kind: "item",
        label: "Zed",
        desc: "has widget here",
        groupKey: "business",
        keywords: [],
      },
      { id: "k", kind: "item", label: "Yak", desc: "", groupKey: "business", keywords: ["widget"] },
      { id: "l", kind: "item", label: "Widget", desc: "", groupKey: "business", keywords: [] },
      {
        id: "l2",
        kind: "item",
        label: "Widgets too",
        desc: "",
        groupKey: "business",
        keywords: [],
      },
    ];
    expect(searchIndex("widget", entries).map((e) => e.id)).toEqual(["l", "l2", "k", "d"]);
  });

  it("does not return entries a role cannot see", () => {
    expect(ids("regulated", operator)).toEqual([]);
    expect(ids("regulated")).toContain("regulated-sections");
  });
});

describe("breadcrumb", () => {
  it("is the group title, then the page the card lives on, else the entry's own label", () => {
    const byId = (id: string) => admin.find((e) => e.id === id)!;
    expect(breadcrumb(byId("invoicing-payment-terms"))).toBe("Selling & catalog › Invoicing");
    expect(breadcrumb(byId("invoicing"))).toBe("Selling & catalog › Invoicing");
    expect(breadcrumb(byId("card-payments"))).toBe("Billing › Card payments");
  });
});
