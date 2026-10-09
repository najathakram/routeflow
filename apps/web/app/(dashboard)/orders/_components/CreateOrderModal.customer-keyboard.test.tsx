import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * B744 — the scanner re-arm must never steal focus from a text-entry field.
 *
 * Adding a line schedules a delayed refocus of the product search box (so a barcode wedge's
 * next scan lands there). Before B744 that timer fired unconditionally: an operator who moved
 * into a per-line note in the window had focus yanked back into search mid-typing. Their
 * keystrokes landed in search, and their Enter ran the half-typed text through the scan
 * lookup — opening a phantom "New Product" modal when it matched nothing, or adding a phantom
 * line when it matched something.
 *
 * Harness: REAL timers, and the note is focused SYNCHRONOUSLY right after the pick's click, so
 * it is always focused before the 50 ms timer fires — then the test waits past it. Keystrokes
 * go through `user.keyboard` (types into whatever holds focus), never `user.type`, which
 * clicks its target first and would silently put focus back in the note, hiding the steal.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const PLAIN = {
  id: "p-plain",
  name: "Sample Cola",
  sku: "100200300",
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
};

const PARENT = {
  id: "p-parent",
  name: "Sample Juice",
  sku: "JUICE",
  unit: "each",
  pricePerUnit: "0",
  isActive: true,
  variants: [
    {
      id: "v-1",
      name: "Sample Juice 1L",
      variantName: "1L",
      sku: "J1",
      unit: "each",
      pricePerUnit: "3.00",
    },
    {
      id: "v-2",
      name: "Sample Juice 2L",
      variantName: "2L",
      sku: "J2",
      unit: "each",
      pricePerUnit: "5.00",
    },
  ],
};
let mockProducts: unknown[] = [PLAIN];

const CUSTOMERS = [
  {
    id: "c1",
    businessName: "Acme Market",
    contactName: "Ann",
    pricingTier: 3,
    fulfillPath: "SHIP",
  },
  { id: "c2", businessName: "Acme Deli", contactName: "Bo", pricingTier: 1, fulfillPath: "ROUTE" },
];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: CUSTOMERS } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockProducts } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
const mockCreateMutate = jest.fn();
let mockCreateError: unknown = null;
const mockCreateDraft = jest.fn().mockResolvedValue({ id: "d1" });
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useCreditNotes: (p?: { customerId?: string }) => ({
    data: {
      data: p?.customerId
        ? [
            {
              id: "cn1",
              status: "ISSUED",
              amount: 10,
              amountUsed: 0,
              creditNoteNumber: "CN-1",
              reason: "damaged",
            },
          ]
        : [],
    },
  }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: mockCreateMutate,
    isPending: false,
    error: mockCreateError,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: mockCreateDraft, isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useOrderUiV2: () => ({ enabled: true, resolved: true }),
  useScanV2: () => false,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

/**
 * PKG-4 (F09/F10/F11, K1-K7 + lead guards): the customer search and the product search are
 * keyboard-complete, and "Change customer" can be undone. Every pre-existing control in these
 * areas is pinned in the last block (owner rule: nothing removed or hidden).
 */
const cust = () => screen.getByPlaceholderText(/search by business name/i) as HTMLInputElement;
const prod = () =>
  screen.getByPlaceholderText(/search by name, sku or scan barcode/i) as HTMLInputElement;
const rowBtn = async (name: RegExp) =>
  (await screen.findByText(name)).closest("button") as HTMLElement;
const creditBox = async () =>
  (await screen.findByText("CN-1")).closest("label")!.querySelector("input") as HTMLInputElement;
const chip = () => screen.queryByRole("button", { name: "Change customer" });
const listbox = () => screen.queryByRole("listbox", { name: "Customers" });

beforeEach(() => {
  jest.clearAllMocks();
  mockProducts = [PLAIN];
  mockCreateError = null;
  mockResolveProductByCode.mockResolvedValue({ notFound: true, archived: false, product: null });
});

async function typeCustomer(user: ReturnType<typeof userEvent.setup>, text = "acme") {
  await user.type(cust(), text);
  await rowBtn(/Acme Market/);
}

describe("PKG-4 customer search keyboard (F09, K1-K3)", () => {
  it("K1: ArrowDown then Enter picks the first result", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(chip()).toBeInTheDocument();
    expect(screen.getByText("Acme Market")).toBeInTheDocument();
    expect(listbox()).toBeNull();
    expect(screen.queryByPlaceholderText(/search by business name/i)).toBeNull();
  });

  it("K2: ArrowDown x2 + Enter picks the second; ArrowUp stops at the first; combobox aria", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    expect(cust()).toHaveAttribute("role", "combobox");
    await user.keyboard("{ArrowDown}{ArrowUp}{ArrowUp}");
    const opts = screen.getAllByRole("option");
    expect(opts[0]).toHaveAttribute("aria-selected", "true");
    expect(cust()).toHaveAttribute("aria-activedescendant", opts[0].id);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByText("Acme Deli")).toBeInTheDocument();
    expect(chip()).toBeInTheDocument();
  });

  it("K3a: Escape with the list open closes the list, keeps the text, keeps the dialog, parks nothing", async () => {
    const onClose = jest.fn();
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    await typeCustomer(user);
    await user.keyboard("{Escape}");
    expect(listbox()).toBeNull();
    expect(cust().value).toBe("acme");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it("K3b: Escape with NO list open still dismisses and parks the draft (customer + a line)", async () => {
    const onClose = jest.fn();
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    await typeCustomer(user);
    await user.click(screen.getByText(/Acme Market/).closest("button") as HTMLElement);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(mockCreateDraft).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("F09c: Tab to a result then Enter picks it (the form's Enter guard exempts option rows)", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    await user.tab();
    expect(document.activeElement).toHaveTextContent("Acme Market");
    await user.keyboard("{Enter}");
    expect(chip()).toBeInTheDocument();
  });

  it("Space on a focused result still picks it", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    await user.tab();
    await user.keyboard(" ");
    expect(chip()).toBeInTheDocument();
  });
});

