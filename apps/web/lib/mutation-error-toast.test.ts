import { handleMutationError } from "./mutation-error-toast";
import { isReadOnlyRefused, resetReadOnlyRefusedForTests } from "./read-only-gate";

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

  it("542c: a 409 PAYMENT_TERMS_CHANGED from the pay click toasts the fixed refreshed-amount sentence", () => {
    const { toast, router } = setup();
    handleMutationError(
      {
        message: "Request failed",
        response: { status: 409, data: { code: "PAYMENT_TERMS_CHANGED" } },
      },
      { meta: undefined },
      toast,
      router,
    );
    expect(toast).toHaveBeenCalledWith({
      title: "The amount changed. We've refreshed it, please check and try again.",
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

  it("a read-only tenant still gets a way out (Billing) even from an opted-out mutation (review a)", () => {
    const { toast, router } = setup();
    handleMutationError(
      axiosErr({ code: "READ_ONLY", message: "x" }),
      { meta: { localErrorToast: true } },
      toast,
      router,
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.",
    );
    // B980: fixed copy too, never the raw guard message ("x"); no reason known -> no description.
    expect(toast.mock.calls[0][0].description).toBeUndefined();
    // billing-ux section 4: only an expired trial is told to choose a plan; any other reason gets the Billing page
    expect(toast.mock.calls[0][0].action).toMatchObject({ label: "Billing" });
    toast.mock.calls[0][0].action.onClick();
    expect(router.push).toHaveBeenCalledWith("/settings/billing");
  });

  it("on the Billing page itself the toast has no Billing action (it would link to the open page)", () => {
    window.history.pushState({}, "", "/settings/billing");
    try {
      const t = jest.fn();
      handleMutationError(
        axiosErr({ code: "READ_ONLY", reason: "subscription_cancelled", message: "x" }),
        {},
        t,
        { push: jest.fn() },
        { view: () => undefined, refresh: jest.fn(), isAdmin: () => true },
      );
      expect(t.mock.calls[0][0].action).toBeUndefined();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it.each(["subscription_cancelled", "trial_cancelled", "set_by_admin"])(
    "reason %s: the admin's toast action is Billing, never Choose a plan",
    (reason) => {
      const t = jest.fn();
      handleMutationError(
        axiosErr({ code: "READ_ONLY", reason, message: "x" }),
        {},
        t,
        { push: jest.fn() },
        { view: () => undefined, refresh: jest.fn(), isAdmin: () => true },
      );
      expect(t.mock.calls[0][0].action).toMatchObject({ label: "Billing" });
    },
  );

  it("still swallows HANDLED_CODES and still turns READ_ONLY into the read-only toast", () => {
    const { toast, router } = setup();
    handleMutationError(axiosErr({ code: "MERGE_CHOICE_REQUIRED" }), {}, toast, router);
    expect(toast).not.toHaveBeenCalled();
    handleMutationError(axiosErr({ code: "READ_ONLY", message: "x" }), {}, toast, router);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.",
    );
  });

  // B1234: the staff item save opts in to the fixed copy; the change-request screen (no opt-in) still owns its own toast.
  it("toasts LINE_ALREADY_DELIVERED for the staff item save (meta.lineDeliveredToast) and swallows it elsewhere", () => {
    const { toast, router } = setup();
    handleMutationError(axiosErr({ code: "LINE_ALREADY_DELIVERED" }), {}, toast, router);
    expect(toast).not.toHaveBeenCalled();
    handleMutationError(
      axiosErr({ code: "LINE_ALREADY_DELIVERED", message: "raw" }),
      { meta: { lineDeliveredToast: true } },
      toast,
      router,
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toMatch(/delivered line can't be changed or removed/);
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
    openInvoiceAmount: 149,
    billingContactEmail: "dana@acme.test",
  } as any;

  it("an admin: the sentence + the amount owed, no contact line, no plan CTA, and the read is refreshed", () => {
    const toast = jest.fn();
    const router = { push: jest.fn() };
    const refresh = jest.fn();
    handleMutationError(readOnly, {}, toast, router, {
      view: () => owedView,
      refresh,
      isAdmin: () => true,
    });
    expect(toast).toHaveBeenCalledTimes(1);
    const arg = toast.mock.calls[0][0];
    expect(arg.title).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment of $149.00 is overdue.",
    );
    expect(arg.action).toBeUndefined();
    expect(JSON.stringify(arg)).not.toMatch(/choose a plan/i);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a non-admin: the contact line (your admin + e-mail); no amount is invented", () => {
    const toast = jest.fn();
    handleMutationError(
      readOnly,
      {},
      toast,
      { push: jest.fn() },
      {
        view: () => ({ ...owedView, openInvoiceAmount: null }),
        refresh: jest.fn(),
        isAdmin: () => false,
      },
    );
    expect(toast.mock.calls[0][0].title).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment is overdue. To restore access, contact your admin (dana@acme.test).",
    );
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
        isAdmin: () => true,
      },
    );
    expect(toast.mock.calls[0][0].title).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment of $149.00 is overdue.",
    );
  });

  it("a trial-ended workspace: sentence + reason; the Choose a plan action for an admin only", () => {
    const view = () => ({ status: "READ_ONLY", readOnlyReason: "trial_expired" }) as any;
    const admin = jest.fn();
    handleMutationError(
      readOnly,
      {},
      admin,
      { push: jest.fn() },
      { view, refresh: jest.fn(), isAdmin: () => true },
    );
    expect(admin.mock.calls[0][0].title).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.",
    );
    expect(admin.mock.calls[0][0].description).toBe("Your free trial has ended.");
    expect(admin.mock.calls[0][0].action).toMatchObject({ label: "Choose a plan" });
    const staff = jest.fn();
    handleMutationError(
      readOnly,
      {},
      staff,
      { push: jest.fn() },
      {
        view: () =>
          ({
            status: "READ_ONLY",
            readOnlyReason: "trial_expired",
            billingContactEmail: "dana@acme.test",
          }) as any,
        refresh: jest.fn(),
        isAdmin: () => false,
      },
    );
    expect(staff.mock.calls[0][0].description).toBe(
      "Your free trial has ended. To restore access, contact your admin (dana@acme.test).",
    );
    expect(staff.mock.calls[0][0].action).toBeUndefined();
  });

  it("with no subscription read cached, the 403 body's reason is mapped (never its message)", () => {
    const toast = jest.fn();
    handleMutationError(
      {
        response: {
          status: 403,
          data: { code: "READ_ONLY", reason: "trial_cancelled", message: "RAW" },
        },
      },
      {},
      toast,
      { push: jest.fn() },
    );
    expect(toast.mock.calls[0][0].description).toBe("Your subscription was cancelled.");
    expect(JSON.stringify(toast.mock.calls[0][0])).not.toContain("RAW");
  });
});

describe("handleMutationError - a 403 READ_ONLY flips the controls on screen (S5)", () => {
  beforeEach(() => resetReadOnlyRefusedForTests());
  afterEach(() => resetReadOnlyRefusedForTests());

  it("marks the refusal so the gated controls show the line next to themselves", () => {
    expect(isReadOnlyRefused()).toBe(false);
    handleMutationError(
      { response: { status: 403, data: { code: "READ_ONLY" } } },
      {},
      jest.fn(),
      { push: jest.fn() },
      { view: () => undefined, refresh: jest.fn() },
    );
    expect(isReadOnlyRefused()).toBe(true);
  });
});
