import { buildIndex, normalize, searchIndex } from "./settings-index";

/** Every href/label/key the hub listed on master (GROUPS) - none may disappear. */
const MASTER_ITEMS: { label: string; href: string }[] = [
  { label: "Business profile", href: "/settings?tab=profile" },
  { label: "User management", href: "/settings?tab=users" },
  { label: "Invoicing", href: "/settings?tab=invoicing" },
  { label: "Costing", href: "/settings?tab=costing" },
  { label: "How to pay", href: "/settings?tab=remittance" },
  { label: "Selling restrictions", href: "/settings/restrictions" },
  { label: "Import data", href: "/settings/import" },
  { label: "Migration", href: "/settings/migration" },
  { label: "Route defaults", href: "#route-defaults" },
  { label: "Out-of-stock ordering", href: "#out-of-stock-ordering" },
  { label: "Batch invoice import", href: "/settings/batch-import" },
  { label: "Notifications", href: "/settings?tab=notifications" },
  { label: "Email (SMTP)", href: "/settings?tab=email" },
  { label: "Regulated sections", href: "/settings?tab=regulated" },
  { label: "Product labels", href: "/settings/product-categories" },
  { label: "Claude AI scanner", href: "/settings?tab=integrations" },
  { label: "GoHighLevel", href: "/settings?tab=gohighlevel" },
  { label: "Plan & billing", href: "/settings/billing" },
  { label: "My account", href: "/settings?tab=account" },
];

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

const admin = buildIndex({ isAdmin: true, fleet: true });

describe("settings index", () => {
  it("ids are unique", () => {
    const ids = admin.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every master hub link (label + href) is still indexed", () => {
    for (const m of MASTER_ITEMS) {
      expect(admin.some((e) => e.href === m.href && e.label === m.label)).toBe(true);
    }
    expect(admin.filter((e) => e.href === "/settings/restrictions")).toHaveLength(2);
  });

  it("every ?tab= key is one the settings page knows", () => {
    for (const e of admin) {
      const m = e.href?.match(/[?&]tab=([a-z]+)/);
      if (m) expect(TAB_KEYS).toContain(m[1]);
    }
  });

  it("normalize lowercases, splits on punctuation and drops one trailing s", () => {
    expect(normalize("Low-stock")).toBe("low stock");
    expect(normalize("  Net 30 terms ")).toBe("net 30 term");
    expect(normalize("ups")).toBe("ups");
  });

  it("needs:fleet entries are absent when fleet is off, present when on", () => {
    const off = buildIndex({ isAdmin: true, fleet: false });
    const needy = admin.filter((e) => e.needs === "fleet");
    expect(needy.length).toBeGreaterThan(0);
    for (const e of needy) expect(off.some((o) => o.id === e.id)).toBe(false);
  });

  it("show:admin entries are absent for operators", () => {
    const op = buildIndex({ isAdmin: false, fleet: true });
    expect(op.some((e) => e.href === "/settings?tab=regulated")).toBe(false);
    expect(op.some((e) => e.href === "/settings/product-categories")).toBe(false);
  });

  it("info rows carry an answer and no href", () => {
    const info = admin.filter((e) => e.kind === "info");
    expect(info.length).toBeGreaterThanOrEqual(4);
    for (const e of info) {
      expect(e.href).toBeUndefined();
      expect(e.answer).toBeTruthy();
    }
  });

  it("every token must match; label outranks keywords outranks desc", () => {
    expect(searchIndex("carrier zzzzqq", admin)).toEqual([]);
    const hits = searchIndex("low stock", admin).map((e) => e.label);
    expect(hits).toContain("Low-stock digest");
    expect(searchIndex("", admin)).toEqual([]);
  });
});

describe("info rows name the controls as the user sees them", () => {
  it("batch ship names the Orders list button 'Mark shipped'", () => {
    const row = buildIndex({ isAdmin: true, fleet: true }).find((e) =>
      /several orders/i.test(e.label),
    );
    expect(row?.answer).toBe("Select orders on the Orders list, then choose Mark shipped.");
  });
});

describe("#3320 review folds", () => {
  const all = buildIndex({ isAdmin: true, fleet: true });
  const byId = (id: string, list = all) => list.find((e) => e.id === id);

  it("N1 driver access is the operator/driver view switch and needs a fleet", () => {
    expect(byId("driver-access")?.desc).toMatch(/driver view/i);
    expect(byId("driver-access", buildIndex({ isAdmin: true, fleet: false }))).toBeUndefined();
  });

  it("N2 the low-stock digest is admin-only", () => {
    expect(byId("low-stock-digest", buildIndex({ isAdmin: false, fleet: true }))).toBeUndefined();
    expect(byId("low-stock-digest")).toBeDefined();
  });

  it("N3 card descriptions say what the card really holds", () => {
    expect(byId("deposits")?.desc).toMatch(/when the order is placed/i);
    expect(byId("invoice-defaults")?.desc).toMatch(/terms/i);
    expect(byId("payment-instructions")?.desc).toMatch(/Payments page/);
    expect(byId("margin-floors")?.desc).toMatch(/warn/i);
  });

  it("N4 card payments reads as a payments row (a card on the hub, not a billing page)", () => {
    expect(byId("card-payments")?.groupKey).toBe("payments");
    expect(byId("card-payments")?.href).toBe("/settings#card-payments");
  });

  it("N5 regulated sections and product labels answer the restriction words", () => {
    for (const q of ["state", "blocked", "banned", "age"]) {
      const ids = searchIndex(q, all).map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining(["regulated-sections", "product-labels"]));
    }
  });

  it("N7 a label match ranks above a keyword-only match", () => {
    const ids = searchIndex("low stock", all).map((e) => e.id);
    expect(ids[0]).toBe("low-stock-digest");
  });
});