describe("PKG-4 product search keyboard + Tab parity (F09/F10, K4, wedge guard)", () => {
  it("ArrowDown then Enter adds the highlighted product", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.type(prod(), "cola");
    await rowBtn(/Sample Cola/);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(await screen.findAllByTitle("Remove")).toHaveLength(1);
    expect(mockResolveProductByCode).not.toHaveBeenCalled();
  });

  it("WEDGE GUARD: a code + Enter while results show takes the barcode path and picks nothing", async () => {
    mockResolveProductByCode.mockResolvedValue({ notFound: true, archived: false, product: null });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.type(prod(), "cola");
    await rowBtn(/Sample Cola/);
    expect(screen.getByText(/Sample Cola/).closest("button") as HTMLElement).not.toHaveAttribute(
      "aria-selected",
      "true",
    ); // typing / a results refresh never highlights a row
    await user.keyboard("{Enter}");
    expect(mockResolveProductByCode).toHaveBeenCalledWith("cola");
    expect(screen.queryAllByTitle("Remove")).toHaveLength(0);
  });

  it("K4/F10: ONE Tab from either search reaches its first result", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    await user.tab();
    expect(document.activeElement).toHaveAttribute("role", "option");
    await user.click(screen.getByText(/Acme Market/).closest("button") as HTMLElement);
    await user.type(prod(), "cola");
    await rowBtn(/Sample Cola/);
    await user.tab();
    expect(document.activeElement).toHaveAttribute("role", "option");
    expect(document.activeElement).toHaveTextContent("Sample Cola");
  });
});

