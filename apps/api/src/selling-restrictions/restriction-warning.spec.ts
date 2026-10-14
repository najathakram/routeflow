import * as fs from "fs";
import * as path from "path";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { BlockedLine } from "@routeflow/types";
import {
  decideStaffWrite,
  noRestrictionOverride,
  warningHash,
  type GateLine,
  type HeldLine,
  type StaffJudgement,
} from "./restriction-warning";
import type { StaffBreachDetail } from "./staff-breaches";
import {
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  RESTRICTION_OVERRIDE_REASON_MAX,
  RESTRICTION_OVERRIDE_REASON_MIN,
} from "./override-constants";

/**
 * Row 510: the warning-and-override protocol (pure). Every owner pin of the protocol that needs no database: the 409
 * body and its hash, the resubmit, the stale hash, the reason bounds and the formula guard, an override on a line that
 * is not breached, who may override, sticky coverage, and the re-judge under the lock.
 */
const OPERATOR = { role: "OPERATOR", sub: "user-op" };
const breach = (productId: string, ruleIds: string[], over: Partial<StaffBreachDetail> = {}) =>
  ({
    productId,
    productName: `Product ${productId}`,
    outcome: "BLOCK",
    ruleIds,
    rules: ruleIds.map((id) => ({
      id,
      kind: "STATE_HIT" as const,
      states: ["CA"],
      legal: true,
      reason: "State ban",
    })),
    unknownProduct: false,
    state: "CA",
    ...over,
  }) as StaffBreachDetail;
const judgement = (
  breaches: StaffBreachDetail[],
  basis: "CUSTOMER" | "STORE" = "CUSTOMER",
): StaffJudgement => ({
  outcome: breaches.some((b) => b.outcome === "BLOCK") ? "BLOCK" : "INDETERMINATE",
  reasons: breaches.map((b): BlockedLine => ({
    productId: b.productId,
    productName: b.productName,
    ruleId: b.ruleIds[0] ?? null,
    reason: "STATE_BAN",
    message: `"${b.productName}" can't be sold to a customer in CA`,
  })),
  breaches,
  basis,
});
const blocked = jest.fn(
  (reasons: BlockedLine[], message?: string) =>
    new ConflictException({
      code: "SELLING_RESTRICTED",
      message: message ?? "blocked",
      blockedLines: reasons,
    }),
);
const lines: GateLine[] = [
  { productId: "p1", lineKey: "n:0" },
  { productId: "p2", lineKey: "n:1" },
];
const base = (over: Record<string, unknown> = {}) => ({
  judgement: judgement([breach("p1", ["r1"])]),
  lines,
  principal: OPERATOR,
  customerId: "cust-1",
  blocked,
  ...over,
});
/** Run `fn`, return what it threw (or fail). */
const thrown = (fn: () => unknown): any => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};
const warn = () => thrown(() => decideStaffWrite(base())).getResponse();

