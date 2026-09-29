import { INVOICE_ITEM_SYSTEM_KIND_VALUES } from "@routeflow/types";
import {
  NSF_FEE_DESCRIPTION_PREFIX,
  NSF_FEE_SYSTEM_KIND,
  NSF_HAS_TRANSITION_LEG,
  isNsfLine,
  isNsfLineFacts,
} from "./nsf-line";

/**
 * #2392 / SA-478 (A): THE client-safe "is this the system NSF bounce-fee line" predicate, shared by
 * the API (invoices/nsf-line.ts delegates), web and mobile. Mirrors #2169 / SA-395's rule exactly:
 * NSF ⇔ systemKind === "NSF_FEE", OR — while the TRANSITION leg is on — systemKind is null AND the
 * description starts with the NSF prefix.
 */
describe("isNsfLineFacts (#2392, SA-478)", () => {
  const PREFIX = NSF_FEE_DESCRIPTION_PREFIX;
  it.each([
    ["stamped NSF_FEE", { systemKind: "NSF_FEE", description: "anything" }, true, true],
    ["stamped NSF_FEE, leg off", { systemKind: "NSF_FEE", description: null }, false, true],
    [
      "legacy: null kind + prefix, leg on",
      { systemKind: null, description: `${PREFIX} #1` },
      true,
      true,
    ],
    [
      "legacy: null kind + prefix, leg OFF",
      { systemKind: null, description: `${PREFIX} #1` },
      false,
      false,
    ],
    ["undefined kind + prefix, leg on", { description: `${PREFIX} #1` }, true, true],
    [
      "another kind never falls back to the prefix",
      { systemKind: "OTHER", description: `${PREFIX} #1` },
      true,
      false,
    ],
    [
      "a lookalike description is not NSF",
      { systemKind: null, description: "Snack pack (NSF certified)" },
      true,
      false,
    ],
    [
      "prefix must be a PREFIX, not a substring",
      { systemKind: null, description: `Re: ${PREFIX}` },
      true,
      false,
    ],
    ["no facts at all", {}, true, false],
  ] as const)("%s", (_l, line, leg, expected) => {
    expect(isNsfLineFacts(line, leg)).toBe(expected);
  });

  it("the prefix is the API's historical value (byte-identical)", () => {
    expect(NSF_FEE_DESCRIPTION_PREFIX).toBe("NSF fee — returned check");
  });

  it("parity: NSF_FEE_SYSTEM_KIND is a member of @routeflow/types' INVOICE_ITEM_SYSTEM_KIND_VALUES (pinned to Prisma by enum-parity.spec)", () => {
    // No runtime import of @routeflow/types from pricing's source (its entry is raw TS, and the API
    // loads pricing's compiled CJS) — the check-transitions.ts precedent: a local value + this pin.
    expect(INVOICE_ITEM_SYSTEM_KIND_VALUES).toContain(NSF_FEE_SYSTEM_KIND);
  });

  it("isNsfLine uses the live transition flag (on today)", () => {
    expect(NSF_HAS_TRANSITION_LEG).toBe(true);
    expect(isNsfLine({ systemKind: null, description: `${NSF_FEE_DESCRIPTION_PREFIX} #7` })).toBe(
      true,
    );
    expect(isNsfLine({ systemKind: "NSF_FEE" })).toBe(true);
    expect(isNsfLine({ systemKind: null, description: "Cola 12pk" })).toBe(false);
  });
});
