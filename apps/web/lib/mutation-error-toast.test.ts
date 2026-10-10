import { handleMutationError } from "./mutation-error-toast";

/**
 * The app-wide MutationCache error handler (extracted from app/providers.tsx, #1965). A mutation
 * that owns its error UI opts out with `meta: { localErrorToast: true }`; everything else keeps the
 * generic toast.
 */
describe("handleMutationError (#1965)", () => {
  const axiosErr = (data: Record<string, unknown>) => ({
    message: "Request failed with status code 500",
    response: { status: 500, data },
  });
  const setup = () => ({ toast: jest.fn(), router: { push: jest.fn() } });

  it("shows FIXED copy for an ordinary mutation, never the server message (B980)", () => {
    const { toast, router } = setup();
    handleMutationError(axiosErr({ message: "Nope" }), { meta: undefined }, toast, router);
    expect(toast).toHaveBeenCalledWith({
      title: "Something went wrong on our side. Please try again.",
      variant: "error",
    });
  });

  it("shows NOTHING when the mutation opts out with meta.localErrorToast", () => {
    const { toast, router } = setup();
    handleMutationError(
      axiosErr({ message: "Internal server error" }),
      { meta: { localErrorToast: true } },
      toast,
      router,
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("a read-only tenant still gets 'Choose a plan' even from an opted-out mutation (review a)", () => {
    const { toast, router } = setup();
    handleMutationError(
      axiosErr({ code: "READ_ONLY", message: "x" }),
      { meta: { localErrorToast: true } },
      toast,
      router,
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe("Your workspace is read-only");
    // B980: the description is fixed copy too, never the raw guard message.
    expect(toast.mock.calls[0][0].description).toBe("Choose a plan to make changes.");
  });

  it("still swallows HANDLED_CODES and still turns READ_ONLY into the read-only toast", () => {
    const { toast, router } = setup();
    handleMutationError(axiosErr({ code: "MERGE_CHOICE_REQUIRED" }), {}, toast, router);
    expect(toast).not.toHaveBeenCalled();
    handleMutationError(axiosErr({ code: "READ_ONLY", message: "x" }), {}, toast, router);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe("Your workspace is read-only");
  });

  // B1135: the buyer's request form says this refusal inline; a second generic toast would repeat it.
  it("swallows ORDER_WITH_CARRIER_NO_CHANGE_REQUEST (the request form renders it itself)", () => {
    const { toast, router } = setup();
    handleMutationError(
      axiosErr({ code: "ORDER_WITH_CARRIER_NO_CHANGE_REQUEST", message: "x" }),
      {},
      toast,
      router,
    );
    expect(toast).not.toHaveBeenCalled();
  });

  // B956: a refused formula-led name is FIXED copy with a human field label here too, never the raw
  // server message ("businessName must not start with …") or the raw axios text.
  describe("a refused name (TEXT_CELL_FORMULA_LEAD)", () => {
    const refusal = (field: string) =>
      axiosErr({
        statusCode: 400,
        code: "TEXT_CELL_FORMULA_LEAD",
        field,
        message: `${field} must not start with = + - @ or a tab/line break`,
      });

    it("toasts the fixed copy with the field label, never the raw message", () => {
      const { toast, router } = setup();
      handleMutationError(refusal("businessName"), {}, toast, router);
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith({
        title: "Business name can't start with =, +, -, @ or a tab/line break.",
        variant: "error",
      });
      expect(JSON.stringify(toast.mock.calls)).not.toMatch(/must not start|businessName/);
    });

    it("an opted-out mutation (the customer form shows its own banner) shows nothing, so it never shows twice", () => {
      const { toast, router } = setup();
      handleMutationError(
        refusal("contactName"),
        { meta: { localErrorToast: true } },
        toast,
        router,
      );
      expect(toast).not.toHaveBeenCalled();
    });
  });

  it("B964-2: a refused formula-led product name toasts the fixed 'Product name' copy, never the server text", () => {
    const { toast, router } = setup();
    handleMutationError(
      axiosErr({
        statusCode: 400,
        code: "TEXT_CELL_FORMULA_LEAD",
        field: "productName",
        message: "productName must not start with = + - @ or a tab/line break",
      }),
      { meta: undefined },
      toast,
      router,
    );
    expect(toast).toHaveBeenCalledWith({
      title: "Product name can't start with =, +, -, @ or a tab/line break.",
      variant: "error",
    });
  });
});

// SA-733r6 (B4): a 403 READ_ONLY on a workspace that owes an invoice shows the fixed blocked-control line (no
// "Choose a plan" - the server answers a plan change with 409 PAYMENT_OVERDUE) and refreshes the subscription so
// every write control on screen switches to its disabled-with-the-line state.
describe("handleMutationError - 403 READ_ONLY while a payment is owed (B4)", () => {
  const readOnly = { response: { status: 403, data: { code: "READ_ONLY", message: "x" } } };
  const owedView = {
    status: "READ_ONLY",
    readOnlyReason: "payment_overdue",
    pastDueInvoiceId: "in_1",
    billingContactName: "Dana",
  } as any;

  it("shows the exact line, no plan CTA, and refreshes the subscription read", () => {
    const toast = jest.fn();
    const router = { push: jest.fn() };
    const refresh = jest.fn();
    handleMutationError(readOnly, {}, toast, router, { view: () => owedView, refresh });
    expect(toast).toHaveBeenCalledTimes(1);
    const arg = toast.mock.calls[0][0];
    expect(arg.title).toBe("Not available while read-only. Dana can restore it.");
    expect(arg.action).toBeUndefined();
    expect(JSON.stringify(arg)).not.toMatch(/choose a plan/i);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("an opted-out mutation still gets the line (the read-only branch comes first)", () => {
    const toast = jest.fn();
    handleMutationError(
      readOnly,
      { meta: { localErrorToast: true } },
      toast,
      { push: jest.fn() },
      {
        view: () => owedView,
        refresh: jest.fn(),
      },
    );
    expect(toast.mock.calls[0][0].title).toBe(
      "Not available while read-only. Dana can restore it.",
    );
  });

  it("no admin on file: 'Your admin can restore it.'", () => {
    const toast = jest.fn();
    handleMutationError(
      readOnly,
      {},
      toast,
      { push: jest.fn() },
      {
        view: () => ({ ...owedView, billingContactName: null }),
        refresh: jest.fn(),
      },
    );
    expect(toast.mock.calls[0][0].title).toBe(
      "Not available while read-only. Your admin can restore it.",
    );
  });

  it("a trial-ended workspace keeps the existing toast and its Choose a plan action", () => {
    const toast = jest.fn();
    handleMutationError(
      readOnly,
      {},
      toast,
      { push: jest.fn() },
      {
        view: () => ({ status: "READ_ONLY", readOnlyReason: "trial_expired" }) as any,
        refresh: jest.fn(),
      },
    );
    expect(toast.mock.calls[0][0].title).toBe("Your workspace is read-only");
  });
});
