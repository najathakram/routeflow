import { parseSellingRestricted, restrictionReasonText } from "../lib/selling-restricted";
import { readFileSync } from "fs";
import { join } from "path";

// Pins the mobile copy of the parse/copy helpers AND that both order screens actually route the
// 409 to the modal (RN components aren't renderable in this lane, so the wiring is source-pinned).
const line = {
  productId: "p1",
  productName: "Hemp Gummies",
  ruleId: "r1",
  reason: "STATE_BAN" as const,
  state: "TX",
  message: "m",
};

describe("SELLING_RESTRICTED on mobile", () => {
  it("parses the 409 and words the reason", () => {
    const err = {
      response: { status: 409, data: { code: "SELLING_RESTRICTED", blockedLines: [line] } },
    };
    expect(parseSellingRestricted(err)).toEqual([line]);
    expect(
      parseSellingRestricted({ response: { status: 409, data: { code: "OTHER" } } }),
    ).toBeNull();
    expect(restrictionReasonText(line)).toBe("Restricted in TX");
  });

  it.each([
    [{ reason: "FEDERAL_BAN" as const }, "Restricted by federal law"],
    [{ reason: "STATE_BAN" as const }, "Restricted"],
    [{ reason: "BUYER_PORTAL_ONLY" as const }, "Not available for online ordering"],
    [{ reason: "INDETERMINATE_ADDRESS" as const }, expect.stringContaining("default address")],
    [{ reason: "UNKNOWN_PRODUCT" as const }, expect.stringContaining("couldn't be checked")],
  ])("words %j", (l, text) => {
    expect(restrictionReasonText(l)).toEqual(text);
  });

  it.each(["components/NewOrderScreen.tsx", "app/(operator)/(tabs)/orders/[id]/edit-items.tsx"])(
    "%s opens the blocked-lines modal from its save error handler",
    (rel) => {
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(src).toMatch(/parseSellingRestricted\(\w+\)/);
      expect(src).toMatch(/setRestrictedBlock\(restricted\)/);
      expect(src).toMatch(/<BlockedLinesModal lines=\{restrictedBlock\}/);
    },
  );
});
