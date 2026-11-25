import { parseCustomerName } from "./parse-customer-name";
import { customerNameScore, normalizeCustomerName, suggestCustomers } from "./customer-score";
import { resolveCustomerBinding } from "./resolve-customer";
import type { CustomerBindingRow, RfCustomerRow } from "./types";

// T6 (bind half) and T28 (bind half), SA-1295 A2, B1b. Pure: RF customers and bindings are
// passed in; nothing here reads or writes a database, and nothing ever creates a customer.

const customers: RfCustomerRow[] = [
  { id: "c-market", name: "Acme Market" },
  { id: "c-acme", name: "ACME" },
  { id: "c-acme2", name: "ACME 2" },
];

describe("parseCustomerName", () => {
  it("keeps a plain name whole with no job", () => {
    expect(parseCustomerName("  Acme Market ")).toEqual({
      sourceKey: "Acme Market",
      parent: "Acme Market",
      job: null,
    });
  });

  it("splits Parent:Job at the first colon and keeps the full key", () => {
    expect(parseCustomerName("Acme Market:Store 2")).toEqual({
      sourceKey: "Acme Market:Store 2",
      parent: "Acme Market",
      job: "Store 2",
    });
  });

  it("keeps further colons inside the job name", () => {
    const p = parseCustomerName("Acme Market:Store 2:Dock");
    expect(p.parent).toBe("Acme Market");
    expect(p.job).toBe("Store 2:Dock");
  });

  it("trims around the colon but keeps the job text as written", () => {
    const p = parseCustomerName("Acme Market : Store 2 ");
    expect(p.parent).toBe("Acme Market");
    expect(p.job).toBe("Store 2");
    expect(p.sourceKey).toBe("Acme Market : Store 2");
  });

  it("treats a trailing colon as no job", () => {
    expect(parseCustomerName("Acme Market:").job).toBeNull();
  });
});

describe("customer name scoring", () => {
  it("normalises case, punctuation, & and spaces", () => {
    expect(normalizeCustomerName("  ACME  Market, Inc. ")).toBe("acme market inc");
    expect(normalizeCustomerName("Acme & Sons")).toBe("acme and sons");
  });

  it("scores identical normalised names 1", () => {
    expect(customerNameScore("ACME  Market", "acme market")).toBe(1);
  });

  it("scores an abbreviation of the same tokens as near", () => {
    expect(customerNameScore("Acme Mkt", "Acme Market")).toBeGreaterThanOrEqual(0.6);
  });

  it("scores 0 when the numbers differ (ACME vs ACME 2)", () => {
    expect(customerNameScore("ACME", "ACME 2")).toBe(0);
    expect(customerNameScore("Acme Store 1", "Acme Store 2")).toBe(0);
  });

  it("does not treat a leading word as a near match (no partial-name attach)", () => {
    expect(customerNameScore("Acme", "Acme Market")).toBeLessThan(0.6);
  });

  it("suggestCustomers returns best first and honours the limit", () => {
    const s = suggestCustomers("Acme Mkt", customers, 1);
    expect(s).toHaveLength(1);
    expect(s[0].customerId).toBe("c-market");
    expect(s[0].basis).toBe("NEAR");
  });
});

