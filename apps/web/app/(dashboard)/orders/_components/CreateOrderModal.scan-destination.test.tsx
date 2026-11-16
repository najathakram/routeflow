import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { createNavShortcutHandler } from "@/lib/nav-shortcuts";
import { CreateOrderModal } from "./CreateOrderModal";
import { SCAN_KEY_GAP_MS } from "@/components/BarcodeScannerButton";
import { installScanClock } from "@/test-utils/scan-clock";

/**
 * SA-1138: where a scan goes in the order builder when focus is not in a text field. The REAL wedge detector (not mocked)
 * hears keydowns on the line Search only, so a scan that starts on the date chip, a button, a handle or the dialog body has to
 * be handed to Search: key 1 as Search's own keydown, then the Enter that ends the run. A person typing in any text field is
 * never touched; another open window keeps its own rules.
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock("@/lib/tenant-timezone", () => ({
  ...jest.requireActual("@/lib/tenant-timezone"),
  useTenantToday: () => "2026-11-09",
}));

const P = (id: string, name: string, sku: string) => ({
  id,
  name,
  sku,
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
});
const COLA = P("p-cola", "Sample Cola", "100");
const WATER = P("p-water", "Sample Water", "200");
const JUICE = P("p-juice", "Sample Juice", "300");
const SOLD = P("p-known", "Sample Known", "400");

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({
    data: { data: [{ id: "c1", businessName: "Acme Foods", pricingTier: 1 }] },
  }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [COLA, WATER, JUICE] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
const createOrderMutate = jest.fn();
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: (...a: unknown[]) => createOrderMutate(...a),
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
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
const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));
type Toast = {
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
};
const mockToast = jest.fn((o: Toast): string => {
  void o;
  return "t1";
});
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

const KNOWN = "4006381333931";
const LOWER = "cola12345678";
beforeEach(() => {
  jest.clearAllMocks();
  mockResolveProductByCode.mockImplementation(async (code: string) =>
    code === KNOWN || code === LOWER ? { product: SOLD, source: "sku" } : { notFound: true },
  );
});
afterEach(() => jest.restoreAllMocks());

const search = () =>
  screen.getByPlaceholderText(/search by name, sku or scan barcode/i) as HTMLInputElement;
async function pick(name: string) {
  fireEvent.change(search(), { target: { value: name.split(" ")[1].toLowerCase() } });
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name, "i") }));
}
const handle = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^Move ${name}, line`) });
const chip = () => screen.getByTestId("counter-date-chip");
const chipButton = () => within(chip()).getAllByRole("button")[0];
const picker = () => screen.queryByTestId("counter-date-picker");
async function build() {
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  for (const n of ["Sample Cola", "Sample Water"]) {
    await pick(n);
    await waitFor(() => expect(screen.getAllByText(n).length).toBeGreaterThan(0));
  }
}
const human = () => userEvent.setup({ delay: 5 });
const soldLines = () => screen.queryAllByText("Sample Known").length;
async function expectWholeScan(code: string) {
  await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalled());
  expect(mockResolveProductByCode.mock.calls.map((c) => c[0])).toEqual([code]);
  await waitFor(() => expect(soldLines()).toBeGreaterThan(0));
  expect(picker()).toBeNull();
  expect(search().value).toBe("");
  expect(chip()).toHaveAttribute("data-direction", "TODAY");
}
async function openAndEscape(user: ReturnType<typeof userEvent.setup>) {
  await user.click(chipButton());
  await screen.findByTestId("counter-date-picker");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(picker()).toBeNull());
  await waitFor(() => expect(chipButton()).toHaveFocus());
}

const scanClock = installScanClock(); // SA-1159: key stamps through the constants, never the wall clock

describe("SA-1138 office: a scan that starts off a text field goes to Search", () => {
  it("O1: picker opened, Escape, focus back on the chip: KNOWN{Enter} is looked up once, whole; the picker stays shut", async () => {
    await build();
    const user = human();
    await openAndEscape(user);
    mockResolveProductByCode.mockClear();
    await user.keyboard(`${KNOWN}{Enter}`);
    await expectWholeScan(KNOWN);
  });

  it("O2: picker Cancel by click, chip focused: a lowercase-led code is looked up once, whole", async () => {
    await build();
    const user = human();
    await user.click(chipButton());
    const p = await screen.findByTestId("counter-date-picker");
    await user.click(within(p).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(picker()).toBeNull());
    await waitFor(() => expect(chipButton()).toHaveFocus());
    mockResolveProductByCode.mockClear();
    await user.keyboard(`${LOWER}{Enter}`);
    await expectWholeScan(LOWER);
  });

  it.each([0, 50, 160, 250])(
    "O3: a scan starting %i ms after Escape in the date box: looked up once, whole, LF and CR+LF",
    async (start) => {
      for (const ending of ["{Enter}", "{Enter}{Enter}"]) {
        mockResolveProductByCode.mockClear();
        const { unmount } = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        const user = human();
        await user.click(chipButton());
        await screen.findByTestId("counter-date-picker");
        act(() => screen.getByTestId("counter-date-input").focus());
        await user.keyboard("{Escape}");
        if (start) await new Promise((r) => setTimeout(r, start));
        await user.keyboard(`${LOWER}${ending}`);
        await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalled());
        expect(mockResolveProductByCode.mock.calls.map((c) => c[0])).toEqual([LOWER]);
        await waitFor(() => expect(soldLines()).toBeGreaterThan(0));
        expect(picker()).toBeNull();
        expect(search().value).toBe("");
        unmount();
      }
    },
  );

  it("O4: from a checkbox, KNOWN{Enter} is looked up once, whole, and nothing is toggled", async () => {
    await build();
    const box = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    const before = box.checked;
    box.focus();
    mockResolveProductByCode.mockClear();
    await human().keyboard(`${KNOWN}{Enter}`);
    await expectWholeScan(KNOWN);
    expect(box.checked).toBe(before);
  });

  it("O4b: a 300 ms stall inside the scan (stamped time) is not looked up as a code: the Search field's own submit gets the whole code (SA-1159)", async () => {
    await build();
    const box = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    box.focus();
    mockResolveProductByCode.mockClear();
    const user = human();
    await user.keyboard(KNOWN.slice(0, 1));
    scanClock.advance(SCAN_KEY_GAP_MS + 100); // past SCAN_KEY_GAP_MS, well under SCAN_STALL_MAX_MS
    await user.keyboard(`${KNOWN.slice(1)}{Enter}`);
    await expectWholeScan(KNOWN); // exactly one lookup, of the whole code (the suffix never reaches onScan)
    expect(box.checked).toBe(false);
  });

  it("O5: key 1 goes to Search, the chip takes focus back, the rest and Enter: one lookup, whole, the picker does NOT open", async () => {
    await build();
    chipButton().focus();
    const user = human();
    mockResolveProductByCode.mockClear();
    await user.keyboard(KNOWN.slice(0, 1));
    expect(search()).toHaveFocus();
    act(() => chipButton().focus()); // what the chip does after the picker closed (CounterDateChip done())
    await user.keyboard(`${KNOWN.slice(1)}{Enter}`);
    await expectWholeScan(KNOWN);
  });

  it("O6: a scan with CR+LF typed on a line handle: one line added, one lookup, no picker", async () => {
    await build();
    handle("Sample Cola").focus();
    mockResolveProductByCode.mockClear();
    await human().keyboard(`${KNOWN}{Enter}{Enter}`);
    await expectWholeScan(KNOWN);
  });

  it("OG8: a handle picked up with Space, then KNOWN{Enter}: the move is cancelled, looked up once whole, order unchanged; ArrowDown in Search moves no line", async () => {
    await build();
    const h = handle("Sample Cola");
    h.focus();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h).toHaveAttribute("aria-pressed", "true");
    mockResolveProductByCode.mockClear();
    await human().keyboard(`${KNOWN}{Enter}`);
    await expectWholeScan(KNOWN);
    await waitFor(() => expect(h).not.toHaveAttribute("aria-pressed", "true"));
    await human().keyboard("{ArrowDown}");
    const cola = screen.getAllByText("Sample Cola")[0];
    const water = screen.getAllByText("Sample Water")[0];
    expect(cola.compareDocumentPosition(water) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("OG9: from a builder button, go1234{Enter}: Search receives go1234 and the shortcut does not fire", async () => {
    const navigate = jest.fn();
    const handler = createNavShortcutHandler({
      push: navigate,
      routesAccess: true,
      counterEnabled: true,
      toggleHelp: jest.fn(),
    });
    window.addEventListener("keydown", handler);
    try {
      await build();
      chipButton().focus();
      mockResolveProductByCode.mockClear();
      await human().keyboard("go1234{Enter}");
      await waitFor(() => expect(mockResolveProductByCode).toHaveBeenCalledWith("go1234"));
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", handler);
    }
  });
});

describe("SA-1138 office guards", () => {
  it("OG1: a person typing in Search keeps every key; no lookup until Enter", async () => {
    await build();
    search().focus();
    await userEvent.keyboard("sample cola", { delay: null });
    expect(search().value).toBe("sample cola");
    expect(mockResolveProductByCode).not.toHaveBeenCalled();
  });

  it("OG3: a plain Enter on the chip, no scan before it, opens the picker", async () => {
    await build();
    chipButton().focus();
    await userEvent.keyboard("{Enter}", { delay: null });
    expect(await screen.findByTestId("counter-date-picker")).toBeInTheDocument();
    expect(mockResolveProductByCode).not.toHaveBeenCalled();
  });

  it("OG3b: any other key after a scan key ends the run: a later Enter on the chip opens the picker", async () => {
    await build();
    chipButton().focus();
    const user = userEvent.setup({ delay: null });
    await user.keyboard("a");
    act(() => chipButton().focus());
    await user.keyboard("{Escape}");
    act(() => chipButton().focus());
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("counter-date-picker")).toBeInTheDocument();
  });

  it("OG4: with the picker open, a scan is the picker's inert run: no lookup, the note shows", async () => {
    await build();
    const user = human();
    await user.click(chipButton());
    const p = await screen.findByTestId("counter-date-picker");
    act(() =>
      within(p)
        .getByRole("grid", { name: /^Calendar/ })
        .focus(),
    );
    await user.keyboard(`${KNOWN}{Enter}`);
    expect(mockResolveProductByCode).not.toHaveBeenCalled();
    expect(screen.getByTestId("counter-date-scan-note")).toBeInTheDocument();
  });

  it("OG6: Space on a builder checkbox still presses it", async () => {
    await build();
    const box = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    const before = box.checked;
    box.focus();
    await userEvent.keyboard(" ", { delay: null });
    expect(box.checked).toBe(!before);
    expect(mockResolveProductByCode).not.toHaveBeenCalled();
  });
});
