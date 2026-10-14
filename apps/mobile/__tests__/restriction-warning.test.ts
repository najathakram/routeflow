import {
  API_ERROR_CODES,
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
  type RestrictionWarningError,
  type RestrictionWarningLine,
} from "@routeflow/types";
import {
  RESTRICTION_COPY,
  buildAck,
  checkOverrideReason,
  mergeAck,
  driverBlockRows,
  parseRestrictionHardBlock,
  parseRestrictionWarning,
  isRepeatWarning,
  lineRuleRows,
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

describe("parseRestrictionHardBlock", () => {
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
    const got = parseRestrictionHardBlock(
      axiosErr(409, {
        code: "SELLING_RESTRICTED",
        message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
        blockedLines,
      }),
    );
    expect(got).toEqual({
      message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
      lines: blockedLines,
      ruleLines: [],
    });
  });
  const ruleLines = [
    {
      lineKey: "n:0",
      productId: "p1",
      displayName: "Acme Gummies",
      outcome: "BLOCK" as const,
      rules: [
        {
          id: "r1",
          states: ["CA"],
          legal: true,
          reasonText: "This product is banned in CA by law.",
        },
      ],
    },
  ];
  it("carries the per-rule lines the server adds to the driver body", () => {
    const got = parseRestrictionHardBlock(
      axiosErr(409, {
        code: "SELLING_RESTRICTED",
        message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
        blockedLines,
        lines: ruleLines,
      }),
    );
    expect(got?.ruleLines).toEqual(ruleLines);
  });
  it("driverBlockRows shows the same outcome text and legal badge staff see", () => {
    expect(driverBlockRows(ruleLines)).toEqual([
      {
        key: "n:0",
        name: "Acme Gummies",
        items: [{ text: "This product is banned in CA by law.", legal: true }],
      },
    ]);
    expect(driverBlockRows([{ ...ruleLines[0], rules: [] }])[0].items).toEqual([
      { text: RESTRICTION_COPY.unchecked, legal: false },
    ]);
  });
  it("recognises a support session's hard block ('Ask the account admin') the same way, echoing its own message", () => {
    const got = parseRestrictionHardBlock(
      axiosErr(409, {
        code: "SELLING_RESTRICTED",
        message: SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
        blockedLines,
        lines: ruleLines,
      }),
    );
    expect(got).toEqual({ message: "Ask the account admin", lines: blockedLines, ruleLines });
  });
  it("is null for an ordinary SELLING_RESTRICTED (buyer or other staff refusal)", () => {
    expect(
      parseRestrictionHardBlock(
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

describe("repeat 409 (the server's list changed under the re-send)", () => {
  it("says so in the fixed copy", () => {
    expect(RESTRICTION_COPY.listChanged).toBe("The list changed; review it again");
  });
  it("is a repeat only when a DIFFERENT hash answers the re-send of the previous one (no time window)", () => {
    expect(isRepeatWarning(null, "rw1:aaa")).toBe(false); // a first warning
    expect(isRepeatWarning("rw1:aaa", "rw1:aaa")).toBe(false); // the same list again
    expect(isRepeatWarning("rw1:aaa", "rw1:bbb")).toBe(true); // the list changed
  });
});

describe("lineRuleRows: the displayed rule lines of one product (display-only dedupe)", () => {
  const rule = (id: string, over: Partial<RestrictionWarningLine["rules"][number]> = {}) => ({
    id,
    states: ["CA"],
    legal: true,
    reasonText: "This product is banned in CA by law.",
    ...over,
  });

  it("two rules with the same state and wording show ONE line", () => {
    expect(lineRuleRows([rule("r1"), rule("r2")])).toEqual([
      {
        key: "This product is banned in CA by law.",
        text: "This product is banned in CA by law.",
        legal: true,
      },
    ]);
  });

  it("the merge is keyed on what is DISPLAYED: [CA] and [CA, NV] both read 'banned in CA', so they show ONE line", () => {
    const rows = lineRuleRows([rule("r1"), rule("r2", { states: ["CA", "NV"] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("This product is banned in CA by law.");
    expect(rows[0].legal).toBe(true);
  });

  it("[CA] + [CA, NV] + [CA] is still ONE line (a later twin never splits an earlier merge)", () => {
    const rows = lineRuleRows([rule("r1"), rule("r2", { states: ["CA", "NV"] }), rule("r3")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].legal).toBe(true);
  });

  it("a CA legal ban plus a CA non-legal rule with DIFFERENT text are two lines, in order", () => {
    const rows = lineRuleRows([
      rule("r1"),
      rule("r2", { states: ["CA", "NV"], legal: false, reasonText: "Limited in CA." }),
    ]);
    expect(rows.map((r) => r.text)).toEqual([
      "This product is banned in CA by law.",
      "Limited in CA.",
    ]);
    expect(rows.map((r) => r.legal)).toEqual([true, false]);
  });

  it("a different state, or different wording, is its own line; order is kept", () => {
    const rows = lineRuleRows([
      rule("r1"),
      rule("r2", { states: ["TX"], reasonText: "This product is banned in TX by law." }),
      rule("r3", { reasonText: "Limited in CA.", legal: false }),
      rule("r4"),
    ]);
    expect(rows.map((r) => r.text)).toEqual([
      "This product is banned in CA by law.",
      "This product is banned in TX by law.",
      "Limited in CA.",
    ]);
    expect(rows.map((r) => r.legal)).toEqual([true, true, false]);
  });

  it("a merged line is legal when ANY merged rule is legal (the badge never disappears)", () => {
    const rows = lineRuleRows([
      rule("r1", { legal: false, reasonText: "Same words." }),
      rule("r2", { legal: true, reasonText: "Same words." }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].legal).toBe(true);
  });

  it("falls back to the legal sentence built from the states when the text is missing, and still dedupes", () => {
    expect(
      lineRuleRows([rule("r1", { reasonText: "" }), rule("r2", { reasonText: "" })]),
    ).toHaveLength(1);
  });

  it("deduping a [CA] + [CA, NV] pair leaves the ack and the echoed hash exactly as the server sent them", () => {
    const line = {
      lineKey: "n:0",
      productId: "p1",
      displayName: "Acme Gummies",
      outcome: "BLOCK" as const,
      rules: [rule("r1"), rule("r2", { states: ["CA", "NV"] })],
    };
    expect(buildAck({ ...warning, lines: [line] }, "Owner approved")).toEqual({
      restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    });
    expect(line.rules).toHaveLength(2); // the input is never mutated
  });

  it("is display-only: the ack still covers the line and echoes the server's hash, whatever the rule count", () => {
    const line = {
      lineKey: "n:0",
      productId: "p1",
      displayName: "Acme Gummies",
      outcome: "BLOCK" as const,
      rules: [rule("r1"), rule("r2"), rule("r3")],
    };
    const doubled = { ...warning, lines: [line] };
    expect(buildAck(doubled, "Owner approved")).toEqual({
      restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    });
  });

  it("the driver block shows one line for two identically worded rules too", () => {
    const rows = driverBlockRows([
      {
        lineKey: "n:0",
        productId: "p1",
        displayName: "Acme Gummies",
        outcome: "BLOCK",
        rules: [rule("r1"), rule("r2")],
      },
    ]);
    expect(rows[0].items).toEqual([{ text: "This product is banned in CA by law.", legal: true }]);
  });
});
