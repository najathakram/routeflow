import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * units_v1 FAIL-CLOSED guard on the invoice edit form (B641). update() refuses a unit line (4c-2 is not
 * built) and this form holds no unit state, so opening a draft that holds a line sold by a unit and
 * saving it would silently store a PACK line: 3 Cases (864 pieces) -> 72 pieces, money unchanged.
 * The page must REFUSE VISIBLY — say why and what to do — and never offer a save.
 */

const updateMutate = jest.fn();
const updateMutateAsync = jest.fn();
let mockInvoice: Record<string, unknown> | undefined;

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
  useUpdateInvoice: () => ({
    mutate: updateMutate,
    mutateAsync: updateMutateAsync,
    isPending: false,
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: undefined }),
  useCustomer: () => ({ data: undefined, isLoading: false }),
  useCustomerPrices: () => ({ data: undefined, isLoading: false }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: undefined }) }));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const packLine = {
  id: "li-1",
  productId: "p1",
  description: "Widget",
  qty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  unitPrice: 42,
  subtotal: 84,
};
const caseLine = {
  id: "li-2",
  productId: "p1",
  description: "Widget",
  qty: 864,
  boxes: 3,
  pieces: 0,
  unitsPerBox: 288,
  unitLabel: "Case",
  unitPrice: 480,
  subtotal: 1440,
};
const draft = (items: unknown[]) => ({
  id: "inv-1",
  invoiceNumber: "INV-0001",
  customerId: "c1",
  status: "DRAFT",
  issueDate: "2026-09-20T00:00:00.000Z",
  discount: 0,
  shippingFee: 0,
  items,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoice = undefined;
});

