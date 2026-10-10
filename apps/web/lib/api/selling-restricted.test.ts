import {
  buyerBlockedMessage,
  parseSellingRestricted,
  restrictionReasonText,
} from "./selling-restricted";

const api = (status: number, data: object) => ({ response: { status, data } });
const line = {
  productId: "p1",
  productName: "Hemp Gummies",
  ruleId: "r1",
  reason: "STATE_BAN" as const,
  state: "TX",
  message: "m",
};

describe("parseSellingRestricted", () => {
  it("returns the blocked lines for the 409 SELLING_RESTRICTED, and null for anything else", () => {
    expect(
      parseSellingRestricted(api(409, { code: "SELLING_RESTRICTED", blockedLines: [line] })),
    ).toEqual([line]);
    expect(parseSellingRestricted(api(409, { code: "MERGE_CHOICE_REQUIRED" }))).toBeNull();
    expect(parseSellingRestricted(api(400, { code: "SELLING_RESTRICTED" }))).toBeNull();
    expect(parseSellingRestricted(new Error("network"))).toBeNull();
    expect(parseSellingRestricted(undefined)).toBeNull();
  });
});

describe("parseSellingRestricted, refusals without detail", () => {
  it.each([[undefined], [[]]])("never returns an empty list (blockedLines: %j)", (blockedLines) => {
    const lines = parseSellingRestricted(
      api(409, { code: "SELLING_RESTRICTED", blockedLines, message: "Some items can't be sold" }),
    );
    expect(lines).toHaveLength(1);
    expect(lines?.[0]).toMatchObject({ productName: "An item on this order", ruleId: null });
    // B986: the detail-less refusal never carries the server's top-level sentence.
    expect(lines?.[0].message).toBe("");
  });
});

describe("restrictionReasonText", () => {
  it.each([
    [{ reason: "FEDERAL_BAN" as const }, "Restricted by federal law"],
    [{ reason: "STATE_BAN" as const, state: "TX" }, "Restricted in TX"],
    [{ reason: "STATE_BAN" as const }, "Restricted"],
    [{ reason: "BUYER_PORTAL_ONLY" as const }, "Not available for online ordering"],
    [
      { reason: "INDETERMINATE_ADDRESS" as const },
      expect.stringMatching(/default address with a state/),
    ],
    [{ reason: "UNKNOWN_PRODUCT" as const }, expect.stringMatching(/couldn't be checked/)],
  ])("%j -> plain language, never a raw enum", (l, want) => {
    const text = restrictionReasonText(l);
    expect(text).toEqual(want);
    expect(text).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/);
  });
});

describe("buyerBlockedMessage", () => {
  it("names the items only, once each — never the rule, state or reason", () => {
    const msg = buyerBlockedMessage([
      { productId: "p1", productName: "Hemp Gummies" },
      { productId: "p1", productName: "Hemp Gummies" },
      { productId: "p2", productName: "Vape Pen" },
    ]);
    expect(msg).toBe(
      "Some items can't be ordered right now: Hemp Gummies, Vape Pen. Remove them from your cart and try again.",
    );
    expect(msg).not.toMatch(/TX|federal|restricted/i);
  });

  it("falls back to a generic line for an empty list", () => {
    expect(buyerBlockedMessage([])).toMatch(/Some items in your cart can't be ordered/);
  });

  it("counts lines it cannot name instead of silently dropping them", () => {
    expect(
      buyerBlockedMessage([
        { productId: "p1", productName: "Hemp Gummies" },
        { productId: "p2", productName: "" },
        { productId: "p3", productName: "" },
      ]),
    ).toBe(
      "Some items can't be ordered right now: Hemp Gummies and 2 other items. Remove them from your cart and try again.",
    );
  });

  it("the parser's detail-less placeholder reads as the generic line, not as an item name", () => {
    const placeholder = parseSellingRestricted(api(409, { code: "SELLING_RESTRICTED" }));
    expect(buyerBlockedMessage(placeholder ?? [])).toMatch(/Some items in your cart can't be/);
  });
});