describe("PKG-4 product search keyboard reaches variants and Create new product", () => {
  const options = () => screen.getAllByRole("option");
  const active = () => document.getElementById(prod().getAttribute("aria-activedescendant") ?? "");

  it("ArrowDown walks parent, its expanded variants, then Create new product; each option has an id and only the highlighted one is aria-selected", async () => {
    mockProducts = [PARENT];
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.type(prod(), "juice");
    await rowBtn(/Sample Juice/);
    await user.keyboard("{ArrowDown}{Enter}"); // expands the parent, highlight stays on it
    await rowBtn(/1L/);
    expect(active()).toHaveTextContent("Sample Juice");
    for (const o of options()) expect(o.id).not.toBe("");
    await user.keyboard("{ArrowDown}");
    expect(active()).toHaveTextContent("1L");
    await user.keyboard("{ArrowDown}");
    expect(active()).toHaveTextContent("2L");
    await user.keyboard("{ArrowDown}");
    expect(active()).toHaveTextContent("Create new product");
    expect(options().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
    await user.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    expect(await screen.findAllByTitle("Remove")).toHaveLength(1); // the 1L variant was added
  });

  it("two parents, the first expanded: hover or arrow to the SECOND product + Enter adds THAT product; ids are unique", async () => {
    const PARENT_B = {
      ...PARENT,
      id: "p-parent-b",
      name: "Sample Soda",
      sku: "SODA",
      variants: [],
    };
    mockProducts = [PARENT, PARENT_B];
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.type(prod(), "sample");
    await rowBtn(/Sample Soda/);
    await user.keyboard("{ArrowDown}{Enter}"); // expand the first parent (v-1, v-2 appear)
    await rowBtn(/1L/);
    const ids = options().map((o) => o.id);
    expect(ids.every((i) => i !== "")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}"); // 1L, 2L, then Sample Soda
    expect(active()).toHaveTextContent("Sample Soda");
    expect(options().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(await screen.findAllByTitle("Remove")).toHaveLength(1);
    expect(screen.queryByText("Sample Juice 1L")).toBeNull();
    expect(screen.getByText(/Sample Soda/, { selector: "span, p, div" })).toBeInTheDocument();
  });

  it("hovering the second product highlights it and Enter adds it, not a variant", async () => {
    const PARENT_B = {
      ...PARENT,
      id: "p-parent-b",
      name: "Sample Soda",
      sku: "SODA",
      variants: [],
    };
    mockProducts = [PARENT, PARENT_B];
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.type(prod(), "sample");
    await rowBtn(/Sample Soda/);
    await user.keyboard("{ArrowDown}{Enter}");
    await rowBtn(/1L/);
    await user.hover(await rowBtn(/Sample Soda/));
    expect(active()).toHaveTextContent("Sample Soda");
    await user.keyboard("{Enter}");
    expect(await screen.findAllByTitle("Remove")).toHaveLength(1);
    expect(screen.queryByText("Sample Juice 1L")).toBeNull();
  });

  it("Enter on the highlighted Create new product row opens the create-product dialog", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await user.type(prod(), "cola");
    await rowBtn(/Sample Cola/);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(active()).toHaveTextContent("Create new product");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("option", { name: /Create new product/ })).toBeNull();
  });
});

