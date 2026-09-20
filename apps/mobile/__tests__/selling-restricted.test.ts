import type { BlockedLine } from "@routeflow/types";
import {
  describeBlockedLine,
  parseSellingRestrictedError,
  summarizeRestrictedBlock,
} from "../lib/selling-restricted";

const line = (o: Partial<BlockedLine> = {}): BlockedLine => ({
  productId: "p1",
  productName: "Acme Gummies",
  ruleId: "r1",
  reason: "STATE_BAN",
  state: "TX",
  message: "Acme Gummies can't be sold in TX",
  ...o,
});

describe("parseSellingRestrictedError", () => {
  it("returns the blocked lines on a SELLING_RESTRICTED 409", () => {
    const lines = [line()];
    const err = {
      response: { status: 409, data: { code: "SELLING_RESTRICTED", blockedLines: lines } },
    };
    expect(parseSellingRestrictedError(err)).toEqual(lines);
  });

  it("returns null for anything else: another 409 code, another status, no response, a plain Error", () => {
    expect(
      parseSellingRestrictedError({
        response: { status: 409, data: { code: "REGULATED_AUTH_REQUIRED" } },
      }),
    ).toBeNull();
    expect(
      parseSellingRestrictedError({
        response: { status: 400, data: { code: "SELLING_RESTRICTED" } },
      }),
    ).toBeNull();
    expect(parseSellingRestrictedError({ response: { status: 409, data: {} } })).toBeNull();
    expect(parseSellingRestrictedError(new Error("network"))).toBeNull();
    expect(parseSellingRestrictedError(null)).toBeNull();
    expect(parseSellingRestrictedError(undefined)).toBeNull();
  });

  it("tolerates a SELLING_RESTRICTED body with no (or a malformed) blockedLines list", () => {
    expect(
      parseSellingRestrictedError({
        response: { status: 409, data: { code: "SELLING_RESTRICTED" } },
      }),
    ).toEqual([]);
    expect(
      parseSellingRestrictedError({
        response: { status: 409, data: { code: "SELLING_RESTRICTED", blockedLines: "nope" } },
      }),
    ).toEqual([]);
  });

  it("survives malformed entries inside blockedLines (null, non-object, non-string fields)", () => {
    const err = {
      response: {
        status: 409,
        data: {
          code: "SELLING_RESTRICTED",
          blockedLines: [null, "x", 7, { productId: 5, message: { a: 1 }, reason: "FEDERAL_BAN" }],
        },
      },
    };
    const lines = parseSellingRestrictedError(err)!;
    expect(lines).toHaveLength(1);
    expect(() => summarizeRestrictedBlock(lines)).not.toThrow();
    expect(summarizeRestrictedBlock(lines).body).toBe("• An item: Restricted by federal rule");
  });

  it("does not claim a REGULATED_AUTH_REQUIRED block (the two guards stay distinct)", () => {
    const regulated = {
      response: { status: 409, data: { code: "REGULATED_AUTH_REQUIRED", blockedCategories: [] } },
    };
    expect(parseSellingRestrictedError(regulated)).toBeNull();
  });
});

describe("describeBlockedLine", () => {
  it("prefers the server's own message — it knows the rule's reason and window", () => {
    expect(describeBlockedLine(line({ message: "Banned in TX until 2027" }))).toBe(
      "Banned in TX until 2027",
    );
  });

  it.each<[BlockedLine["reason"], Partial<BlockedLine>, string]>([
    ["FEDERAL_BAN", {}, "Restricted by federal rule"],
    ["STATE_BAN", { state: "TX" }, "Restricted in TX"],
    ["STATE_BAN", { state: undefined }, "Restricted in this customer's state"],
    ["BUYER_PORTAL_ONLY", {}, "Not sold through the buyer portal"],
    ["INDETERMINATE_ADDRESS", {}, "This customer's state isn't on file"],
    ["UNKNOWN_PRODUCT", {}, "Product not found"],
  ])("falls back by reason when there is no message: %s", (reason, extra, expected) => {
    expect(describeBlockedLine(line({ reason, message: "", ...extra }))).toBe(expected);
  });

  it("treats a whitespace-only message as absent", () => {
    expect(describeBlockedLine(line({ message: "   ", reason: "FEDERAL_BAN" }))).toBe(
      "Restricted by federal rule",
    );
  });
});

describe("summarizeRestrictedBlock", () => {
  it("titles by count (singular / plural) and lists each product with its reason", () => {
    const one = summarizeRestrictedBlock([line()]);
    expect(one.title).toBe("1 item can't be sold to this customer");
    expect(one.body).toBe("• Acme Gummies: Acme Gummies can't be sold in TX");

    const two = summarizeRestrictedBlock([
      line(),
      line({ productId: "p2", productName: "Vape", reason: "FEDERAL_BAN", message: "" }),
    ]);
    expect(two.title).toBe("2 items can't be sold to this customer");
    expect(two.body.split("\n")).toHaveLength(2);
    expect(two.body).toContain("• Vape: Restricted by federal rule");
  });

  it("collapses duplicate products to one entry", () => {
    const s = summarizeRestrictedBlock([
      line(),
      line(),
      line({ productId: "p2", productName: "B" }),
    ]);
    expect(s.title).toBe("2 items can't be sold to this customer");
    expect(s.body.split("\n")).toHaveLength(2);
  });

  it("when EVERY entry is an unresolved address, the fix is the address — not the products", () => {
    const s = summarizeRestrictedBlock([
      line({ reason: "INDETERMINATE_ADDRESS", message: "" }),
      line({ productId: "p2", reason: "INDETERMINATE_ADDRESS", message: "" }),
    ]);
    expect(s.title).toBe("Can't check what this customer can buy");
    expect(s.body).toMatch(/Add a default address with a state/);
    expect(s.body).not.toMatch(/Acme Gummies/);
  });

  it("a MIX of address failures and real bans lists every product (the bans matter most)", () => {
    const s = summarizeRestrictedBlock([
      line({ reason: "INDETERMINATE_ADDRESS", message: "" }),
      line({ productId: "p2", productName: "Vape", reason: "FEDERAL_BAN", message: "" }),
    ]);
    expect(s.title).toBe("2 items can't be sold to this customer");
    expect(s.body).toContain("Vape: Restricted by federal rule");
  });

  it("an empty list still says something rather than showing a blank alert", () => {
    expect(summarizeRestrictedBlock([])).toEqual({
      title: "Can't sell this to the customer",
      body: "A selling restriction applies.",
    });
  });

  it("does not mutate its input", () => {
    const input = [line(), line({ productId: "p2" })];
    const before = JSON.stringify(input);
    summarizeRestrictedBlock(input);
    expect(input).toHaveLength(2);
    expect(JSON.stringify(input)).toBe(before);
  });
});
