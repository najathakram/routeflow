import { API_ERROR_CODES } from "@routeflow/types";
import { regulatedAuthCopy, regulatedAuthErrorCopy } from "@routeflow/types/regulated-auth-copy";

/**
 * CQ-06: ONE shared sentence table for the regulated-sale license refusal (409 REGULATED_AUTH_REQUIRED), consumed by
 * web (generic toast, counter) and mobile. It says what is wrong (expired / none on file) AND the next step, and it
 * only ever shows a category name that passes a conservative text check (never a formula-led or long string).
 */
const NEXT_STEP_TAB = "Licenses tab";
const blocked = (reason: "NO_AUTH" | "EXPIRED", categoryName = "Alcohol") => ({
  trackedCategoryId: "cat-1",
  categoryName,
  reason,
});

describe("regulatedAuthCopy", () => {
  it("EXPIRED: names the item group, says it expired, and where to renew", () => {
    const copy = regulatedAuthCopy([blocked("EXPIRED")]);
    expect(copy).toBe(
      "This sale includes regulated items (Alcohol), and the customer's license has expired. Renew it on the customer's Licenses tab, then try again.",
    );
  });

  it("NO_AUTH: says none is on file, where to add it, and the choose-another-customer exit", () => {
    const copy = regulatedAuthCopy([blocked("NO_AUTH")]);
    expect(copy).toBe(
      "This sale includes regulated items (Alcohol), and the customer has no verified license on file. Add, verify or renew it on the customer's Licenses tab, or choose a customer who has one, then try again.",
    );
  });

  it("mixed reasons: one sentence that covers add-or-renew", () => {
    const copy = regulatedAuthCopy([
      blocked("EXPIRED", "Alcohol"),
      { ...blocked("NO_AUTH", "Hemp"), trackedCategoryId: "cat-2" },
    ]);
    expect(copy).toBe(
      "This sale includes regulated items (Alcohol, Hemp) that need a valid license on file for the customer. Add, verify or renew it on the customer's Licenses tab, then try again.",
    );
  });

  it("an empty / absent / malformed list still says what to do (no names)", () => {
    for (const input of [[], undefined, null, "x", [{}], [{ categoryName: 5, reason: "??" }]]) {
      const copy = regulatedAuthCopy(input);
      expect(copy).toContain("regulated items");
      expect(copy).not.toContain("(");
      expect(copy).toContain(NEXT_STEP_TAB);
      expect(copy).toMatch(/try again\.$/);
    }
  });

  it("never shows a category name that is formula-led, over-long, or carries markup", () => {
    for (const name of [
      "=HYPERLINK(1)",
      "+cmd",
      "-2+3",
      "@sum",
      "<script>x</script>",
      "A".repeat(41),
      "",
    ]) {
      const copy = regulatedAuthCopy([blocked("NO_AUTH", name)]);
      expect(copy).not.toContain(name || "\u0000");
      expect(copy).not.toContain("(");
    }
  });

  it("de-duplicates repeated names and says how many more when the list is capped at three", () => {
    const copy = regulatedAuthCopy([
      blocked("NO_AUTH", "A1"),
      blocked("NO_AUTH", "A1"),
      blocked("NO_AUTH", "B2"),
      blocked("NO_AUTH", "C3"),
      blocked("NO_AUTH", "D4"),
      blocked("NO_AUTH", "E5"),
    ]);
    expect(copy).toContain("(A1, B2, C3 and 2 more)");
    expect(copy).not.toContain("D4");
  });

  it("a filtered-out name is counted, never silently dropped", () => {
    const copy = regulatedAuthCopy([
      blocked("NO_AUTH", "Alcohol"),
      blocked("NO_AUTH", "=HYPERLINK(1)"),
    ]);
    expect(copy).toContain("(Alcohol and 1 more)");
    expect(copy).not.toContain("HYPERLINK");
  });

  describe("a walk-in at the counter has no license tab to fix", () => {
    it("says only to choose a customer who has a valid license", () => {
      for (const reason of ["EXPIRED", "NO_AUTH"] as const) {
        const copy = regulatedAuthCopy([blocked(reason)], { walkIn: true });
        expect(copy).toBe(
          "This sale includes regulated items (Alcohol), which need a customer with a valid license. Choose a customer who has a valid license, then try again.",
        );
        expect(copy).not.toContain("Licenses tab");
      }
    });
    it("the error helper passes the option through", () => {
      const e = {
        response: {
          status: 409,
          data: { code: API_ERROR_CODES.REGULATED_AUTH_REQUIRED, blockedCategories: [] },
        },
      };
      expect(regulatedAuthErrorCopy(e, { walkIn: true })).toContain("Choose a customer");
      expect(regulatedAuthErrorCopy(e)).toContain("Licenses tab");
    });
  });
});

describe("regulatedAuthErrorCopy", () => {
  const axiosErr = (status: number, data: Record<string, unknown>) => ({
    response: { status, data },
  });

  it("returns the copy for a 409 REGULATED_AUTH_REQUIRED, using the structured body only", () => {
    const copy = regulatedAuthErrorCopy(
      axiosErr(409, {
        code: API_ERROR_CODES.REGULATED_AUTH_REQUIRED,
        message: "raw server detail",
        blockedCategories: [blocked("EXPIRED")],
      }),
    );
    expect(copy).toContain("license has expired");
    expect(copy).not.toContain("raw server detail");
  });

  it("returns null for any other error", () => {
    expect(regulatedAuthErrorCopy(axiosErr(409, { code: "MERGE_CHOICE_REQUIRED" }))).toBeNull();
    expect(
      regulatedAuthErrorCopy(axiosErr(400, { code: API_ERROR_CODES.REGULATED_AUTH_REQUIRED })),
    ).toBeNull();
    expect(regulatedAuthErrorCopy(new Error("network"))).toBeNull();
    expect(regulatedAuthErrorCopy(null)).toBeNull();
  });
});
