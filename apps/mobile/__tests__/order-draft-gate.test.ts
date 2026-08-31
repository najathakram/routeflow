/**
 * Locks the operator order-builder save gate: normal submit needs customer + ≥1
 * item; "Save as draft" needs only a customer (zero-item DRAFT allowed).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { decideResumeLine, orderSubmitGate } from "../lib/order-draft-logic";

describe("orderSubmitGate", () => {
  it("blocks both paths without a customer", () => {
    expect(orderSubmitGate({ hasCustomer: false, itemCount: 0, asDraft: false }).ok).toBe(false);
    expect(orderSubmitGate({ hasCustomer: false, itemCount: 3, asDraft: true }).ok).toBe(false);
  });

  it("blocks a normal submit with zero items", () => {
    const g = orderSubmitGate({ hasCustomer: true, itemCount: 0, asDraft: false });
    expect(g.ok).toBe(false);
    expect(g.title).toBe("Add at least one item");
  });

  it("allows a zero-item DRAFT once a customer is chosen", () => {
    expect(orderSubmitGate({ hasCustomer: true, itemCount: 0, asDraft: true })).toEqual({
      ok: true,
    });
  });

  it("allows a normal submit with a customer and items", () => {
    expect(orderSubmitGate({ hasCustomer: true, itemCount: 2, asDraft: false })).toEqual({
      ok: true,
    });
  });
});

/**
 * F30 · R5 (T-B195, draft-resume half). The scan ladder resolves an ARCHIVED
 * product, so one can legitimately be scanned into a draft and parked. Resume
 * used to map `isActive:false` to `null` and delete the line with a "no longer
 * in your catalog" alert — the vanish-on-resume half of B195. Only a genuine
 * 404 may drop a line; anything else aborts hydration instead of truncating.
 */
describe("decideResumeLine", () => {
  const live = { id: "p1", isActive: true };
  const archived = { id: "p2", isActive: false };

  it("keeps an ARCHIVED product on the order instead of dropping the line", () => {
    expect(decideResumeLine({ ok: true, product: archived })).toEqual({
      product: archived,
      failed: false,
    });
  });

  it("keeps a live product", () => {
    expect(decideResumeLine({ ok: true, product: live })).toEqual({ product: live, failed: false });
  });

  it("drops the line only on a genuine 404", () => {
    expect(decideResumeLine({ ok: false, status: 404 })).toEqual({ product: null, failed: false });
  });

  it("aborts hydration on a transient failure rather than dropping the line", () => {
    // 5xx, and a network error / timeout with no response at all.
    expect(decideResumeLine({ ok: false, status: 500 })).toEqual({ product: null, failed: true });
    expect(decideResumeLine({ ok: false, status: undefined })).toEqual({
      product: null,
      failed: true,
    });
  });
});

/**
 * Mobile tests are pure-logic only (no RN tree), so the screen's use of the
 * helper is pinned at the source level — the technique wedge-submit.test.ts
 * already uses. Re-inlining the archived check would turn this red.
 */
describe("NewOrderScreen delegates resume-line classification (REG-B195 wiring)", () => {
  const screenSrc = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");

  it("calls decideResumeLine and no longer nulls an archived product itself", () => {
    expect(screenSrc).toMatch(/decideResumeLine/);
    expect(screenSrc).not.toMatch(/if\s*\(\s*data\.isActive\s*===\s*false\s*\)/);
  });
});
