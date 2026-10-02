import { isUnitPending, refusePendingQtyEdit } from "./pending-unit";

/**
 * #2865 case c (SA-632): a line whose default selling unit is not yet resolved is PENDING, and its
 * quantity must never depend on load timing. ONE predicate, used by web and mobile (no mirror).
 */
describe("isUnitPending (shared by web and mobile)", () => {
  it("web shape: a boolean flag marks a pending line unless the line is already shaped", () => {
    expect(isUnitPending({ startOnDefaultUnit: true })).toBe(true);
    expect(isUnitPending({ startOnDefaultUnit: true, shaped: true })).toBe(false);
    expect(isUnitPending({ startOnDefaultUnit: false })).toBe(false);
    expect(isUnitPending({})).toBe(false);
  });

  it("mobile shape: a numeric flag holds only while it equals the line's qty", () => {
    expect(isUnitPending({ startOnDefaultUnit: 12, qty: 12 })).toBe(true);
    expect(isUnitPending({ startOnDefaultUnit: 12, qty: 24 })).toBe(false);
    expect(isUnitPending({ startOnDefaultUnit: undefined, qty: 12 })).toBe(false);
  });

  it("an operator-typed price is a shaped line, never pending", () => {
    expect(isUnitPending({ startOnDefaultUnit: 12, qty: 12, operatorPrice: true })).toBe(false);
  });

  it("null / undefined flags are not pending", () => {
    expect(isUnitPending({ startOnDefaultUnit: null, qty: 1 })).toBe(false);
  });
});

describe("refusePendingQtyEdit", () => {
  const edit = jest.fn((l: { qty: number }) => ({ ...l, qty: l.qty + 1 }));
  beforeEach(() => edit.mockClear());

  it("returns a PENDING line UNCHANGED and never runs the edit (refused in the logic, not only by a disabled button)", () => {
    const line = { startOnDefaultUnit: true as const, qty: 1 };
    expect(refusePendingQtyEdit(line, edit)).toBe(line);
    expect(edit).not.toHaveBeenCalled();
  });

  it("runs the edit on a settled line", () => {
    const line = { startOnDefaultUnit: false as const, qty: 1 };
    expect(refusePendingQtyEdit(line, edit)).toEqual({ startOnDefaultUnit: false, qty: 2 });
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
