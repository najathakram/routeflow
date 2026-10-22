import { sanitizeParkedPayload } from "@routeflow/pricing";
import { act, renderHook } from "@testing-library/react";
import { kindOfPick, restoredBuyerKind } from "./counter-buyer-choice";
import { useCounterBuyerChoice } from "./useCounterBuyerChoice";

describe("counter-buyer-choice (S5 rules)", () => {
  it("a picked customer is a customer choice; the system walk-in record is a Walk-in choice", () => {
    expect(kindOfPick({})).toBe("customer");
    expect(kindOfPick({ isWalkIn: false })).toBe("customer");
    expect(kindOfPick({ isWalkIn: true })).toBe("walk-in");
  });

  it("a restored cart: a customer is the choice; no customer keeps Walk-in only if it was chosen", () => {
    expect(restoredBuyerKind({}, false)).toBe("customer");
    expect(restoredBuyerKind(null, true)).toBe("walk-in");
    expect(restoredBuyerKind(null, false)).toBeNull(); // an older save, or never asked: the till asks
  });
});

describe("useCounterBuyerChoice", () => {
  it("a fresh till has made no choice", () => {
    const { result } = renderHook(() => useCounterBuyerChoice());
    expect(result.current.chosen).toBe(false);
    expect(result.current.kind).toBeNull();
  });

  it("customer and Walk-in are each a choice; reset asks again", () => {
    const { result } = renderHook(() => useCounterBuyerChoice());
    act(() => result.current.chooseCustomer());
    expect(result.current).toMatchObject({ chosen: true, kind: "customer" });
    act(() => result.current.chooseWalkIn());
    expect(result.current).toMatchObject({ chosen: true, kind: "walk-in" });
    act(() => result.current.reset());
    expect(result.current).toMatchObject({ chosen: false, kind: null });
  });

  it("restore puts back a saved choice", () => {
    const { result } = renderHook(() => useCounterBuyerChoice());
    act(() => result.current.restore(null, true));
    expect(result.current.kind).toBe("walk-in");
    act(() => result.current.restore({}, false));
    expect(result.current.kind).toBe("customer");
    act(() => result.current.restore(null, false));
    expect(result.current.kind).toBeNull();
  });

  it("a cart parked on the walk-in customer RECORD resumes as Walk-in through the shared sanitizer (#3610 review)", () => {
    const res = sanitizeParkedPayload(
      {
        lines: [{ tempId: "t", productId: "p1", name: "Cola", unitPrice: 10, qty: 1 }],
        customer: { id: "w1", businessName: "Walk-in customer", isWalkIn: true },
        method: "CASH",
        tendered: "",
        reference: "",
      },
      ["CASH"],
    );
    expect(res.ok).toBe(true);
    const value = (
      res as { ok: true; value: { customer: { isWalkIn?: boolean } | null; walkIn?: true } }
    ).value;
    expect(restoredBuyerKind(value.customer, value.walkIn === true)).toBe("walk-in");
  });
});
