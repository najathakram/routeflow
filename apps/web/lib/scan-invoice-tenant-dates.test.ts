import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { fillEmptyDates, useFillTenantDates } from "./scan-invoice-tenant-dates";

let mockToday: string | undefined;
jest.mock("@/lib/tenant-timezone", () => ({ useTenantToday: () => mockToday }));

/** F14 (SA-964 §4): an empty bill or expense date takes the tenant's day; a typed date is never touched. */
describe("fillEmptyDates", () => {
  const day = "2026-10-26"; // the tenant's day; the browser's clock may be a day behind

  it("fills an empty bill date and an empty expense date", () => {
    expect(fillEmptyDates([{ id: "a", billDate: "", expenseDate: "" }], day)).toEqual([
      { id: "a", billDate: day, expenseDate: day },
    ]);
  });

  it("keeps a typed date and fills only the empty one", () => {
    expect(fillEmptyDates([{ id: "a", billDate: "2026-10-01", expenseDate: "" }], day)).toEqual([
      { id: "a", billDate: "2026-10-01", expenseDate: day },
    ]);
  });

  it("returns the same invoice object when nothing is empty", () => {
    const inv = { id: "a", billDate: "2026-10-01", expenseDate: "2026-10-02" };
    expect(fillEmptyDates([inv], day)[0]).toBe(inv);
  });
});

/** F14: the fill happens once per invoice; a date the user clears is not refilled by the hook's effect. */
describe("useFillTenantDates", () => {
  type Inv = { id: string; billDate: string; expenseDate: string };

  function mount(initial: Inv[]) {
    return renderHook(() => {
      const [invoices, setRaw] = React.useState<Inv[]>(initial);
      const ref = React.useRef(invoices);
      const setInvoices = (update: (prev: Inv[]) => Inv[]) =>
        setRaw((prev) => {
          const next = update(prev);
          ref.current = next;
          return next;
        });
      useFillTenantDates(invoices, ref, setInvoices);
      return { invoices, setInvoices };
    });
  }

  beforeEach(() => {
    mockToday = "2026-10-26";
  });

  it("fills an empty date once the zone is known", () => {
    mockToday = undefined;
    const h = mount([{ id: "a", billDate: "", expenseDate: "" }]);
    expect(h.result.current.invoices[0]!.billDate).toBe("");
    mockToday = "2026-10-26";
    h.rerender();
    expect(h.result.current.invoices[0]).toEqual({
      id: "a",
      billDate: "2026-10-26",
      expenseDate: "2026-10-26",
    });
  });

  it("a date the user clears stays cleared (no refill from the effect)", () => {
    const h = mount([{ id: "a", billDate: "", expenseDate: "" }]);
    expect(h.result.current.invoices[0]!.billDate).toBe("2026-10-26");
    act(() => h.result.current.setInvoices((p) => p.map((i) => ({ ...i, billDate: "" }))));
    h.rerender();
    expect(h.result.current.invoices[0]!.billDate).toBe("");
    expect(h.result.current.invoices[0]!.expenseDate).toBe("2026-10-26");
  });

  it("an invoice added later is filled once, and does not undo an earlier clear", () => {
    const h = mount([{ id: "a", billDate: "", expenseDate: "" }]);
    act(() => h.result.current.setInvoices((p) => p.map((i) => ({ ...i, expenseDate: "" }))));
    act(() =>
      h.result.current.setInvoices((p) => [...p, { id: "b", billDate: "", expenseDate: "" }]),
    );
    const [a, b] = h.result.current.invoices;
    expect(a!.expenseDate).toBe("");
    expect(b).toEqual({ id: "b", billDate: "2026-10-26", expenseDate: "2026-10-26" });
  });
});
