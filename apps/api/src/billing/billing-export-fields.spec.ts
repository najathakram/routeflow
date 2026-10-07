import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import {
  BILLING_EVENT_PAYLOAD_FIELDS,
  EXPORT_EXCLUDED_EVENT_TYPES,
  BILLING_EXPORT_INVOICE_FIELDS,
  projectBillingEventForExport,
  projectInvoiceForExport,
} from "./billing-export-fields";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".spec.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("billing export projection (B1187)", () => {
  const invoiceRow = {
    id: "inv-1",
    tenantId: "t-1",
    number: "RF-2026-0001",
    amount: 49,
    status: "PAID",
    cycle: "MONTHLY",
    pdfKey: "invoices/secret.pdf",
    issuedAt: new Date("2026-01-01T00:00:00Z"),
    futureColumn: "must-not-leak",
  };

  it("invoice is exactly {number, amount, status, cycle, issuedAt}", () => {
    expect(Object.keys(projectInvoiceForExport(invoiceRow)).sort()).toEqual(
      ["amount", "cycle", "issuedAt", "number", "status"].sort(),
    );
    expect([...BILLING_EXPORT_INVOICE_FIELDS].sort()).toEqual(
      ["amount", "cycle", "issuedAt", "number", "status"].sort(),
    );
  });

  it("invoice never carries pdfKey, tenantId, id or an unlisted futureColumn", () => {
    const out = projectInvoiceForExport(invoiceRow) as Record<string, unknown>;
    for (const k of ["pdfKey", "tenantId", "id", "futureColumn"]) expect(k in out).toBe(false);
  });

  const eventRow = (over: Record<string, unknown> = {}) => ({
    id: "e-1",
    tenantId: "t-1",
    type: "plan.changed",
    payload: { fromPlan: "STARTER", toPlan: "GROWTH", cycle: "MONTHLY" },
    amountDelta: 20,
    actorId: "u-1",
    createdAt: new Date("2026-01-02T00:00:00Z"),
    ...over,
  });

  it("event is {type, createdAt, amountDelta, actor, payload} and drops id/tenantId/actorId/futureColumn", () => {
    const out = projectBillingEventForExport(eventRow({ futureColumn: "x" }), "you") as Record<
      string,
      unknown
    >;
    expect(Object.keys(out).sort()).toEqual(
      ["actor", "amountDelta", "createdAt", "payload", "type"].sort(),
    );
  });

  it("an unlisted payload key (futurePayloadKey) is absent from the export", () => {
    const out = projectBillingEventForExport(
      eventRow({ payload: { fromPlan: "A", toPlan: "B", futurePayloadKey: "leak" } }),
      "you",
    );
    expect(out.payload).toEqual({ fromPlan: "A", toPlan: "B" });
  });

  it("forbidden payload keys are never exported for any type", () => {
    const forbidden = {
      stripeReason: "card_declined",
      stripeSynced: true,
      source: "platform_pricing_sync",
      platformAdmin: true,
      reason: "internal",
      retainedUserIds: ["u9"],
    };
    for (const type of Object.values(BILLING_EVENTS)) {
      const out = projectBillingEventForExport(
        eventRow({ type, payload: { ...forbidden, quantity: 1, toPlan: "B" } }),
        "system",
      );
      for (const k of Object.keys(forbidden)) expect(k in out.payload).toBe(false);
    }
  });

  it("a type with no allowlist entry exports {type, createdAt, amountDelta} only (empty payload)", () => {
    const out = projectBillingEventForExport(
      eventRow({ type: "brand.new_type", payload: { toPlan: "B", anything: 1 } }),
      "you",
    );
    expect(out.payload).toEqual({});
    expect(out.type).toBe("brand.new_type");
    expect(out.amountDelta).toBe(20);
  });

  it("non-scalar payload values are dropped even for a listed key", () => {
    const out = projectBillingEventForExport(
      eventRow({ payload: { toPlan: { nested: "x" }, fromPlan: "A" } }),
      "you",
    );
    expect(out.payload).toEqual({ fromPlan: "A" });
  });

  it("a non-object payload does not throw", () => {
    expect(projectBillingEventForExport(eventRow({ payload: null }), "system").payload).toEqual({});
  });

  it("the per-type payload allowlist is pinned EXACTLY (widening any list fails)", () => {
    expect(BILLING_EVENT_PAYLOAD_FIELDS).toEqual({
      "plan.changed": [
        "fromPlan",
        "toPlan",
        "planKey",
        "cycle",
        "instant",
        "prorated",
        "scheduled",
        "applied",
        "oldMonthly",
        "newMonthly",
      ],
      "plan.downgrade_scheduled": ["fromPlan", "toPlan", "effectiveAt"],
      "addon.enabled": ["sku", "quantity", "prorated"],
      "addon.disabled": ["sku", "quantity", "prorated"],
      "seat.added": ["quantity"],
      "seat.freed": ["quantity"],
      "grace.started": [],
      "grace.expired": [],
      "trial.converted": ["planKey"],
      "trial.expired": ["at"],
      "trial.cancelled": ["at"],
      "subscription.canceled": ["fromStatus", "toStatus", "effectiveAt", "appliedAt"],
      "subscription.suspended": ["fromStatus", "toStatus"],
      "subscription.resumed": ["fromStatus", "toStatus"],
    });
    expect([...EXPORT_EXCLUDED_EVENT_TYPES]).toEqual([
      "tenant.class_changed",
      "reconciliation.snapshot_backfilled",
    ]);
  });

  describe("emit-site inventory", () => {
    const files = walk(SRC);
    const used = new Set<string>();
    const literalEmits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/BILLING_EVENTS\.([A-Z0-9_]+)/g)) used.add(m[1]);
      for (const m of text.matchAll(/\.emit\(\s*[^,]+,\s*"([a-z_.]+)"/g))
        literalEmits.push(`${f}:${m[1]}`);
    }

    it("finds the emit sites (guards against a vacuous scan)", () => {
      expect(used.size).toBeGreaterThanOrEqual(10);
    });

    it("every BILLING_EVENTS name referenced anywhere exists in the constants", () => {
      for (const name of used) expect(Object.keys(BILLING_EVENTS)).toContain(name);
    });

    it("every declared event type is EITHER allowlisted OR excluded, never both (a new type fails here)", () => {
      for (const type of Object.values(BILLING_EVENTS)) {
        const listed = Object.keys(BILLING_EVENT_PAYLOAD_FIELDS).includes(type);
        const excluded = EXPORT_EXCLUDED_EVENT_TYPES.includes(type);
        expect(listed !== excluded).toBe(true);
      }
    });

    it("excluded types are declared types", () => {
      const declared = new Set<string>(Object.values(BILLING_EVENTS));
      for (const type of EXPORT_EXCLUDED_EVENT_TYPES) expect(declared.has(type)).toBe(true);
    });

    it("no allowlist entry names a type that is not declared", () => {
      const declared = new Set<string>(Object.values(BILLING_EVENTS));
      for (const type of Object.keys(BILLING_EVENT_PAYLOAD_FIELDS)) {
        expect(declared.has(type)).toBe(true);
      }
    });

    it("no emit site passes a raw string literal type (must go through BILLING_EVENTS)", () => {
      expect(literalEmits).toEqual([]);
    });
  });
});