describe("decideStaffWrite: the warning", () => {
  it("a breach with no acknowledgement is a 409 RESTRICTION_WARNING with the lines and a hash", () => {
    const e = thrown(() => decideStaffWrite(base()));
    expect(e).toBeInstanceOf(ConflictException);
    const body = e.getResponse();
    expect(body.code).toBe("RESTRICTION_WARNING");
    expect(body.warningHash).toMatch(/^rw1:[0-9a-f]{64}$/);
    expect(body.lines).toEqual([
      {
        lineKey: "n:0",
        productId: "p1",
        displayName: "Product p1",
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
    ]);
  });

  it("nothing breached is no warning and no stamp", () => {
    const d = decideStaffWrite(base({ judgement: judgement([]) }));
    expect(d.stamps).toEqual([]);
    expect(d.active).toBe(false);
  });

  describe("legal copy", () => {
    const textOf = (b: StaffBreachDetail, basis: "CUSTOMER" | "STORE" = "CUSTOMER") =>
      thrown(() => decideStaffWrite(base({ judgement: judgement([b], basis) }))).getResponse()
        .lines[0].rules[0].reasonText;

    it("a state ban names the state; a federal ban says federally", () => {
      expect(textOf(breach("p1", ["r1"]))).toBe("This product is banned in CA by law.");
      expect(
        textOf(
          breach("p1", ["f"], {
            rules: [{ id: "f", kind: "FEDERAL", states: [], legal: true, reason: "x" }],
          }),
        ),
      ).toBe("This product is banned federally by law.");
    });

    it("a malformed rule quotes the admin's reason; an unresolved state asks for the address (the store's on a store basis)", () => {
      expect(
        textOf(
          breach("p1", ["m"], {
            rules: [
              { id: "m", kind: "MALFORMED_STATE", states: [], legal: true, reason: "No gummies" },
            ],
          }),
        ),
      ).toBe("This product is banned by law (No gummies).");
      const pending = breach("p1", ["s"], {
        outcome: "INDETERMINATE",
        state: null,
        rules: [{ id: "s", kind: "STATE_UNRESOLVED", states: ["CA"], legal: true, reason: "x" }],
      });
      expect(textOf(pending)).toBe(
        "This customer's state can't be determined — add or correct the customer's address.",
      );
      expect(textOf(pending, "STORE")).toMatch(/store's state can't be determined/);
    });

    it("an unknown product uses the engine's own message and 'Unknown product'", () => {
      const ghost = breach("ghost", [], {
        outcome: "INDETERMINATE",
        productName: "Unknown product",
        unknownProduct: true,
        rules: [],
        state: null,
      });
      const j = judgement([ghost]);
      j.reasons[0].message =
        "A product on this order can't be checked against selling restrictions.";
      const body = thrown(() =>
        decideStaffWrite(base({ judgement: j, lines: [{ productId: "ghost", lineKey: "n:0" }] })),
      ).getResponse();
      expect(body.lines[0].displayName).toBe("Unknown product");
      expect(body.lines[0].rules[0].reasonText).toMatch(/can't be checked/);
    });
  });
});

describe("decideStaffWrite: the resubmit", () => {
  const ack = (over: Record<string, unknown> = {}) => ({
    restrictionOverrides: [{ lineKey: "n:0", reason: "  Customer is licensed  " }],
    warningHash: warn().warningHash,
    ...over,
  });

  it("the stamp stores the trimmed reason and the SORTED rule ids of the breach", () => {
    const j = judgement([breach("p1", ["rb", "ra"])]);
    const hash = thrown(() => decideStaffWrite(base({ judgement: j }))).getResponse().warningHash;
    const d = decideStaffWrite(
      base({
        judgement: j,
        ack: {
          restrictionOverrides: [{ lineKey: "n:0", reason: "  Licensed buyer  " }],
          warningHash: hash,
        },
      }),
    );
    expect(d.stamps).toEqual([
      { lineKey: "n:0", productId: "p1", reason: "Licensed buyer", ruleIds: ["ra", "rb"] },
    ]);
  });

  it("the acknowledged resubmit stamps each warned line", () => {
    const d = decideStaffWrite(base({ ack: ack() }));
    expect(d.stamps).toEqual([
      { lineKey: "n:0", productId: "p1", reason: "Customer is licensed", ruleIds: ["r1"] },
    ]);
    expect(d.warningHash).toBe(warn().warningHash);
  });

  it("a stale hash is a 409 again with the FRESH hash and list", () => {
    const e = thrown(() => decideStaffWrite(base({ ack: ack({ warningHash: "rw1:stale" }) })));
    expect(e.getResponse().code).toBe("RESTRICTION_WARNING");
    expect(e.getResponse().warningHash).toBe(warn().warningHash);
  });

  it("a missing hash, or a warned line left without a reason, is a 409", () => {
    expect(
      thrown(() => decideStaffWrite(base({ ack: ack({ warningHash: undefined }) }))).getResponse()
        .code,
    ).toBe("RESTRICTION_WARNING");
    expect(
      thrown(() => decideStaffWrite(base({ ack: ack({ restrictionOverrides: [] }) }))).getResponse()
        .code,
    ).toBe("RESTRICTION_WARNING");
  });

  it.each([
    ["2 characters", "ab"],
    ["201 characters", "x".repeat(RESTRICTION_OVERRIDE_REASON_MAX + 1)],
    ["only spaces", "     "],
    ["2 characters once trimmed", "  ab  "],
  ])("a reason of %s is a 400 RESTRICTION_OVERRIDE_REASON_INVALID", (_n, reason) => {
    const e = thrown(() =>
      decideStaffWrite(base({ ack: ack({ restrictionOverrides: [{ lineKey: "n:0", reason }] }) })),
    );
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse().code).toBe("RESTRICTION_OVERRIDE_REASON_INVALID");
  });

  it("the bounds are inclusive (3 and 200 pass)", () => {
    for (const len of [RESTRICTION_OVERRIDE_REASON_MIN, RESTRICTION_OVERRIDE_REASON_MAX]) {
      const d = decideStaffWrite(
        base({ ack: ack({ restrictionOverrides: [{ lineKey: "n:0", reason: "y".repeat(len) }] }) }),
      );
      expect(d.stamps[0].reason).toHaveLength(len);
    }
  });

  it.each(["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(1)"])(
    "a formula-led reason %j is a 400 (a spreadsheet would run it)",
    (reason) => {
      const e = thrown(() =>
        decideStaffWrite(
          base({ ack: ack({ restrictionOverrides: [{ lineKey: "n:0", reason }] }) }),
        ),
      );
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.getResponse().code).toBe("TEXT_CELL_FORMULA_LEAD");
    },
  );

  it("an override naming a line that is not warned is ignored: no error, no stamp", () => {
    const d = decideStaffWrite(
      base({
        ack: ack({
          restrictionOverrides: [
            { lineKey: "n:0", reason: "fine reason" },
            { lineKey: "n:1", reason: "x" }, // p2 is not breached; even an invalid reason on it is ignored
            { lineKey: "n:99", reason: "" },
          ],
        }),
      }),
    );
    expect(d.stamps.map((s) => s.lineKey)).toEqual(["n:0"]);
  });
});

