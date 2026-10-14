import {
  API_ERROR_CODES,
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  type RestrictionWarningError,
} from "@routeflow/types";
import {
  buildAck,
  checkOverrideReason,
  mergeAck,
  parseDriverRestrictionBlock,
  parseRestrictionWarning,
  ruleText,
  splitIdAck,
} from "../lib/restriction-warning";

const warning: RestrictionWarningError = {
  code: API_ERROR_CODES.RESTRICTION_WARNING,
  message: "Some items are restricted.",
  warningHash: "rw1:abc",
  lines: [
    {
      lineKey: "n:0",
      productId: "p1",
      displayName: "Acme Gummies",
      outcome: "BLOCK",
      rules: [
        {
          id: "r1",
          states: ["CA"],
          legal: true,
          reasonText: "This product is banned in CA by law.",
        },
      ],
    },
    {
      lineKey: "n:2",
      productId: "p2",
      displayName: "Acme Vape",
      outcome: "BLOCK",
      rules: [{ id: "r2", states: ["CA"], legal: false, reasonText: "Limited in CA." }],
    },
  ],
};

const axiosErr = (status: number, data: unknown) => ({ response: { status, data } });

describe("parseRestrictionWarning", () => {
  it("returns the 409 RESTRICTION_WARNING body", () => {
    expect(parseRestrictionWarning(axiosErr(409, warning))).toEqual(warning);
  });
  it("reads a PosFinishError-shaped error (response kept on the wrapper)", () => {
    expect(
      parseRestrictionWarning({ message: "POS finish", response: { status: 409, data: warning } }),
    ).toEqual(warning);
  });
  it.each([
    [409, { code: "SELLING_RESTRICTED" }],
    [400, warning],
    [409, { ...warning, lines: [] }],
    [409, { ...warning, lines: undefined }],
    [409, { ...warning, warningHash: "" }],
  ])("is null for status %i %j", (status, data) => {
    expect(parseRestrictionWarning(axiosErr(status, data))).toBeNull();
  });
  it("is null for a non-axios error", () => {
    expect(parseRestrictionWarning(new Error("x"))).toBeNull();
    expect(parseRestrictionWarning(null)).toBeNull();
  });
});

describe("parseDriverRestrictionBlock", () => {
  const blockedLines = [
    {
      productId: "p1",
      productName: "Acme Gummies",
      ruleId: "r1",
      reason: "STATE_BAN",
      state: "CA",
      message: "m",
    },
  ];
  it("recognises the driver 409 SELLING_RESTRICTED by its fixed message", () => {
    const got = parseDriverRestrictionBlock(
      axiosErr(409, {
        code: "SELLING_RESTRICTED",
        message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
        blockedLines,
      }),
    );
    expect(got).toEqual({ message: DRIVER_RESTRICTION_BLOCK_MESSAGE, lines: blockedLines });
  });
  it("is null for an ordinary SELLING_RESTRICTED (buyer or other staff refusal)", () => {
    expect(
      parseDriverRestrictionBlock(
        axiosErr(409, { code: "SELLING_RESTRICTED", message: "x", blockedLines }),
      ),
    ).toBeNull();
  });
});

describe("checkOverrideReason", () => {
  it.each([
    ["", false],
    ["ab", false],
    ["  ab  ", false],
    ["abc", true],
    ["  abc  ", true],
    ["x".repeat(200), true],
    ["x".repeat(201), false],
    [" " + "x".repeat(200) + " ", true],
  ])("%j -> ok %s (trimmed length rule 3..200)", (raw, ok) => {
    const r = checkOverrideReason(raw);
    expect(r.ok).toBe(ok);
    expect(r.value).toBe(raw.trim());
    expect(r.error === null).toBe(ok);
  });
  it("counts the trimmed length", () => {
    expect(checkOverrideReason("  abcd ").length).toBe(4);
  });
});

describe("buildAck / mergeAck", () => {
  it("sends the SAME trimmed reason for every listed line, plus the server's hash", () => {
    expect(buildAck(warning, "  Owner approved the sale  ")).toEqual({
      restrictionOverrides: [
        { lineKey: "n:0", reason: "Owner approved the sale" },
        { lineKey: "n:2", reason: "Owner approved the sale" },
      ],
      warningHash: "rw1:abc",
    });
  });
  it("refuses to build an ack from an invalid reason", () => {
    expect(() => buildAck(warning, "no")).toThrow();
  });
  it("mergeAck keeps the original payload and adds only the ack fields", () => {
    const payload = { customerId: "c1", items: [{ productId: "p1", qty: 2 }] };
    const ack = buildAck(warning, "Owner approved");
    expect(mergeAck(payload, ack)).toEqual({ ...payload, ...ack });
    expect(mergeAck(payload, null)).toBe(payload);
  });
  it("a bare id stays a bare id with no ack, and becomes { id, ...ack } with one", () => {
    const ack = buildAck(warning, "Owner approved");
    expect(mergeAck("o1", null)).toBe("o1");
    expect(mergeAck("o1", ack)).toEqual({ id: "o1", ...ack });
  });
  it("splitIdAck separates a bare id from an id carrying an ack", () => {
    const ack = buildAck(warning, "Owner approved");
    expect(splitIdAck("o1")).toEqual({ id: "o1", ack: undefined });
    expect(splitIdAck({ id: "o1", ...ack })).toEqual({ id: "o1", ack });
  });
});

describe("ruleText", () => {
  it("uses the server's fixed copy", () => {
    expect(ruleText(warning.lines[0].rules[0])).toBe("This product is banned in CA by law.");
  });
  it("falls back to the legal copy with the state filled in when the text is missing", () => {
    expect(ruleText({ id: "r", states: ["CA"], legal: true, reasonText: "" })).toBe(
      "This product is banned in CA by law.",
    );
  });
});
