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
const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

const search = () =>
  screen.getByPlaceholderText(/search by name, sku or scan barcode/i) as HTMLInputElement;

async function pick(name: string) {
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  const row = await screen.findByRole("button", { name: new RegExp(name, "i") });
  fireEvent.click(row);
}

const lineFor = (name: string) =>
  screen
    .getAllByText(name)
    .map((el) => el.closest("li"))
    .find((li) => li?.querySelector('[title="Remove"]')) as HTMLElement;

// #2696 (b): a line's qty is an input when the modal passes onSetQty; the span is the fallback.
const unitsOf = (name: string) => {
  const line = lineFor(name);
  const input = line.querySelector<HTMLInputElement>('input[aria-label="Quantity"]');
  return input ? input.value : (line.querySelector("span.w-8.text-center")?.textContent ?? "");
};

/** Open the just-added line's note and focus it — synchronously, inside the re-arm window. */
function focusNoteOf(name: string): HTMLTextAreaElement {
  const line = lineFor(name);
  fireEvent.click(within(line).getByTitle("Add flavor / note"));
  const note = within(line).getByPlaceholderText(
    /flavor or note for this item/i,
  ) as HTMLTextAreaElement;
  act(() => note.focus());
  return note;
}

/** Wait past the re-arm window (50 ms at this site) in real time. */
const pastReArm = () => act(() => new Promise<void>((r) => setTimeout(r, 90)));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("B744 — the scanner re-arm never steals focus from a note (REG-B744)", () => {
  it("REG-B744-1: a note focused inside the re-arm window keeps focus, and the full text lands in it", async () => {
    mockResolveProductByCode.mockResolvedValue({ notFound: true, archived: false, product: null });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    const note = focusNoteOf("Sample Cola");

    await pastReArm();

    expect(document.activeElement).toBe(note);
    await user.keyboard("Fragile");
    expect(note.value).toBe("Fragile");
    expect(search().value).toBe("");
  });

  it("REG-B744-1: Enter typed in the note never runs the scan lookup or opens the New Product modal", async () => {
    mockResolveProductByCode.mockResolvedValue({ notFound: true, archived: false, product: null });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    focusNoteOf("Sample Cola");

    await pastReArm();
    await user.keyboard("Fragile{Enter}");
    await act(async () => {}); // flush any lookup the Enter started

    // The user-visible wrong value first (the phantom modal), then its cause (the lookup ran).
    expect(screen.queryByRole("heading", { name: "New Product" })).toBeNull();
    expect(mockResolveProductByCode).not.toHaveBeenCalled();
  });

  it("REG-B744-1b: when the stolen text MATCHES a product, it never adds a phantom line", async () => {
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: PLAIN,
    });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    expect(unitsOf("Sample Cola")).toBe("1");
    focusNoteOf("Sample Cola");

    await pastReArm();
    await user.keyboard("cola{Enter}");
    await act(async () => {});

    // The user-visible wrong value first (the line's qty bumped), then its cause.
    expect(unitsOf("Sample Cola")).toBe("1");
    expect(mockResolveProductByCode).not.toHaveBeenCalled();
  });
});

describe("B744 pins — scanning never dies", () => {
  it("P1: with nothing typed-into holding focus, the add still re-arms the search box", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    await waitFor(() => expect(search()).toHaveFocus());
  });

  it("P2: a focused BUTTON (the dialog's close X) does not block the re-arm", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pick("Sample Cola");
    const close = screen.getByRole("button", { name: /close/i });
    act(() => close.focus());
    expect(document.activeElement).toBe(close);

    await pastReArm();

    expect(search()).toHaveFocus();
  });

  it("P3: Enter on a known code in the search box adds the line and search keeps focus (wedge path)", async () => {
    mockResolveProductByCode.mockResolvedValue({
      notFound: false,
      archived: false,
      product: PLAIN,
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    act(() => search().focus());
    fireEvent.change(search(), { target: { value: "100200300" } });
    fireEvent.keyDown(search(), { key: "Enter" });

    await waitFor(() => expect(lineFor("Sample Cola")).toBeTruthy());
    await pastReArm();
    expect(search()).toHaveFocus();
  });
});
