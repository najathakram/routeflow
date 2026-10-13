import {
  checkUnitName,
  normalizeUnitName,
  unitErrorMessage,
  type TenantUnitDto,
} from "./tenant-units";

const unit = (name: string, archivedAt: string | null = null): TenantUnitDto => ({
  id: name,
  name,
  archivedAt,
  productCount: 0,
});
const http = (status: number, data: unknown = {}) => ({ response: { status, data } });

describe("normalizeUnitName", () => {
  it.each([
    ["case", "Case"],
    ["  half case ", "Half case"],
    ["12pk", "12pk"],
    ["CASE", "CASE"],
    ["Gift Box", "Gift Box"],
    ["sixPack", "sixPack"],
  ])("%j -> %j (first letter upper-cased only when typed all lowercase)", (raw, out) => {
    expect(normalizeUnitName(raw)).toBe(out);
  });
});

describe("checkUnitName", () => {
  it("empty and too long", () => {
    expect(checkUnitName("   ", [])).toBe("Enter a name.");
    expect(checkUnitName("x".repeat(31), [])).toBe("Keep it to 30 characters or fewer.");
    expect(checkUnitName("x".repeat(30), [])).toBeNull();
  });
  it.each(["Piece", " pieces ", "Each", "UNIT", "pcs"])(
    "%j is the smallest unit, which is always there: refused before a request",
    (name) => {
      expect(checkUnitName(name, [])).toBe("Piece is always there as the smallest unit.");
    },
  );
  it("an NFD spelling duplicates its NFC twin (same word)", () => {
    expect(checkUnitName("Cafe\u0301", [unit("Caf\u00e9")])).toBe(
      "You already have a unit called Caf\u00e9.",
    );
  });
  it("a duplicate is case-insensitive and names the existing unit", () => {
    expect(checkUnitName("case", [unit("Case")])).toBe("You already have a unit called Case.");
  });
  it("an ARCHIVED match is not an error: adding it restores it (R4)", () => {
    expect(checkUnitName("Case", [unit("Case", "2026-10-01T00:00:00Z")])).toBeNull();
  });
});

describe("unitErrorMessage", () => {
  it("rename in progress: the fixed retry sentence, never the raw server text", () => {
    expect(
      unitErrorMessage(http(409, { code: "UNITS_RENAME_IN_PROGRESS", message: "raw" }), "Case"),
    ).toBe("Another change is in progress. Try again in a moment.");
  });
  it("name taken", () => {
    expect(unitErrorMessage(http(409, { code: "UNIT_NAME_TAKEN" }), "Case")).toBe(
      "You already have a unit called Case.",
    );
  });
  it("rename collision names up to 3 products, then 'and N more'", () => {
    const products = (n: number) => ({
      code: "UNIT_RENAME_COLLISION",
      products: Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        name: ["Gift Box", "Mini Gift Box", "Mug", "Cup", "Bowl"][i],
      })),
    });
    expect(unitErrorMessage(http(409, products(2)), "Case")).toBe(
      "Can't rename to Case. Gift Box and Mini Gift Box already have a Case. Change those first.",
    );
    expect(unitErrorMessage(http(409, products(1)), "Case")).toBe(
      "Can't rename to Case. Gift Box already has a Case. Change that first.",
    );
    expect(unitErrorMessage(http(409, { ...products(5), total: 5 }), "Case")).toBe(
      "Can't rename to Case. Gift Box, Mini Gift Box, Mug and 2 more already have a Case. Change those first.",
    );
  });
  it("names the real cause when it is not a name clash (reason on the 409 body)", () => {
    const body = (reason: string, n: number) => ({
      code: "UNIT_RENAME_COLLISION",
      reason,
      products: Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        name: ["Gift Box", "Mug"][i],
      })),
    });
    expect(unitErrorMessage(http(409, body("DUPLICATE_LEVELS", 1)), "Carton")).toBe(
      "Can't rename to Carton. Gift Box has two units that would both become Carton. Change that first.",
    );
    expect(unitErrorMessage(http(409, body("DUPLICATE_LEVELS", 2)), "Carton")).toBe(
      "Can't rename to Carton. Gift Box and Mug have two units that would both become Carton. Change those first.",
    );
    expect(unitErrorMessage(http(409, body("MIXED", 2)), "Carton")).toBe(
      "Can't rename to Carton. Gift Box and Mug can't take that name. Change those first.",
    );
    expect(unitErrorMessage(http(409, body("LINES_AT_OTHER_SIZE", 1)), "Carton")).toBe(
      "Can't rename to Carton. Gift Box already sold Carton at a different size on an order or invoice. Pick another name.",
    );
    expect(unitErrorMessage(http(409, body("LINES_AT_OTHER_SIZE", 2)), "Carton")).toBe(
      "Can't rename to Carton. Gift Box and Mug already sold Carton at a different size on an order or invoice. Pick another name.",
    );
    expect(unitErrorMessage(http(409, body("NAME", 1)), "Carton")).toBe(
      "Can't rename to Carton. Gift Box already has a Carton. Change that first.",
    );
  });
  it("a collision body that names no product (a race backstop) still reads as a sentence", () => {
    expect(
      unitErrorMessage(
        http(409, { code: "UNIT_RENAME_COLLISION", reason: "NAME", products: [] }),
        "Case",
      ),
    ).toBe("Can't rename to Case. Some products already have a Case. Change those first.");
  });
  it("anything else is the fixed save-failed sentence", () => {
    const fixed = "Couldn't save. Your change is still here. Try again.";
    expect(unitErrorMessage(http(500), "Case")).toBe(fixed);
    expect(unitErrorMessage(http(400, { message: "raw server text" }), "Case")).toBe(fixed);
    expect(unitErrorMessage(new Error("boom"), "Case")).toBe(fixed);
  });
});
