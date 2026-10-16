import { act, renderHook } from "@testing-library/react";
import {
  clearAllInvoiceDrafts,
  invoiceDraftKey,
  resumeInvoiceDraftWrites,
} from "@/lib/invoice-draft-storage";
import { useInvoiceDraft } from "./use-invoice-draft";

const KEY = invoiceDraftKey("acme", "u1");
const FORM = {
  basis: "standalone",
  customer: { id: "c-1", businessName: "Acme Co" },
  lines: [
    { productId: "p-1", description: "Widget", qty: 1, unitPrice: 5, discount: 0, taxable: false },
  ],
};

describe("useInvoiceDraft after sign-out starts (ROW 447)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => resumeInvoiceDraftWrites());

  it("the pagehide flush that a sign-out redirect fires does not bring the draft back", () => {
    renderHook(() => useInvoiceDraft(KEY, FORM));
    clearAllInvoiceDrafts();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("a plain pagehide (refresh) still flushes", () => {
    renderHook(() => useInvoiceDraft(KEY, FORM));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(window.localStorage.getItem(KEY!)).not.toBeNull();
  });

  it("the debounced write does not run after sign-out started either", () => {
    jest.useFakeTimers();
    try {
      renderHook(() => useInvoiceDraft(KEY, FORM));
      clearAllInvoiceDrafts();
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(window.localStorage.length).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