describe("decideStaffWrite: who may override", () => {
  const ackFor = () => ({
    restrictionOverrides: [{ lineKey: "n:0", reason: "Customer is licensed" }],
    warningHash: warn().warningHash,
  });

  it("a DRIVER is hard-blocked with the 'ask the office' message, even with a valid acknowledgement", () => {
    for (const ack of [undefined, ackFor()]) {
      blocked.mockClear();
      const e = thrown(() =>
        decideStaffWrite(base({ principal: { role: "DRIVER", sub: "d" }, ack })),
      );
      expect(e.getResponse()).toMatchObject({
        code: "SELLING_RESTRICTED",
        message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
      });
      expect(blocked).toHaveBeenCalledWith(expect.any(Array), DRIVER_RESTRICTION_BLOCK_MESSAGE);
    }
  });

  it("a SUPER_ADMIN and a system caller (no principal) are hard-blocked too, with the engine's own message", () => {
    for (const principal of [{ role: "SUPER_ADMIN" }, null, undefined]) {
      blocked.mockClear();
      const e = thrown(() => decideStaffWrite(base({ principal, ack: ackFor() })));
      expect(e.getResponse().code).toBe("SELLING_RESTRICTED");
      expect(blocked).toHaveBeenCalledWith(expect.any(Array), undefined);
    }
  });

  it("OPERATOR and TENANT_ADMIN may override", () => {
    for (const role of ["OPERATOR", "TENANT_ADMIN"]) {
      expect(decideStaffWrite(base({ principal: { role }, ack: ackFor() })).stamps).toHaveLength(1);
    }
  });
});

