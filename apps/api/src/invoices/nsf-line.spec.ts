import { NSF_FEE_DESCRIPTION_PREFIX } from "../sales-agents/commission-math";
import {
  HAS_TRANSITION_LEG,
  InvoiceItemSystemKind,
  buildNotNsfLineWhere,
  isNsfLine,
  isNsfLineWithLeg,
  notNsfLineWhere,
} from "./nsf-line";

/**
 * #2169 (SA-395) — per-branch pins for the shared dual-read predicate. See nsf-line.ts's header
 * for the rule; commission-engine.service.spec.ts and uncategorised-lines.spec.ts pin the two
 * real consumers on top of this.
 */
describe("isNsfLine", () => {
  it("stamped systemKind NSF_FEE -> true, regardless of the description", () => {
    expect(
      isNsfLine({ systemKind: InvoiceItemSystemKind.NSF_FEE, description: "anything at all" }),
    ).toBe(true);
  });

  it("TRANSITION leg: systemKind NULL + description starts with the prefix -> true today (isNsfLine uses the live HAS_TRANSITION_LEG flag)", () => {
    const line = { systemKind: null, description: `${NSF_FEE_DESCRIPTION_PREFIX} CHK-1001` };
    expect(HAS_TRANSITION_LEG).toBe(true); // sanity: the pins below assume today's live value
    expect(isNsfLine(line)).toBe(true);
  });

  it("TRANSITION leg pin (isNsfLineWithLeg, both states — no dead branch): flips to false the day HAS_TRANSITION_LEG is deleted after the backfill", () => {
    const line = { systemKind: null, description: `${NSF_FEE_DESCRIPTION_PREFIX} CHK-1001` };
    expect(isNsfLineWithLeg(line, true)).toBe(true);
    expect(isNsfLineWithLeg(line, false)).toBe(false);
  });

  it("systemKind NULL + description does NOT start with the prefix -> false", () => {
    expect(isNsfLine({ systemKind: null, description: "Widget line" })).toBe(false);
  });

  it("stamped systemKind NSF_FEE + a NON-prefix description -> still true (the stamp wins)", () => {
    expect(
      isNsfLine({ systemKind: InvoiceItemSystemKind.NSF_FEE, description: "Widget line" }),
    ).toBe(true);
  });

  // A custom line with a DIFFERENT systemKind value is n/a: the enum has exactly one member
  // (NSF_FEE) today, so there is no other stamped value to construct — skipped per the brief.

  it("missing description (undefined) never throws and is treated as non-matching", () => {
    expect(isNsfLine({ systemKind: null })).toBe(false);
    expect(isNsfLine({})).toBe(false);
  });
});

describe("buildNotNsfLineWhere / notNsfLineWhere (m2: the Prisma fragment mirrors isNsfLineWithLeg's gate)", () => {
  it("the exported `notNsfLineWhere` is built from the LIVE HAS_TRANSITION_LEG flag", () => {
    expect(notNsfLineWhere).toEqual(buildNotNsfLineWhere(HAS_TRANSITION_LEG));
  });

  it("HAS_TRANSITION_LEG=true: excludes stamped NSF_FEE rows AND NULL+prefix rows (the prefix leg is live)", () => {
    const where = buildNotNsfLineWhere(true);
    expect(where).toEqual({
      AND: [
        { OR: [{ systemKind: null }, { systemKind: { not: InvoiceItemSystemKind.NSF_FEE } }] },
        {
          NOT: {
            AND: [
              { systemKind: null },
              { description: { startsWith: NSF_FEE_DESCRIPTION_PREFIX } },
            ],
          },
        },
      ],
    });
  });

  it("HAS_TRANSITION_LEG=false: the prefix leg is GONE — 'not NSF' is simply 'not stamped', no description read at all", () => {
    const where = buildNotNsfLineWhere(false);
    expect(where).toEqual({
      OR: [{ systemKind: null }, { systemKind: { not: InvoiceItemSystemKind.NSF_FEE } }],
    });
    expect(JSON.stringify(where)).not.toContain(NSF_FEE_DESCRIPTION_PREFIX);
  });
});

// #2392 / SA-478: the API's HAS_TRANSITION_LEG and the clients' @routeflow/pricing
// NSF_HAS_TRANSITION_LEG are one state — deleting the prefix leg flips BOTH together.
describe("#2392 — the transition flag is shared with the clients", () => {
  it("HAS_TRANSITION_LEG === @routeflow/pricing NSF_HAS_TRANSITION_LEG", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NSF_HAS_TRANSITION_LEG } = require("@routeflow/pricing") as {
      NSF_HAS_TRANSITION_LEG: boolean;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HAS_TRANSITION_LEG } = require("./nsf-line") as { HAS_TRANSITION_LEG: boolean };
    expect(HAS_TRANSITION_LEG).toBe(NSF_HAS_TRANSITION_LEG);
  });
});
