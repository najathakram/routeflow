import * as fs from "fs";
import * as path from "path";
import {
  evaluateRestrictions,
  type EvaluateInput,
  type ProductFacts,
  type RestrictionRuleFacts,
} from "./selling-restrictions.core";
import { staffBreaches } from "./staff-breaches";

/**
 * Row 672 / SA-844 (SA-836 Full gate G4, "every INDETERMINATE answer names its fix"): the inventory pin.
 *
 * The class is "an INDETERMINATE restriction answer with no fix named". Two producers build one: the engine's reason
 * (`evaluateRestrictions`) and the staff breach (`staffBreaches`). Both read the one decider
 * `unresolvedStateRemedy`. This spec fails when either producer drops it, and when a third producer appears.
 *
 * `remedy` stays optional on the shared type, with exactly these exemptions, each because there is nothing to add in
 * place (SA-844 R5): a customer sale with no customer read (no id sent, or not this tenant's), a JS caller that
 * names no source, and an unresolvable product (no rule matched, so no state is missing). Nothing else may lack it.
 */
const AT = new Date("2026-10-23T12:00:00Z");
const day = (n: number) => new Date(AT.getTime() + n * 86_400_000);

const rule = (over: Partial<RestrictionRuleFacts> = {}): RestrictionRuleFacts => ({
  id: "ban",
  categoryId: "cat-thc",
  productId: null,
  jurisdiction: "STATE",
  states: ["CA"],
  surface: "ALL",
  effectiveFrom: day(-30),
  effectiveTo: null,
  liftedAt: null,
  reason: "State ban",
  ...over,
});
const product = (over: Partial<ProductFacts> = {}): ProductFacts => ({
  id: "p1",
  name: "Gummies",
  effectiveCategoryIds: new Set(["cat-thc"]),
  ...over,
});
const unresolved = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  channel: "STAFF",
  at: AT,
  products: [product()],
  rules: [rule()],
  governingState: { resolved: false },
  categoryNames: new Map([["cat-thc", "THC"]]),
  ...over,
});

interface Cell {
  name: string;
  input: EvaluateInput;
  /** The expected remedy fields, or null when the cell is one of the named exemptions. */
  want: { remedy: string; customerId?: string; addressId?: string } | null;
}

const CELLS: Cell[] = [
  {
    name: "a counter / pickup sale judged at the store (storeJudged only)",
    input: unresolved({ storeJudged: true }),
    want: { remedy: "ADD_STORE_STATE" },
  },
  {
    name: "a store-based state source",
    input: unresolved({ stateSource: { basis: "STORE", customerId: null } }),
    want: { remedy: "ADD_STORE_STATE" },
  },
  {
    name: "a real customer of this tenant",
    input: unresolved({ stateSource: { basis: "CUSTOMER", customerId: "c1" } }),
    want: { remedy: "ADD_CUSTOMER_STATE", customerId: "c1" },
  },
  {
    name: "a real customer whose one governing address is known",
    input: unresolved({ stateSource: { basis: "CUSTOMER", customerId: "c1", addressId: "a1" } }),
    want: { remedy: "ADD_CUSTOMER_STATE", customerId: "c1", addressId: "a1" },
  },
  {
    name: "EXEMPT (SA-844 R5): a customer sale with no customer read",
    input: unresolved({ stateSource: { basis: "CUSTOMER", customerId: null } }),
    want: null,
  },
  {
    name: "EXEMPT: a JS caller naming no source and not store-judged",
    input: unresolved(),
    want: null,
  },
];

describe("SA-836 G4 / row 672: every INDETERMINATE answer names its fix", () => {
  it.each(CELLS)("engine reason: $name", ({ input, want }) => {
    const res = evaluateRestrictions(input);
    expect(res.outcome).toBe("INDETERMINATE");
    expect(res.reasons).toHaveLength(1);
    const reason = res.reasons[0] as unknown as Record<string, unknown>;
    if (want) expect(reason).toMatchObject(want);
    else expect(reason).not.toHaveProperty("remedy");
  });

  it.each(CELLS)("staff breach: $name", ({ input, want }) => {
    const breaches = staffBreaches(input);
    expect(breaches).toHaveLength(1);
    const breach = breaches[0] as unknown as Record<string, unknown>;
    expect(breach.outcome).toBe("INDETERMINATE");
    if (want) expect(breach).toMatchObject(want);
    else expect(breach).not.toHaveProperty("remedy");
  });

  it("the exemptions are exactly these two cells, and an unresolvable product (no state is missing) names none", () => {
    expect(CELLS.filter((c) => c.want === null).map((c) => c.name)).toEqual([
      "EXEMPT (SA-844 R5): a customer sale with no customer read",
      "EXEMPT: a JS caller naming no source and not store-judged",
    ]);
    const [breach] = staffBreaches(
      unresolved({
        storeJudged: true,
        products: [product({ unresolvable: true, nameKnown: false })],
      }),
    );
    expect(breach).toMatchObject({ outcome: "INDETERMINATE", unknownProduct: true });
    expect(breach).not.toHaveProperty("remedy");
  });

  describe("no third producer: the INDETERMINATE builders in src are exactly the known ones", () => {
    const SRC = path.resolve(__dirname, "..");
    function files(dir: string, out: string[] = []): string[] {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) files(p, out);
        else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(p);
      }
      return out;
    }
    const count = (re: RegExp) => {
      const by: Record<string, number> = {};
      for (const f of files(SRC)) {
        const n = (fs.readFileSync(f, "utf8").match(re) ?? []).length;
        if (n) by[path.relative(SRC, f).split(path.sep).join("/")] = n;
      }
      return by;
    };

    it("the engine builds one INDETERMINATE reason and the staff breach builds two (state unresolved, unknown product)", () => {
      expect(count(/outcome: "INDETERMINATE"/g)).toEqual({
        "selling-restrictions/staff-breaches.ts": 2,
      });
      expect(count(/"INDETERMINATE_ADDRESS"/g)).toEqual({
        "selling-restrictions/selling-restrictions.core.ts": 1,
      });
    });

    it("the two state-unresolved builders spread the one decider", () => {
      expect(count(/\.\.\.unresolvedStateRemedy\(/g)).toEqual({
        "selling-restrictions/selling-restrictions.core.ts": 1,
        "selling-restrictions/staff-breaches.ts": 1,
      });
    });
  });
});
