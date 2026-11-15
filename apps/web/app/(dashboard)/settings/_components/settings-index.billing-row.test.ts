import { buildIndex, listGroup, searchSettings } from "./settings-index";

/**
 * SA-1151 §2 (UX guide F09) and §3 (F03). Billing is a row in the Business group for an admin, second after
 * Business profile, and only for an admin (the page's actions are admin-only). "How to pay" is "How customers pay you"
 * on the rail and in search, so it can no longer be read as how the owner pays RouteFlow.
 */
const opts = { fleet: true, counter: true };
const admin = buildIndex({ isAdmin: true, fleet: true });
const operator = buildIndex({ isAdmin: false, fleet: true, role: "OPERATOR" });
const driver = buildIndex({ isAdmin: false, fleet: true, role: "DRIVER" });
const rowIds = (entries: ReturnType<typeof buildIndex>) =>
  listGroup(entries, "business", opts).map((e) => e.id);

describe("Settings index: the Billing row (F09)", () => {
  it("an admin sees one row labelled Billing in the Business group, second", () => {
    expect(rowIds(admin)).toEqual(["business-profile", "plan-billing", "user-management"]);
    const row = listGroup(admin, "business", opts)[1];
    expect(row).toMatchObject({
      label: "Billing",
      desc: "Your plan, payments and receipts",
      href: "/settings/billing",
    });
  });

  it("an operator and a driver get no Billing row and no index entry for it", () => {
    for (const entries of [operator, driver]) {
      expect(rowIds(entries)).not.toContain("plan-billing");
      expect(entries.map((e) => e.id)).not.toContain("plan-billing");
    }
  });

  it.each(["billing", "receipt", "plan", "invoice", "subscription", "trial"])(
    "an admin's search for %s finds the Billing row",
    (q) => {
      expect(searchSettings(q, admin).map((e) => e.id)).toContain("plan-billing");
    },
  );

  it("the hub lists exactly one row to /settings/billing (the status card is a search card, not a row)", () => {
    const rows = admin.filter(
      (e) => e.kind === "item" && e.listed !== false && e.href === "/settings/billing",
    );
    expect(rows.map((e) => e.id)).toEqual(["plan-billing"]);
    expect(admin.find((e) => e.id === "billing-status")?.kind).toBe("card");
  });
});

describe("Settings index: How customers pay you (F03)", () => {
  it("the rail row, its search label and the cards' page name use the same words", () => {
    const row = admin.find((e) => e.id === "how-to-pay");
    expect(row?.label).toBe("How customers pay you");
    for (const id of ["remit-to", "payment-instructions"]) {
      expect(admin.find((e) => e.id === id)?.page).toBe("How customers pay you");
    }
  });

  it("no index entry still says 'How to pay'", () => {
    expect(admin.filter((e) => e.label === "How to pay" || e.page === "How to pay")).toEqual([]);
  });

  it("a search for 'how customers pay' finds the row", () => {
    expect(searchSettings("how customers pay", admin).map((e) => e.id)).toContain("how-to-pay");
  });
});
