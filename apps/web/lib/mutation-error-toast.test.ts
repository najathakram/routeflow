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

  it("shows the generic toast for an ordinary mutation (behaviour unchanged)", () => {
    const { toast, router } = setup();
    handleMutationError(axiosErr({ message: "Nope" }), { meta: undefined }, toast, router);
    expect(toast).toHaveBeenCalledWith({ title: "Nope", variant: "error" });
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
  });

  it("still swallows HANDLED_CODES and still turns READ_ONLY into the read-only toast", () => {
    const { toast, router } = setup();
    handleMutationError(axiosErr({ code: "MERGE_CHOICE_REQUIRED" }), {}, toast, router);
    expect(toast).not.toHaveBeenCalled();
    handleMutationError(axiosErr({ code: "READ_ONLY", message: "x" }), {}, toast, router);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe("Your workspace is read-only");
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
});

describe("handleMutationError: INSUFFICIENT_STOCK (gap 05)", () => {
  it("toasts the sentence, never the server text", () => {
    const toast = jest.fn();
    handleMutationError(
      {
        response: {
          data: {
            code: "INSUFFICIENT_STOCK",
            message: "Insufficient stock: Mango (available: 4, requested: 6)",
            lines: [{ productId: "m", name: "Mango 5ct", available: 4, requested: 6 }],
          },
        },
      },
      undefined,
      toast,
      { push: jest.fn() },
    );
    expect(toast).toHaveBeenCalledWith({
      title: "Only 4 pieces of Mango 5ct left.",
      variant: "error",
    });
  });

  it("a mutation that renders its own error UI opts out", () => {
    const toast = jest.fn();
    handleMutationError(
      { response: { data: { code: "INSUFFICIENT_STOCK", lines: [] } } },
      { meta: { localErrorToast: true } },
      toast,
      { push: jest.fn() },
    );
    expect(toast).not.toHaveBeenCalled();
  });
});