describe("T6 (bind half): blank customer and ACME beside ACME 2", () => {
  it.each(["", "   ", "\t"])("a blank customer %j is HELD with a row error", (blank) => {
    const r = resolveCustomerBinding(blank, customers, []);
    expect(r.status).toBe("HELD");
    expect(r.rowError?.code).toBe("BLANK_CUSTOMER");
    expect(r.boundCustomerId).toBeNull();
    expect(r.canPost).toBe(false);
    expect(r.candidates).toEqual([]);
  });

  it("a blank parent before the colon is HELD too", () => {
    expect(resolveCustomerBinding(":Store 2", customers, []).status).toBe("HELD");
  });

  it("a blank customer is HELD even when a binding row has an empty key", () => {
    const bindings: CustomerBindingRow[] = [
      { sourceCustomerKey: "", customerId: "c-acme", confirmed: true },
    ];
    const r = resolveCustomerBinding("", customers, bindings);
    expect(r.status).toBe("HELD");
    expect(r.boundCustomerId).toBeNull();
  });

  it("ACME does not attach to ACME 2 when only ACME 2 exists", () => {
    const r = resolveCustomerBinding("ACME", [{ id: "c-acme2", name: "ACME 2" }], []);
    expect(r.status).toBe("UNBOUND");
    expect(r.boundCustomerId).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  it("ACME beside ACME 2 offers only the exact ACME, and does not bind it", () => {
    const r = resolveCustomerBinding("ACME", customers, []);
    expect(r.status).toBe("CANDIDATE_EXACT");
    expect(r.candidates.map((c) => c.customerId)).toEqual(["c-acme"]);
    expect(r.boundCustomerId).toBeNull();
    expect(r.canPost).toBe(false);
  });

  it("ACME 2 offers only ACME 2", () => {
    const r = resolveCustomerBinding("ACME 2", customers, []);
    expect(r.candidates.map((c) => c.customerId)).toEqual(["c-acme2"]);
  });
});

describe("T28 (bind half): no auto-create, no partial-name attach, job not folded", () => {
  it("Parent:Job maps to the parent customer as a candidate with the job kept", () => {
    const r = resolveCustomerBinding("Acme Market:Store 2", customers, []);
    expect(r.status).toBe("CANDIDATE_EXACT");
    expect(r.parent).toBe("Acme Market");
    expect(r.job).toBe("Store 2");
    expect(r.sourceKey).toBe("Acme Market:Store 2");
    expect(r.candidates.map((c) => c.customerId)).toEqual(["c-market"]);
  });

  it("a confirmed binding on the parent does not bind its job (mapped job by job)", () => {
    const bindings: CustomerBindingRow[] = [
      { sourceCustomerKey: "Acme Market", customerId: "c-market", confirmed: true },
    ];
    const r = resolveCustomerBinding("Acme Market:Store 2", customers, bindings);
    expect(r.status).toBe("CANDIDATE_EXACT");
    expect(r.boundCustomerId).toBeNull();
    expect(r.canPost).toBe(false);
  });

  it("a confirmed binding on the full Parent:Job key binds that job", () => {
    const bindings: CustomerBindingRow[] = [
      { sourceCustomerKey: "Acme Market:Store 2", customerId: "c-market", confirmed: true },
    ];
    const r = resolveCustomerBinding("Acme Market:Store 2", customers, bindings);
    expect(r.status).toBe("BOUND");
    expect(r.boundCustomerId).toBe("c-market");
    expect(r.canPost).toBe(true);
    expect(r.job).toBe("Store 2");
  });

  it("an UNCONFIRMED binding row never binds", () => {
    const bindings: CustomerBindingRow[] = [
      { sourceCustomerKey: "Acme Mkt", customerId: "c-market", confirmed: false },
    ];
    const r = resolveCustomerBinding("Acme Mkt", customers, bindings);
    expect(r.status).toBe("SUGGESTED");
    expect(r.boundCustomerId).toBeNull();
    expect(r.canPost).toBe(false);
  });

  it("Acme Mkt is a near suggestion for Acme Market, never bound", () => {
    const r = resolveCustomerBinding("Acme Mkt", customers, []);
    expect(r.status).toBe("SUGGESTED");
    expect(r.candidates[0].customerId).toBe("c-market");
    expect(r.candidates[0].basis).toBe("NEAR");
    expect(r.boundCustomerId).toBeNull();
    expect(r.canPost).toBe(false);
  });

  it("a leading word alone does not attach: Acme vs Acme Market Downtown", () => {
    const r = resolveCustomerBinding("Acme", [{ id: "c-x", name: "Acme Market Downtown" }], []);
    expect(r.status).toBe("UNBOUND");
    expect(r.candidates).toEqual([]);
  });

  it("an unknown customer is UNBOUND and offers no create; no state can post", () => {
    const r = resolveCustomerBinding("Zzz Unrelated Co", customers, []);
    expect(r.status).toBe("UNBOUND");
    expect(r.canPost).toBe(false);
    expect(r.boundCustomerId).toBeNull();
    expect(r.rowError).toBeNull();
  });

  it("with no RF customers at all, still UNBOUND and never created", () => {
    const r = resolveCustomerBinding("Acme Market", [], []);
    expect(r.status).toBe("UNBOUND");
    expect(r.canPost).toBe(false);
  });

  it("two RF customers with the same normalised name are SUGGESTED, none picked", () => {
    const dup: RfCustomerRow[] = [
      { id: "c-1", name: "Acme Market" },
      { id: "c-2", name: "ACME  MARKET" },
    ];
    const r = resolveCustomerBinding("acme market", dup, []);
    expect(r.status).toBe("SUGGESTED");
    expect(r.candidates.map((c) => c.customerId).sort()).toEqual(["c-1", "c-2"]);
    expect(r.boundCustomerId).toBeNull();
  });

  it("canPost is true only for BOUND, across a spread of inputs", () => {
    const bindings: CustomerBindingRow[] = [
      { sourceCustomerKey: "Acme Market", customerId: "c-market", confirmed: true },
    ];
    const names = ["", "Acme Market", "Acme Market:Store 2", "Acme Mkt", "ACME", "Nobody"];
    for (const n of names) {
      const r = resolveCustomerBinding(n, customers, bindings);
      expect(r.canPost).toBe(r.status === "BOUND");
    }
  });

  it("does not mutate the rows passed in", () => {
    const c = JSON.parse(JSON.stringify(customers)) as RfCustomerRow[];
    const b: CustomerBindingRow[] = [
      { sourceCustomerKey: "Acme Market", customerId: "c-market", confirmed: true },
    ];
    resolveCustomerBinding("Acme Mkt", c, b);
    expect(c).toEqual(customers);
    expect(b).toEqual([
      { sourceCustomerKey: "Acme Market", customerId: "c-market", confirmed: true },
    ]);
  });
});
