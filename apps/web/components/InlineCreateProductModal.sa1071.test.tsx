import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InlineCreateProductModal } from "./InlineCreateProductModal";
import { codedToastCopy } from "@/lib/generic-toast-copy";

/**
 * SA-1071 I2, I3, I4: a refused create names the problem in one toast, a client failure names the field (no browser bubble),
 * and a price that looks wrong says so. The create hook is a seam: its options and its callbacks are the evidence.
 */
const createMutate = jest.fn();
const createOpts = jest.fn();
const toastFn = jest.fn();
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useCreateProduct: (o?: unknown) => {
    createOpts(o);
    return { mutate: createMutate, isPending: false };
  },
  useProducts: () => ({ data: { data: [] } }),
  useProductCategories: () => ({ data: [] }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: toastFn }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: [] }), post: jest.fn() },
}));

function mount(props: Partial<React.ComponentProps<typeof InlineCreateProductModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InlineCreateProductModal isOpen onClose={jest.fn()} onCreated={jest.fn()} {...props} />
    </QueryClientProvider>,
  );
}
const form = () => screen.getByRole("button", { name: /create product/i }).closest("form")!;
const nameInput = () => screen.getByPlaceholderText("e.g. Sourdough Bread") as HTMLInputElement;
const unitInput = () => screen.getByPlaceholderText("e.g. case, kg, unit") as HTMLInputElement;
const priceInput = () => screen.getByPlaceholderText("0.00") as HTMLInputElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const submit = () => fireEvent.submit(form());
const fill = (name = "Fresh Pie", unit = "each", price = "4.5") => {
  type(nameInput(), name);
  type(unitInput(), unit);
  type(priceInput(), price);
};
const refuse = (err: unknown) =>
  createMutate.mockImplementationOnce(
    (_p: unknown, o?: { onError?: (e: unknown) => void; onSettled?: () => void }) => {
      o?.onError?.(err);
      o?.onSettled?.();
    },
  );
