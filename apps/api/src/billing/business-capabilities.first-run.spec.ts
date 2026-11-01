import type { BusinessCapabilities, FirstRunAnswer } from "@routeflow/types";
import { capabilitiesFromInputs, fillsBlanks, firstRunRequest } from "./business-capabilities";
import { planBusinessProfile } from "./business-profiles";
import { FLEET_KEYS, capabilityFromInputs } from "./fulfilment-capability";

/**
 * W1 (F3 to F9, F16, F16b, F17, F30): the first question's answer table, run through the REAL planner on a modelled
 * tenant (no DB). Expected values are the ones probed at e134d6bd5d (rf-specs specs/website-review/probe-first-run.txt,
 * sections B and C). The tenant path builds its own request (`firstRunRequest`) because the back office's call saves
 * nothing for Shipping alone and saves `pickup` / `pickup_ship` (still `proposed`) for the counter.
 */

interface Tenant {
  modes: Record<string, string>;
  held: string[];
  fleet: boolean;
  rowHeld: Set<string>;
  compRows: Set<string>;
}

const fresh = (): Tenant => ({
  modes: {},
  held: [],
  fleet: false,
  rowHeld: new Set(),
  compRows: new Set(),
});

/** A tenant whose two fleet modules were comped (an apply that stopped after its grants). */
const compHeld = (): Tenant => {
  const t = fresh();
  t.held = [...FLEET_KEYS];
  t.fleet = true;
  t.rowHeld = new Set(t.held);
  t.compRows = new Set(t.held);
  return t;
};

const read = (t: Tenant): BusinessCapabilities =>
  capabilitiesFromInputs(
    {
      fulfilmentMode: t.modes.fulfilment_model ?? "unset",
      counterSales: t.modes.counter_sales ?? "unset",
      fleet: t.fleet,
      modesFailed: false,
    },
    t.held,
  );

function run(answer: FirstRunAnswer, t: Tenant) {
  const { def } = firstRunRequest(answer, read(t));
  const plan = planBusinessProfile(def, {
    overrides: new Map(),
    holds: Object.fromEntries(t.held.map((k) => [k, true])),
    paying: new Set(),
    manualPay: new Set(),
    rowHeld: t.rowHeld,
    compRows: t.compRows,
    modes: t.modes,
  });
  const after = { ...t.modes };
  for (const m of plan.modes) after[m.key] = m.to;
  const fleet =
    t.fleet || plan.comps.some((c) => (FLEET_KEYS as readonly string[]).includes(c.featureKey));
  const capability = capabilityFromInputs({
    fulfilmentMode: after.fulfilment_model ?? "unset",
    counterSales: after.counter_sales ?? "unset",
    fleet,
    modesFailed: false,
  });
  return {
    plan,
    model: after.fulfilment_model ?? "unset",
    counterSales: after.counter_sales ?? "unset",
    comps: plan.comps.map((c) => c.featureKey),
    capability,
    fills: fillsBlanks(plan),
  };
}

const FLEET = ["recurring_routes", "order_delivery"];

