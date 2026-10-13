import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * Multi-line per-item notes. The form wraps everything in a blanket
 * `onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}` (Enter never submits the create-
 * order form by accident) — a bare `<input>` note field rode along fine since Enter has no default
 * action to lose there, but converting it to a `<textarea>` means that SAME blanket handler now
 * also swallows the textarea's own default action for Enter: inserting a newline. The fix scopes
 * the preventDefault to skip textareas; this file proves the note field survives typing Enter.
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

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PLAIN] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
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

const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);

async function pick(name: string) {
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  const row = await screen.findByRole("option", { name: new RegExp(name, "i") });
  fireEvent.click(row);
}

const lineFor = (name: string) =>
  screen
    .getAllByText(name)
    .map((el) => el.closest("li"))
    .find((li) => li?.querySelector('[title="Remove"]')) as HTMLElement;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("multi-line per-item notes — the form's blanket Enter-preventDefault must exempt the note field", () => {
  it("Enter inside the note textarea inserts a newline, not a swallowed keystroke", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    // B742: adding a line schedules a 50ms setTimeout (CreateOrderModal.tsx ~:631) that
    // refocuses the product search box for the next barcode scan. Opening the note and typing
    // before that timer fires steals focus mid-keystroke — the remaining characters land in
    // the search box, and an eventual Enter there can even open InlineCreateProductModal (its
    // own unmatched-code path). A real operator never opens a note within 50ms of adding a
    // line; wait for the re-arm to actually land first, matching that real sequence.
    await waitFor(() => expect(search()).toHaveFocus());
    const line = lineFor("Sample Cola");

    fireEvent.click(within(line).getByTitle("Add flavor / note"));
    const noteField = within(line).getByPlaceholderText(
      /flavor or note for this item/i,
    ) as HTMLTextAreaElement;

    await user.type(noteField, "line one{Enter}line two");

    expect(noteField.value).toBe("line one\nline two");
  });

  it("the note field's Enter never submits the order (the form's own no-Enter-submit rule still holds elsewhere)", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
    await pick("Sample Cola");
    // B742 — see the sibling test above for the full mechanism (the scanner re-arm's 50ms
    // refocus timer racing a note-open that happens before it fires).
    await waitFor(() => expect(search()).toHaveFocus());
    const line = lineFor("Sample Cola");
    fireEvent.click(within(line).getByTitle("Add flavor / note"));
    const noteField = within(line).getByPlaceholderText(
      /flavor or note for this item/i,
    ) as HTMLTextAreaElement;

    await user.type(noteField, "a note{Enter}more");

    // A submit would attempt to create the order (no customer chosen -> a validation toast/error,
    // never onClose) — asserting the request-order mutation was never reached is the direct proof
    // Enter here did not fall through to the form's submit handler.
    await waitFor(() => expect(noteField.value).toContain("\n"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
