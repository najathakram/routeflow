import { COUNTER_PARK_MAX_LINES, COUNTER_PARK_STALE_HOURS } from "@routeflow/pricing";
import { validCustomer, validLine } from "./counter-sale";
import {
  PARK_LIMIT_COPY,
  PARK_TENANT_LIMIT_COPY,
  PARK_TAKEN_COPY,
  PARK_TOO_BIG_COPY,
  PARK_TOO_MANY_LINES_COPY,
  buildParkPayload,
  discardErrorCopy,
  formatParkedTime,
  isStaleParked,
  lineCountLabel,
  parkErrorCopy,
  resumeErrorCopy,
} from "./counter-park";

const err = (status: number, code?: string, message = "SERVER SECRET MESSAGE") => ({
  response: { status, data: { code, message } },
});

const line = {
  tempId: "t1",
  productId: "p-cola",
  name: "Cola",
  unitPrice: 2.5,
  qty: 2,
  stray: "dropped",
};

describe("buildParkPayload (the whitelist the server also applies)", () => {
  it("keeps the five fields, reduces the customer to four, never carries an email or a stray key", () => {
    const r = buildParkPayload({
      lines: [line],
      customer: {
        id: "c1",
        businessName: "Acme Cafe",
        email: "x@acme.test",
        pricingTier: 2,
        fulfillPath: null,
      },
      method: "CASH",
      tendered: "20",
      reference: "",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        lines: [{ tempId: "t1", productId: "p-cola", name: "Cola", unitPrice: 2.5, qty: 2 }],
        customer: { id: "c1", businessName: "Acme Cafe", pricingTier: 2 },
        method: "CASH",
        tendered: "20",
        reference: "",
      },
    });
    expect(JSON.stringify(r)).not.toContain("email");
    expect(JSON.stringify(r)).not.toContain("stray");
  });

  it("a walk-in is a null customer", () => {
    const r = buildParkPayload({
      lines: [line],
      customer: null,
      method: "CARD",
      tendered: "",
      reference: "",
    });
    expect(r.ok && r.value.customer).toBeNull();
  });

  it("refuses more lines than the contract allows", () => {
    const lines = Array.from({ length: COUNTER_PARK_MAX_LINES + 1 }, (_, i) => ({
      ...line,
      tempId: `t${i}`,
    }));
    expect(
      buildParkPayload({ lines, customer: null, method: "CASH", tendered: "", reference: "" }),
    ).toEqual({ ok: false, reason: "TOO_MANY_LINES" });
  });
});

describe("fixed copy, never the server message", () => {
  it("PARK_LIMIT (409) names the cap", () => {
    expect(parkErrorCopy(err(409, "PARK_LIMIT"))).toBe(PARK_LIMIT_COPY);
    expect(PARK_LIMIT_COPY).toBe(
      "This register already has 10 parked sales. Resume or discard one first.",
    );
  });
  it("PARK_LIMIT with scope tenant names the whole-shop cap; scope register or none keeps the register copy", () => {
    const scoped = (scope?: string) => ({
      response: {
        status: 409,
        data: { code: "PARK_LIMIT", scope, message: "SERVER SECRET MESSAGE" },
      },
    });
    expect(parkErrorCopy(scoped("tenant"))).toBe(PARK_TENANT_LIMIT_COPY);
    expect(PARK_TENANT_LIMIT_COPY).toBe(
      "Too many sales are parked across the shop (50). Resume or discard one first.",
    );
    expect(parkErrorCopy(scoped("register"))).toBe(PARK_LIMIT_COPY);
    expect(parkErrorCopy(scoped(undefined))).toBe(PARK_LIMIT_COPY);
    expect(PARK_TENANT_LIMIT_COPY).not.toContain("SERVER SECRET");
  });
  it("PARK_TAKEN (404) on resume and on discard", () => {
    expect(resumeErrorCopy(err(404, "PARK_TAKEN"))).toBe(PARK_TAKEN_COPY);
    expect(discardErrorCopy(err(404, "PARK_TAKEN"))).toBe(PARK_TAKEN_COPY);
    expect(PARK_TAKEN_COPY).toBe("That parked sale was already taken back or has expired.");
  });
  it("too large (413) and the off switch (403)", () => {
    expect(parkErrorCopy(err(413))).toBe(PARK_TOO_BIG_COPY);
    expect(parkErrorCopy(err(403, "COUNTER_SALES_DISABLED"))).toMatch(/not turned on/);
  });
  it("anything else is a generic fixed line", () => {
    for (const fn of [parkErrorCopy, resumeErrorCopy, discardErrorCopy]) {
      const text = fn(err(500));
      expect(text).not.toContain("SERVER SECRET");
      expect(fn(new Error("network down"))).not.toContain("network down");
      expect(text.length).toBeGreaterThan(10);
    }
    expect(PARK_TOO_MANY_LINES_COPY.length).toBeGreaterThan(10);
  });
});

describe("list helpers", () => {
  const now = Date.parse("2026-10-08T15:00:00.000Z");
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  it("flags a cart parked more than the stale window ago, not one inside it", () => {
    expect(isStaleParked(ago(COUNTER_PARK_STALE_HOURS + 1), now)).toBe(true);
    expect(isStaleParked(ago(COUNTER_PARK_STALE_HOURS - 1), now)).toBe(false);
  });
  it("formats the time in the given zone, falls back on a bad zone", () => {
    expect(formatParkedTime("2026-10-08T18:41:00.000Z", "America/New_York")).toBe("2:41 PM");
    expect(formatParkedTime("2026-10-08T18:41:00.000Z", "Not/AZone")).toMatch(/\d{1,2}:41/);
  });
  it("counts lines", () => {
    expect(lineCountLabel(1)).toBe("1 line");
    expect(lineCountLabel(3)).toBe("3 lines");
  });
});

describe("validLine / validCustomer (re-exported from @routeflow/pricing, behaviour unchanged)", () => {
  it("validLine", () => {
    expect(validLine(line)).toBe(true);
    expect(validLine({ ...line, qty: "2" })).toBe(false);
    expect(validLine({ ...line, productId: "" })).toBe(false);
    expect(validLine(null)).toBe(false);
  });
  it("validCustomer", () => {
    expect(validCustomer(null)).toBe(true);
    expect(validCustomer({ id: "c1", businessName: "Acme" })).toBe(true);
    expect(validCustomer({ id: "c1" })).toBe(false);
    expect(validCustomer("x")).toBe(false);
  });
});
