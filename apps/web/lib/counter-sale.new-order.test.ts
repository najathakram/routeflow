import type { FulfilmentCapability } from "@routeflow/types";
import { newOrderEntry, regularOrderSubtitle } from "./counter-sale";

/** W-854 (SA-940 MUST 1, MUST 4, A-1.1; SA-1069 A-3): the one predicate every sale entry reads, and the one subtitle. */
const cap = (over: Partial<FulfilmentCapability>): FulfilmentCapability =>
  ({
    methods: ["ROUTE", "SHIP"],
    staffDefault: "ROUTE",
    staffOpensAs: "order",
    portalMethods: [],
    portalDefault: null,
    counter: "optional",
    fleet: true,
    consistent: true,
    ...over,
  }) as FulfilmentCapability;
const COUNTER_FIRST = cap({
  methods: ["PICKUP", "SHIP"] as never,
  staffDefault: "PICKUP" as never,
  staffOpensAs: "counter" as never,
  counter: "always" as never,
});
const STORE_ONLY = cap({ ...COUNTER_FIRST, methods: ["PICKUP"] as never });
const gate = (capability: FulfilmentCapability | null | undefined, over = {}) => ({
  capability,
  mayUseTill: true,
  permsKnown: true,
  loading: false,
  ...over,
});

describe("newOrderEntry", () => {
  it("wait while the gate is out, whatever else it says", () => {
    expect(newOrderEntry(gate(COUNTER_FIRST, { loading: true }))).toEqual({ kind: "wait" });
    expect(newOrderEntry(gate(undefined, { loading: true }))).toEqual({ kind: "wait" });
  });

  it("the menu lists the business's default first", () => {
    expect(newOrderEntry(gate(COUNTER_FIRST))).toEqual({ kind: "menu", first: "counter" });
    expect(newOrderEntry(gate(STORE_ONLY))).toEqual({ kind: "menu", first: "counter" });
    expect(newOrderEntry(gate(cap({})))).toEqual({ kind: "menu", first: "order" });
  });

  it("no sale control for store-only when the till is denied or permissions are unknown", () => {
    expect(newOrderEntry(gate(STORE_ONLY, { mayUseTill: false }))).toEqual({ kind: "none" });
    expect(newOrderEntry(gate(STORE_ONLY, { permsKnown: false }))).toEqual({ kind: "none" });
  });

  it("the builder when there's no counter, the till is denied, or the capability read failed", () => {
    expect(newOrderEntry(gate(cap({ counter: "off" as never })))).toEqual({ kind: "builder" });
    expect(newOrderEntry(gate(cap({}), { mayUseTill: false }))).toEqual({ kind: "builder" });
    expect(newOrderEntry(gate(cap({}), { permsKnown: false }))).toEqual({ kind: "builder" });
    expect(newOrderEntry(gate(COUNTER_FIRST, { mayUseTill: false }))).toEqual({ kind: "builder" });
    expect(newOrderEntry(gate(undefined))).toEqual({ kind: "builder" });
    expect(newOrderEntry(gate(null))).toEqual({ kind: "builder" });
  });
});

describe("regularOrderSubtitle reads the builder's offer", () => {
  it.each([
    ["both", ["ROUTE", "SHIP"], "Deliver, ship or pick up later"],
    ["delivery", ["ROUTE"], "Deliver or pick up later"],
    ["ship", ["SHIP"], "Ship or pick up later"],
  ])("%s with an optional counter", (_mode, methods, words) => {
    expect(regularOrderSubtitle(cap({ methods: methods as never }))).toBe(words);
  });

  it("pickup and ship", () => {
    expect(regularOrderSubtitle(COUNTER_FIRST)).toBe("Ship or pick up later");
  });

  it("a store-only business picks up later, invoiced", () => {
    expect(regularOrderSubtitle(STORE_ONLY)).toBe("Pick up later, invoiced");
  });

  it("a delivery business whose fleet is gone reads what the builder falls back to", () => {
    expect(regularOrderSubtitle(cap({ methods: ["ROUTE"] as never, consistent: false }))).toBe(
      "Deliver or ship",
    );
  });
});
