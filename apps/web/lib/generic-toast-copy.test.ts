import { handleMutationError } from "./mutation-error-toast";
import { genericToastCopy } from "./generic-toast-copy";

/**
 * B980: the generic mutation toast shows FIXED copy chosen by code, then status. The raw server
 * message, the axios text and class-validator arrays are never rendered; a number comes from a
 * structured body field; opt-outs and handled codes are unchanged.
 */
const RAW = "secret internal detail: row 42 violates fk_x";
const err = (status: number, data: Record<string, unknown> = {}) => ({
  message: "Request failed with status code " + status,
  response: { status, data: { message: RAW, ...data } },
});

describe("genericToastCopy: status class", () => {
  it.each([
    [400, "Some details aren't valid. Check what you entered and try again."],
    [422, "Some details aren't valid. Check what you entered and try again."],
    [401, "Your session expired. Sign in again."],
    [403, "You don't have permission to do that."],
    [404, "That item no longer exists. Refresh and try again."],
    [409, "This changed while you were working on it. Refresh and try again."],
    [429, "Too many requests. Wait a moment and try again."],
    [500, "Something went wrong on our side. Please try again."],
    [503, "Something went wrong on our side. Please try again."],
  ])("status %i", (status, copy) => {
    expect(genericToastCopy(err(status))).toBe(copy);
  });

  it("an array message (class-validator) is never rendered", () => {
    expect(
      genericToastCopy(err(400, { message: ["name must be a string", "qty must be > 0"] })),
    ).toBe("Some details aren't valid. Check what you entered and try again.");
  });

  it("no response (timeout / dropped connection) is the 'couldn't confirm' line", () => {
    expect(genericToastCopy({ message: "Network Error", request: {} })).toMatch(/couldn't confirm/);
  });

  it("a non-error value is the generic line", () => {
    expect(genericToastCopy(undefined)).toBe("Something went wrong. Please try again.");
    expect(genericToastCopy("boom")).toBe("Something went wrong. Please try again.");
  });
});

describe("genericToastCopy: codes users rely on", () => {
  it("INSUFFICIENT_STOCK: 'Only N left' from the structured field", () => {
    expect(
      genericToastCopy(err(409, { code: "INSUFFICIENT_STOCK", available: 4, requested: 9 })),
    ).toBe("Not enough stock. Only 4 left.");
    expect(
      genericToastCopy(err(409, { code: "INSUFFICIENT_STOCK", available: 0, requested: 2 })),
    ).toBe("Not enough stock. Only 0 left.");
  });

  it("INSUFFICIENT_STOCK never parses the number out of the message", () => {
    expect(
      genericToastCopy(
        err(409, {
          code: "INSUFFICIENT_STOCK",
          message: "Not enough stock for X (available: 7, requested: 9).",
        }),
      ),
    ).toBe("Not enough stock for this item.");
    expect(genericToastCopy(err(409, { code: "INSUFFICIENT_STOCK", available: "7" }))).toBe(
      "Not enough stock for this item.",
    );
  });

  it("INSUFFICIENT_STOCK in #2871's shape: lines[0].available wins, the legacy top-level fields mirror it", () => {
    expect(
      genericToastCopy(
        err(409, {
          code: "INSUFFICIENT_STOCK",
          lines: [{ productId: "p", name: "Mango 5ct", unit: "bag", available: 4, requested: 9 }],
          productId: "p",
          available: 4,
          requested: 9,
        }),
      ),
    ).toBe("Not enough stock. Only 4 left.");
    expect(
      genericToastCopy(
        err(409, {
          code: "INSUFFICIENT_STOCK",
          lines: [{ productId: "p", available: 0, requested: 2 }],
        }),
      ),
    ).toBe("Not enough stock. Only 0 left.");
  });

  it("an uncoded stock refusal (order create today, until #2871 lands) falls to the fixed status copy", () => {
    expect(
      genericToastCopy(err(409, { message: "Insufficient stock: X (available: 7, requested: 9)" })),
    ).toBe("This changed while you were working on it. Refresh and try again.");
  });

  it("INSUFFICIENT_STOCK over several lines gives the plural line", () => {
    expect(
      genericToastCopy(
        err(409, {
          code: "INSUFFICIENT_STOCK",
          available: 1,
          lines: [
            { productId: "a", name: "A", available: 1, requested: 3 },
            { productId: "b", available: 0, requested: 2 },
          ],
        }),
      ),
    ).toBe("Some items don't have enough stock. Lower the quantities and try again.");
  });

  it("the duplicate-email sentence maps to the fixed copy", () => {
    expect(genericToastCopy(err(409, { message: "Email or username already taken" }))).toBe(
      "That email is already in use. Use a different email.",
    );
  });

  it.each([
    ["RETURN_REFUND_OVER_LINE_HEADROOM", /more than the invoice line is worth/],
    ["INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED", /already returned. Add a reason/],
    ["INLINE_RETURN_KEY_CONFLICT", /already submitted/],
    ["CREDIT_NOTE_VOID_NOT_EDITABLE", /is void/],
    ["CREDIT_NOTE_OVER_HEADROOM", /more than the source invoice still allows/],
    ["UNIT_AWARE_LINE", /sold by a unit/],
    ["ORDER_CHANGED_DURING_EDIT", /changed while you were editing/],
    ["CONCURRENT_UPDATE", /Someone else is updating/],
    ["BARCODE_TAKEN", /barcode/],
    ["ADDON_GATE", /isn't included in your current plan/],
  ])("%s", (code, re) => {
    const copy = genericToastCopy(err(409, { code }));
    expect(copy).toMatch(re);
    expect(copy).not.toContain(RAW);
  });

  it("the order-linked duplicate refusal (no code) maps by its exact sentence; a near-miss does not", () => {
    expect(
      genericToastCopy(
        err(400, {
          message:
            "Cannot duplicate an order-linked invoice. Create a new invoice or issue a credit note instead.",
        }),
      ),
    ).toMatch(/came from an order/);
    expect(
      genericToastCopy(
        err(400, { message: "Cannot duplicate an order-linked invoice. Also: " + RAW }),
      ),
    ).toBe("Some details aren't valid. Check what you entered and try again.");
  });

  it("a plan gate is the plan copy; PLAN_GATE_UNAVAILABLE falls through to the status copy", () => {
    expect(genericToastCopy(err(403, { code: "PLAN_GATE", flag: "x" }))).toBe(
      "This isn't included in your current plan.",
    );
    expect(genericToastCopy(err(403, { code: "PLAN_GATE_UNAVAILABLE" }))).toBe(
      "You don't have permission to do that.",
    );
  });

  it("an unknown code falls to the status copy, never the message", () => {
    expect(genericToastCopy(err(409, { code: "SOMETHING_NEW" }))).toBe(
      "This changed while you were working on it. Refresh and try again.",
    );
  });
});

describe("handleMutationError: opt-outs and handled codes are unchanged (B980)", () => {
  const run = (e: unknown, mutation: { meta?: Record<string, unknown> } | undefined) => {
    const toast = jest.fn();
    handleMutationError(e, mutation, toast, { push: jest.fn() });
    return toast;
  };

  it.each([
    [400, {}],
    [409, { code: "INSUFFICIENT_STOCK", available: 1 }],
    [500, { code: "X" }],
    [403, { code: "ADDON_GATE" }],
    [400, { code: "TEXT_CELL_FORMULA_LEAD", field: "businessName" }],
  ])("localErrorToast opts out for status %i %j", (status, data) => {
    expect(
      run(err(status as number, data as Record<string, unknown>), {
        meta: { localErrorToast: true },
      }),
    ).not.toHaveBeenCalled();
  });

  it("HANDLED_CODES are still swallowed", () => {
    for (const code of ["MERGE_CHOICE_REQUIRED", "SELLING_RESTRICTED", "CREDIT_LIMIT_EXCEEDED"])
      expect(run(err(409, { code }), undefined)).not.toHaveBeenCalled();
  });

  it("an ordinary failure toasts once, with fixed copy, never the raw text", () => {
    const toast = run(err(409, { code: "INSUFFICIENT_STOCK", available: 3 }), undefined);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      title: "Not enough stock. Only 3 left.",
      variant: "error",
    });
    expect(JSON.stringify(toast.mock.calls)).not.toContain(RAW);
  });
});