describe("invoice edit page — a draft holding a unit line", () => {
  it("refuses visibly: names the unit and what to do, offers a way back, and NO save", () => {
    mockInvoice = draft([packLine, caseLine]);
    renderWithProviders(<EditInvoicePage />);

    expect(screen.getByText(/sold by the Case and can.t be edited here yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/turn that line into a pack line and change its quantity/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/delete this draft and create it again/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to invoice/i })).toHaveAttribute(
      "href",
      "/invoices/inv-1",
    );
    // no form at all: nothing to save, so nothing can convert the line
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
    expect(screen.queryByText("Line Items")).toBeNull();
    expect(updateMutate).not.toHaveBeenCalled();
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it("names every distinct unit on the invoice", () => {
    mockInvoice = draft([caseLine, { ...caseLine, id: "li-3", unitLabel: "Pallet" }]);
    renderWithProviders(<EditInvoicePage />);
    expect(screen.getByText(/sold by the Case \/ Pallet/i)).toBeInTheDocument();
  });
});

describe("invoice edit page — FLAG-OFF characterization: a pack-only draft edits exactly as before", () => {
  it("renders the edit form (Line Items, Save Changes) and no unit refusal", () => {
    mockInvoice = draft([packLine]);
    renderWithProviders(<EditInvoicePage />);

    expect(screen.getByText("Line Items")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
    expect(screen.queryByText(/can.t be edited here yet/i)).toBeNull();
  });

  it("a line with a blank/null unitLabel is a pack line, not a refusal", () => {
    mockInvoice = draft([
      { ...packLine, unitLabel: null },
      { ...packLine, id: "li-4", unitLabel: "" },
    ]);
    renderWithProviders(<EditInvoicePage />);
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
  });
});

/**
 * B788: a class-validator 400 carries `message` as a `string[]` when more than
 * one constraint fails at once. Handing that array straight to the toast's
 * `description` (typed `string`) renders every entry run together with no
 * separator, instead of one readable message.
 */
describe("invoice edit page — save-error toast (B788)", () => {
  it("joins an array validation message into one readable sentence", async () => {
    mockInvoice = draft([packLine]);
    updateMutate.mockImplementation(
      (_dto: unknown, handlers: { onError: (e: unknown) => void }) => {
        handlers.onError({
          response: { data: { message: ["Description is required", "Qty must be positive"] } },
        });
      },
    );
    renderWithProviders(<EditInvoicePage />);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(screen.getByText("Description is required; Qty must be positive")).toBeInTheDocument();
  });

  it("shows a plain string message unchanged", async () => {
    mockInvoice = draft([packLine]);
    updateMutate.mockImplementation(
      (_dto: unknown, handlers: { onError: (e: unknown) => void }) => {
        handlers.onError({ response: { data: { message: "Invoice number already in use." } } });
      },
    );
    renderWithProviders(<EditInvoicePage />);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(screen.getByText("Invoice number already in use.")).toBeInTheDocument();
  });

  it("F3: a coded DUPLICATE_LINE_ID shows the fixed sentence, never the server text", async () => {
    mockInvoice = draft([packLine]);
    updateMutate.mockImplementation(
      (_dto: unknown, handlers: { onError: (e: unknown) => void }) => {
        handlers.onError({
          response: {
            status: 400,
            data: { code: "DUPLICATE_LINE_ID", message: "raw server sentence" },
          },
        });
      },
    );
    renderWithProviders(<EditInvoicePage />);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(
      screen.getByText("A line appears twice. Refresh the page and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText("raw server sentence")).toBeNull();
  });

  it("falls back to the generic message when the server sends none", async () => {
    mockInvoice = draft([packLine]);
    updateMutate.mockImplementation(
      (_dto: unknown, handlers: { onError: (e: unknown) => void }) => {
        handlers.onError({ response: { data: {} } });
      },
    );
    renderWithProviders(<EditInvoicePage />);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(screen.getByText("Please try again.")).toBeInTheDocument();
  });
});

/**
 * #2656 / SA-549: the NSF bounce-fee line is never taxed. The API refuses a rate > 0 on it
 * (NSF_LINE_UNTAXED), so the edit form locks that line's tax-rate input at 0 — and a legacy draft
 * whose NSF line was stored taxed loads (and therefore saves) at 0, healing on its next save.
 */
describe("invoice edit page — the NSF fee line's tax rate is locked at 0 (#2656)", () => {
  const goodsLine = {
    id: "li-g",
    productId: "p1",
    description: "Widget",
    qty: 1,
    unitPrice: 100,
    subtotal: 100,
    taxRate: 0.075,
  };
  const nsfLine = {
    id: "li-nsf",
    productId: null,
    description: "NSF fee — returned check #7",
    systemKind: "NSF_FEE",
    qty: 1,
    unitPrice: 25,
    subtotal: 25,
    taxRate: 0.08, // legacy: stored taxed
  };
  const findItems = (v: unknown): any[] | undefined => {
    if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && "taxRate" in x)) return v;
    if (v && typeof v === "object")
      for (const x of Object.values(v)) {
        const f = findItems(x);
        if (f) return f;
      }
    return undefined;
  };

  it("disables the NSF line's rate input at 0; the goods line's stays editable at its rate", () => {
    mockInvoice = draft([goodsLine, nsfLine]);
    renderWithProviders(<EditInvoicePage />);
    const nsfInput = screen.getByRole("textbox", { name: /NSF fee: never taxed/i });
    expect(nsfInput).toBeDisabled();
    expect((nsfInput as HTMLInputElement).value).toMatch(/^0(\.0*)?$/);
    const rateInputs = screen.getAllByPlaceholderText("0.10");
    const goodsInput = rateInputs.find((el) => el !== nsfInput)!;
    expect(goodsInput).not.toBeDisabled();
    expect((goodsInput as HTMLInputElement).value).toMatch(/^0\.075/);
  });

  it("a save sends taxRate 0 for the NSF line and the goods line's own rate", async () => {
    mockInvoice = draft([goodsLine, nsfLine]);
    renderWithProviders(<EditInvoicePage />);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const call = updateMutate.mock.calls[0] ?? updateMutateAsync.mock.calls[0];
    const items = findItems(call?.[0]);
    expect(items).toBeDefined();
    const byId = Object.fromEntries(items!.map((i: any) => [i.id, i]));
    expect(byId["li-nsf"].taxRate).toBe(0);
    expect(byId["li-g"].taxRate).toBe(0.075);
  });
});