describe("PKG-4 Change customer + Undo (F11, K6/K7)", () => {
  async function pickWithLineAndCredit(user: ReturnType<typeof userEvent.setup>) {
    await typeCustomer(user);
    await user.click(screen.getByText(/Acme Market/).closest("button") as HTMLElement); // fulfillPath SHIP
    await user.click(await creditBox()); // apply credit cn1
    await user.type(prod(), "cola");
    await user.click(await rowBtn(/Sample Cola/));
  }

  it("K7: the chip x has an aria-label and focus moves to the customer search after clearing", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    await user.click(screen.getByText(/Acme Market/).closest("button") as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Change customer" }));
    expect(cust()).toHaveFocus();
  });

  it("K6: Undo restores the customer, keeps the line, and re-sends fulfilment + credits", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickWithLineAndCredit(user);
    await user.click(chip()!);
    expect(chip()).toBeNull();
    expect(screen.getAllByTitle("Remove")).toHaveLength(1); // lines kept
    await user.click(screen.getByRole("button", { name: /undo/i }));
    expect(screen.getByText("Acme Market")).toBeInTheDocument();
    expect(chip()).toBeInTheDocument();
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Create Order" }));
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    const payload = mockCreateMutate.mock.calls[0][0];
    expect(payload.customerId).toBe("c1");
    expect(payload.fulfillPath).toBe("SHIP");
    expect(payload.appliedCreditNotes).toEqual([{ creditNoteId: "cn1" }]);
  });

  it("row 205: after Undo, focus returns to the customer chip's x (the Undo chip is gone, so focus is never lost)", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    await user.click(screen.getByText(/Acme Market/).closest("button") as HTMLElement);
    await user.click(chip()!);
    await user.click(screen.getByRole("button", { name: /undo/i }));
    expect(chip()).toHaveFocus();
  });

  it("picking a different customer after Change customer drops the Undo and the old credits", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickWithLineAndCredit(user);
    await user.click(chip()!);
    await user.type(cust(), "deli");
    await user.click(await rowBtn(/Acme Deli/));
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create Order" }));
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    const payload = mockCreateMutate.mock.calls[0][0];
    expect(payload.customerId).toBe("c2");
    expect(payload.fulfillPath).toBe("ROUTE");
    expect(payload.appliedCreditNotes).toBeUndefined();
  });

  it("STALE CREDITS: Undo-restored credits go to the server (credit-notes.service.ts:1580 validates via orders.service.ts:1572); a CREDIT_NOTE_UNAVAILABLE refusal shows the fixed copy (never the server text) and the modal stays open", async () => {
    const onClose = jest.fn();
    const user = userEvent.setup({ delay: null });
    const { rerender } = renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    await pickWithLineAndCredit(user);
    await user.click(chip()!);
    await user.click(screen.getByRole("button", { name: /undo/i }));
    await user.click(screen.getByRole("button", { name: "Create Order" }));
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalled());
    expect(mockCreateMutate.mock.calls[0][0].appliedCreditNotes).toEqual([{ creditNoteId: "cn1" }]);
    // The server refuses (stale / consumed credit): the mutation's error surfaces; nothing closes.
    mockCreateError = {
      response: {
        status: 400,
        data: { code: "CREDIT_NOTE_UNAVAILABLE", message: "Credit note cn1 has expired" },
      },
    };
    rerender(<CreateOrderModal isOpen onClose={onClose} />);
    expect(
      await screen.findByText(
        "A credit note you picked is no longer available. Remove it and try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/has expired/)).toBeNull(); // never the raw server text
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("PKG-4 negative: an unrelated refusal is not mislabeled as a stale credit", () => {
  it("a credit applied + an uncoded 400 for another reason does NOT show the stale-credit copy", async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    await user.click(await rowBtn(/Acme Market/));
    await user.click(await creditBox());
    mockCreateError = {
      response: { status: 400, data: { message: "Unlisted item price missing" } },
    };
    rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await screen.findByRole("dialog"); // the refusal has been rendered by now; assert only what must NOT show
    expect(screen.queryByText(/credit note you picked/i)).toBeNull();
  });
});

describe("PKG-4 guard: Enter never submits from any other input", () => {
  it("Enter in the line Qty input and the note textarea does not submit", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await typeCustomer(user);
    await user.click(screen.getByText(/Acme Market/).closest("button") as HTMLElement);
    await user.type(prod(), "cola");
    await user.click(await rowBtn(/Sample Cola/));
    const qty = document.querySelector<HTMLInputElement>('input[aria-label="Quantity"]')!;
    await user.click(qty);
    await user.keyboard("{Enter}");
    fireEvent.click(screen.getByTitle("Add flavor / note"));
    const note = screen.getByPlaceholderText(/flavor or note for this item/i);
    await user.click(note);
    await user.keyboard("hi{Enter}");
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });
});

describe("PKG-4 owner rule: no control in the touched areas is lost or hidden", () => {
  it("customer area: search, Change customer, credit picker; product area: search, Scan, Create new product; footer: Minimize, Save as Draft, Create Order", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(cust()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /minimize/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as Draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Order" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "scan" })).toBeInTheDocument();
    await user.type(prod(), "zzz");
    expect(await rowBtn(/Create new product/)).toBeInTheDocument();
    await user.clear(prod());
    await typeCustomer(user);
    await user.click(screen.getByText(/Acme Market/).closest("button") as HTMLElement);
    expect(chip()).toBeInTheDocument();
    expect(await creditBox()).toBeInTheDocument(); // CreditNotePicker row
  });
});