const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  response: { status, data: { code, ...extra } },
});
const CODE_IN_USE = "That code is already used by another item.";
const GENERIC = "Check the details and try again.";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("SA-1071 I2: a server refusal names the problem, once", () => {
  it("I2: the create hook owns its errors, so the app-wide toast cannot add a second", () => {
    mount();
    expect(createOpts).toHaveBeenCalledWith({ localErrorToast: true });
  });

  it("I2: a mapped code puts its sentence in the one toast", () => {
    const err = refusal(403, "ADDON_GATE");
    const sentence = codedToastCopy(err);
    expect(sentence).toBeTruthy();
    refuse(err);
    mount();
    fill();
    submit();
    expect(toastFn).toHaveBeenCalledTimes(1);
    expect(toastFn.mock.calls[0][0]).toMatchObject({
      title: "Failed to create product",
      description: sentence,
    });
  });

  it("I2: an unmapped error keeps the generic sentence", () => {
    refuse(new Error("network"));
    mount();
    fill();
    submit();
    expect(toastFn).toHaveBeenCalledTimes(1);
    expect(toastFn.mock.calls[0][0]).toMatchObject({ description: GENERIC });
  });

  it.each([
    ["sku", CODE_IN_USE],
    ["barcode", "That barcode is already used by another item."],
    ["unitSku", "That unit code is already used by another item."],
  ])("I2a: a %s in use is said on the one code input, with no toast", (field, sentence) => {
    refuse(refusal(400, "PRODUCT_CODE_IN_USE", { field }));
    mount();
    fill();
    submit();
    expect(toastFn).not.toHaveBeenCalled();
    const input = screen.getByPlaceholderText("Scan or type");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const message = screen.getByRole("alert");
    expect(message).toHaveTextContent(sentence);
    expect(input).toHaveAttribute("aria-describedby", message.id);
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "NEW-1" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("I2: a read-only refusal already has its own toast, so this form adds none", () => {
    refuse(refusal(403, "READ_ONLY"));
    mount();
    fill();
    submit();
    expect(toastFn).not.toHaveBeenCalled();
  });
});

describe("SA-1071 I3: a client failure names the field", () => {
  it("I3: the form turns the browser's own bubble off", () => {
    mount();
    expect(form()).toHaveAttribute("novalidate");
  });

  it("I3: an empty name gets a sentence under Name, aria-invalid, focus there, and nothing is sent", () => {
    mount();
    type(unitInput(), "each");
    submit();
    expect(screen.getByText("Enter a name for this item.")).toBeInTheDocument();
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(nameInput()).toHaveFocus();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("I3: an empty unit gets its sentence and the focus, with the name kept", () => {
    mount();
    type(nameInput(), "Fresh Pie");
    submit();
    expect(screen.getByText("Choose a unit, like each or case.")).toBeInTheDocument();
    expect(unitInput()).toHaveAttribute("aria-invalid", "true");
    expect(unitInput()).toHaveFocus();
    expect(nameInput()).toHaveValue("Fresh Pie");
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("I3: with two things wrong, focus goes to the first, and fixing a field takes its sentence away", () => {
    mount({ requirePrice: true });
    submit();
    expect(nameInput()).toHaveFocus();
    expect(screen.getByText("Enter a name for this item.")).toBeInTheDocument();
    expect(screen.getByText("Choose a unit, like each or case.")).toBeInTheDocument();
    type(nameInput(), "Fresh Pie");
    expect(screen.queryByText("Enter a name for this item.")).toBeNull();
    expect(nameInput()).not.toHaveAttribute("aria-invalid", "true");
  });

  it("I3a: a price below zero says so on every door, and a submit puts the cursor on Price", () => {
    mount({ requirePrice: true });
    fill("Fresh Pie", "each", "-5");
    expect(screen.getByText("A price can't be below $0.00.")).toBeInTheDocument();
    expect(screen.queryByText("Enter a price to sell this item.")).toBeNull();
    submit();
    expect(priceInput()).toHaveAttribute("aria-invalid", "true");
    expect(priceInput()).toHaveFocus();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("I3a: the builder's door (no required price) refuses a negative price too", () => {
    mount();
    fill("Fresh Pie", "each", "-5");
    expect(screen.getByText("A price can't be below $0.00.")).toBeInTheDocument();
    submit();
    expect(priceInput()).toHaveFocus();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("I3: a blank price on the builder's door still goes out as 0", () => {
    mount();
    type(nameInput(), "Fresh Pie");
    type(unitInput(), "each");
    submit();
    expect(createMutate.mock.calls[0][0]).toMatchObject({ pricePerUnit: "0" });
  });
});

describe("SA-1071 I4: a price that looks wrong says so", () => {
  it("I4: 1299 shows the check line, and Save still works", () => {
    mount({ requirePrice: true });
    fill("Fresh Pie", "each", "1299");
    expect(
      screen.getByText("That's $1,299.00 each. Check the price before you save."),
    ).toBeInTheDocument();
    submit();
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toMatchObject({ pricePerUnit: "1299" });
  });

  it("I4: exactly 1000 shows it; one cent under does not", () => {
    mount();
    type(priceInput(), "1000");
    expect(screen.queryAllByText(/Check the price before you save/)).toHaveLength(1);
    type(priceInput(), "999.99");
    expect(screen.queryAllByText(/Check the price before you save/)).toHaveLength(0);
  });

  it("I4a: 999.99 shows no line, and focusing Price selects what is in it", () => {
    const select = jest.spyOn(HTMLInputElement.prototype, "select");
    try {
      mount();
      type(priceInput(), "999.99");
      expect(screen.queryAllByText(/Check the price before you save/)).toHaveLength(0);
      fireEvent.focus(priceInput());
      expect(select.mock.instances).toContain(priceInput());
    } finally {
      select.mockRestore();
    }
  });

  it("I4: the line is a note, never an error", () => {
    mount();
    type(priceInput(), "1299");
    const note = screen.getByText(/Check the price before you save/);
    expect(note.getAttribute("role")).toBeNull();
    expect(priceInput()).not.toHaveAttribute("aria-invalid", "true");
    expect(within(form()).queryAllByRole("alert")).toHaveLength(0);
  });
});