describe("first question: the seven answers on a new account (F3 to F9)", () => {
  it.each([
    ["Delivery", { delivery: true }, "delivery", "unset", FLEET, ["ROUTE"], "ROUTE", "off"],
    ["Shipping", { shipping: true }, "ship", "unset", [], ["SHIP"], "SHIP", "off"],
    ["Counter", { counter: true }, "unset", "on", [], ["ROUTE", "SHIP"], "ROUTE", "optional"],
    [
      "Delivery + Shipping",
      { delivery: true, shipping: true },
      "both",
      "unset",
      FLEET,
      ["ROUTE", "SHIP"],
      "ROUTE",
      "off",
    ],
    [
      "Delivery + Counter",
      { delivery: true, counter: true },
      "delivery",
      "on",
      FLEET,
      ["ROUTE"],
      "ROUTE",
      "optional",
    ],
    [
      "Shipping + Counter",
      { shipping: true, counter: true },
      "ship",
      "on",
      [],
      ["SHIP"],
      "SHIP",
      "optional",
    ],
    [
      "All three",
      { delivery: true, shipping: true, counter: true },
      "both",
      "on",
      FLEET,
      ["ROUTE", "SHIP"],
      "ROUTE",
      "optional",
    ],
  ] as const)(
    "%s",
    (_name, answer, model, counterSales, comps, methods, staffDefault, counterCapability) => {
      const r = run(answer, fresh());
      expect(r.model).toBe(model);
      expect(r.counterSales).toBe(counterSales);
      expect(r.comps).toEqual(comps);
      expect(r.capability.methods).toEqual(methods);
      expect(r.capability.staffDefault).toBe(staffDefault);
      expect(r.capability.counter).toBe(counterCapability);
      // new orders open as an order, never at the counter; nothing is stopped, no override changes
      expect(r.capability.staffOpensAs).toBe("order");
      expect(r.plan.billing).toEqual([]);
      expect(
        r.plan.overrides.filter((o) => o.action !== "skip" && !FLEET.includes(o.featureKey)),
      ).toEqual([]);
      expect(r.fills).toBe(true);
    },
  );

  it("door payments are never granted, whatever is ticked", () => {
    for (const answer of [
      { delivery: true },
      { delivery: true, counter: true },
      { delivery: true, shipping: true, counter: true },
    ]) {
      const { plan } = run(answer, fresh());
      expect(plan.comps.map((c) => c.featureKey)).not.toContain("driver_payments");
    }
  });

  it("Counter alone never writes the in-store model, which tenant Settings refuses (still proposed)", () => {
    const r = run({ counter: true }, fresh());
    expect(r.plan.modes.map((m) => m.key)).toEqual(["counter_sales"]);
  });

  it("Shipping alone saves ship, where the back office's own call would save nothing", () => {
    const r = run({ shipping: true }, fresh());
    expect(r.plan.modes).toEqual([{ key: "fulfilment_model", from: "unset", to: "ship" }]);
  });
});

describe("first question: it only fills blanks (F16, F16b, F17, F30)", () => {
  const teamShip = (): Tenant => Object.assign(fresh(), { modes: { fulfilment_model: "ship" } });
  const teamCounter = (): Tenant => Object.assign(fresh(), { modes: { counter_sales: "on" } });

  it.each([
    [
      "an earlier apply stopped after its grants, same answer (Delivery + Shipping)",
      compHeld(),
      { delivery: true, shipping: true },
      true,
    ],
    [
      "an earlier apply stopped after its grants, same answer (Delivery + Counter)",
      compHeld(),
      { delivery: true, counter: true },
      true,
    ],
    [
      "an earlier apply stopped after the model, same answer (Delivery + Counter)",
      Object.assign(compHeld(), { modes: { fulfilment_model: "delivery" } }),
      { delivery: true, counter: true },
      true, // the model is already `delivery` (no change); only the counter still moves, from `unset`
    ],
    [
      "an earlier apply stopped after its grants, a DIFFERENT answer (Shipping)",
      compHeld(),
      { shipping: true },
      false,
    ],
    ["the team set ship by hand, answer Delivery", teamShip(), { delivery: true }, false],
    ["the team set ship by hand, answer Shipping (the same)", teamShip(), { shipping: true }, true],
    ["the team turned the counter on, answer Delivery", teamCounter(), { delivery: true }, false],
    [
      "the team turned the counter on, answer Counter (the same)",
      teamCounter(),
      { counter: true },
      true,
    ],
    ["the team comped the fleet, answer Shipping", compHeld(), { shipping: true }, false],
  ] as const)("%s -> fills blanks: %s", (_name, tenant, answer, expected) => {
    // the table fixes `tenant` once; run() does not mutate it
    expect(run(answer, tenant).fills).toBe(expected);
  });

  it("the retry case that master's planner gets wrong: grants done, model not, Delivery + Shipping ends both, never unset", () => {
    const r = run({ delivery: true, shipping: true }, compHeld());
    expect(r.model).toBe("both");
  });

  it("F30: it plans from the STORED mode it is handed, so a team ship set a moment ago leaves the setup alone", () => {
    // the caller drops the 30 s cache before planning; given the stored `ship`, Delivery changes a set mode
    expect(run({ delivery: true }, teamShip()).fills).toBe(false);
  });

  it("a plan that stops billing is never a blank", () => {
    const { plan } = run({ shipping: true }, compHeld());
    expect(plan.billing.length).toBeGreaterThan(0);
    expect(fillsBlanks(plan)).toBe(false);
  });
});