describe("decideStaffWrite: sticky coverage", () => {
  const stamp = (productId: string, ruleIds: string[], id = `li-${productId}`): HeldLine => ({
    id,
    productId,
    status: "PENDING",
    restrictionOverrideReason: "earlier reason",
    restrictionOverrideBy: "user-op",
    restrictionOverrideAt: new Date("2026-10-01T00:00:00Z"),
    restrictionOverrideRuleIds: ruleIds,
  });

  it("a product already carrying a stamp that covers its rules never warns again", () => {
    const d = decideStaffWrite(base({ held: [stamp("p1", ["r1"])] }));
    expect(d.stamps).toEqual([]);
    expect(d.carried).toEqual([expect.objectContaining({ productId: "p1" })]);
  });

  it("a stamp that is a SUPERSET of the breach's rules still covers (a rule since lifted)", () => {
    expect(decideStaffWrite(base({ held: [stamp("p1", ["r1", "r0"])] })).stamps).toEqual([]);
  });

  it("a NEW rule id on a covered product warns again", () => {
    const j = judgement([breach("p1", ["r1", "r2"])]);
    expect(
      thrown(() =>
        decideStaffWrite(base({ judgement: j, held: [stamp("p1", ["r1"])] })),
      ).getResponse().code,
    ).toBe("RESTRICTION_WARNING");
  });

  it("a product the document does not hold (a swap or an add) warns, whatever else is stamped", () => {
    expect(
      thrown(() => decideStaffWrite(base({ held: [stamp("p9", ["r1"])] }))).getResponse().code,
    ).toBe("RESTRICTION_WARNING");
  });

  it("a CANCELLED stamped line does not cover", () => {
    const cancelled = { ...stamp("p1", ["r1"]), status: "CANCELLED" };
    expect(thrown(() => decideStaffWrite(base({ held: [cancelled] }))).getResponse().code).toBe(
      "RESTRICTION_WARNING",
    );
  });
});

describe("warning rows: one per ADDING line of an uncovered product", () => {
  it("a delta <= 0 sibling line gets no row, a new / positive line does", () => {
    const body = thrown(() =>
      decideStaffWrite(
        base({
          lines: [
            { productId: "p1", lineKey: "l:a", qtyDelta: -2 },
            { productId: "p1", lineKey: "n:3", qtyDelta: 3 },
            { productId: "p1", lineKey: "n:4" },
          ],
        }),
      ),
    ).getResponse();
    expect(body.lines.map((l: { lineKey: string }) => l.lineKey)).toEqual(["n:3", "n:4"]);
  });
});

describe("warningHash", () => {
  const rows = [
    { lineKey: "n:1", productId: "p2", outcome: "BLOCK", ruleIds: ["b", "a"] },
    { lineKey: "n:0", productId: "p1", outcome: "BLOCK", ruleIds: ["r1"] },
  ];

  it("is stable under row order and rule-id order", () => {
    const reordered = [{ ...rows[1] }, { ...rows[0], ruleIds: ["a", "b"] }];
    expect(warningHash(rows, "c", "CUSTOMER")).toBe(warningHash(reordered, "c", "CUSTOMER"));
  });

  it("changes with a new rule id, the customer, the basis, the outcome or a line", () => {
    const h = warningHash(rows, "c", "CUSTOMER");
    expect(
      warningHash([{ ...rows[0], ruleIds: ["b", "a", "z"] }, rows[1]], "c", "CUSTOMER"),
    ).not.toBe(h);
    expect(warningHash(rows, "other", "CUSTOMER")).not.toBe(h);
    expect(warningHash(rows, "c", "STORE")).not.toBe(h);
    expect(
      warningHash([{ ...rows[0], outcome: "INDETERMINATE" }, rows[1]], "c", "CUSTOMER"),
    ).not.toBe(h);
    expect(warningHash([rows[0]], "c", "CUSTOMER")).not.toBe(h);
  });

  it("ignores display text (a copy change never invalidates an acknowledgement)", () => {
    const a = warn().warningHash;
    const b = thrown(() =>
      decideStaffWrite(
        base({
          judgement: judgement([
            breach("p1", ["r1"], {
              productName: "Renamed",
              rules: [
                {
                  id: "r1",
                  kind: "STATE_HIT",
                  states: ["CA"],
                  legal: true,
                  reason: "Another reason",
                },
              ],
            }),
          ]),
        }),
      ),
    ).getResponse().warningHash;
    expect(b).toBe(a);
  });
});

