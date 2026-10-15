import { buildIndex, searchSettings } from "./settings-index";

/**
 * SA #3412 M-INT2: the index is what the hub and the rail list and search, so an admin-only screen or card must
 * not be an operator's row or search hit (it would open on "Only an admin can change this."). GoHighLevel stays
 * (its tab is open to operators). Driver access follows the page's own rule: an admin on a fleet account, or
 * anyone who can already act as a driver.
 */
const ADMIN_ONLY = [
  "import-data",
  "migration",
  "email-smtp",
  "claude-scanner",
  "invoice-numbering",
  "smtp",
  "sending-domain",
  "mailbox",
];

const ids = (o: Parameters<typeof buildIndex>[0]) => buildIndex(o).map((e) => e.id);

describe("settings index: operator gates (SA #3412 M-INT2)", () => {
  it("an operator gets none of the admin-only items or cards", () => {
    const op = ids({ isAdmin: false, fleet: true });
    for (const id of ADMIN_ONLY) expect(op).not.toContain(id);
  });

  it("an admin still gets every one of them", () => {
    const admin = ids({ isAdmin: true, fleet: true });
    for (const id of ADMIN_ONLY) expect(admin).toContain(id);
  });

  it("GoHighLevel stays visible to operators", () => {
    expect(ids({ isAdmin: false, fleet: true })).toContain("gohighlevel");
  });

  it.each(["smtp", "claude", "numbering", "migration"])(
    "an operator's search for %s finds nothing",
    (q) => {
      expect(searchSettings(q, buildIndex({ isAdmin: false, fleet: true }))).toEqual([]);
    },
  );

  it.each([
    [{ isAdmin: true, fleet: true }, true],
    [{ isAdmin: true, fleet: false }, false],
    [{ isAdmin: false, fleet: true }, false],
    [{ isAdmin: false, fleet: true, canActAsDriver: true }, true],
    [{ isAdmin: false, fleet: false, canActAsDriver: true }, true],
    [{ isAdmin: true, fleet: false, canActAsDriver: true }, true],
  ])("driver access for %o -> %s", (o, shown) => {
    expect(ids(o).includes("driver-access")).toBe(shown);
  });
});