describe("recheck under the write's lock", () => {
  const ackFor = () => ({
    restrictionOverrides: [{ lineKey: "l:li-p1", reason: "Customer is licensed" }],
    warningHash: thrown(() =>
      decideStaffWrite(
        base({
          lines: [{ productId: "p1", lineKey: "l:li-p1" }],
          held: [],
        }),
      ),
    ).getResponse().warningHash,
  });
  const oneLine: GateLine[] = [{ productId: "p1", lineKey: "l:li-p1" }];
  const stamped: HeldLine = {
    id: "li-p1",
    productId: "p1",
    status: "PENDING",
    restrictionOverrideReason: "earlier",
    restrictionOverrideBy: "user-op",
    restrictionOverrideAt: new Date("2026-10-01T00:00:00Z"),
    restrictionOverrideRuleIds: ["r1"],
  };

  it("an acknowledged write whose lines are unchanged under the lock passes, and carries held stamps", () => {
    const d = decideStaffWrite(base({ lines: oneLine, ack: ackFor() }));
    const final = d.recheck([{ id: "li-p1", productId: "p1", status: "PENDING" }]);
    expect(final.stamps).toHaveLength(1);
    const withHeld = decideStaffWrite(base({ lines: oneLine, held: [stamped] })).recheck([stamped]);
    expect(withHeld.carried).toEqual([expect.objectContaining({ productId: "p1" })]);
    expect(withHeld.heldStamped.get("li-p1")).toBe("p1");
  });

  it("a stamp that covered the product pre-lock and was CLEARED under it is a 409 with the fresh list (hash changed under the lock)", () => {
    const d = decideStaffWrite(base({ lines: oneLine, held: [stamped] })); // covered: no warning
    const e = thrown(() => d.recheck([{ id: "li-p1", productId: "p1", status: "PENDING" }]));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse().code).toBe("RESTRICTION_WARNING");
    expect(e.getResponse().lines.map((l: { lineKey: string }) => l.lineKey)).toEqual(["l:li-p1"]);
  });

  it("a DRIVER's recheck that finds an uncovered product is the hard block, never a warning", () => {
    const d = decideStaffWrite(
      base({ principal: { role: "DRIVER" }, lines: oneLine, judgement: judgement([]) }),
    );
    expect(d.stamps).toEqual([]);
    const withBreach = decideStaffWrite(
      base({ principal: { role: "DRIVER" }, lines: oneLine, held: [stamped] }),
    );
    expect(() => withBreach.recheck([{ id: "li-p1", productId: "p1", status: "PENDING" }])).toThrow(
      ConflictException,
    );
    expect(blocked).toHaveBeenCalledWith(expect.any(Array), DRIVER_RESTRICTION_BLOCK_MESSAGE);
  });

  it("the judged lines can be replaced (promote / reopen judge every live line of the locked order)", () => {
    const d = decideStaffWrite(base({ lines: oneLine, held: [stamped] }));
    const e = thrown(() =>
      d.recheck(
        [{ id: "li-new", productId: "p1", status: "PENDING" }],
        [{ productId: "p1", lineKey: "l:li-new" }],
      ),
    );
    expect(e.getResponse().lines[0].lineKey).toBe("l:li-new");
  });
});

describe("noRestrictionOverride", () => {
  it("never warns, carries held stamps on a recheck, and is inactive", () => {
    const d = noRestrictionOverride();
    expect(d.active).toBe(false);
    const held: HeldLine = {
      id: "li-1",
      productId: "p1",
      restrictionOverrideAt: new Date(),
      restrictionOverrideRuleIds: ["r1"],
      restrictionOverrideReason: "x",
      restrictionOverrideBy: "u",
    };
    expect(d.recheck([held]).carried).toHaveLength(1);
  });
});

describe("pins", () => {
  const SRC = path.resolve(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(full, out);
      } else if (e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("NO other source file builds a RESTRICTION_WARNING body (the copy and the hash live in restriction-warning.ts)", () => {
    const offenders = walk(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((rel) => {
        const code = strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
        return /RESTRICTION_WARNING|RESTRICTION_OVERRIDE_CODES\.warning/.test(code);
      })
      // the code names themselves
      .filter(
        (rel) =>
          !["common/api-error-codes.ts", "selling-restrictions/override-constants.ts"].includes(
            rel,
          ),
      );
    expect(offenders).toEqual(["selling-restrictions/restriction-warning.ts"]);
  });

  it("the tenant switch gates nothing in the engine: restrictionsApply and switchGated are gone", () => {
    const offenders = walk(SRC)
      .map((f) => ({ rel: path.relative(SRC, f), code: strip(fs.readFileSync(f, "utf8")) }))
      .filter(({ code }) => /\brestrictionsApply\b|\bswitchGated\b/.test(code))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
