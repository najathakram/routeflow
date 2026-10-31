import * as React from "react";
import { renderWithProviders, screen, waitFor, within, fireEvent } from "@/test-utils/render";
import { PriceHistoryButton } from "./PriceHistory";
import type {
  PriceHistoryComparisonLine,
  PriceHistoryResponse,
  PriceHistoryRow,
} from "@/lib/api/price-history";

/**
 * W-1058 H-1 (SA-1069 section B): the price-history popover is closable on a phone, an outside tap dismisses it
 * (pointerdown, not mousedown), the chart is taller under 640px, and line 2 is named "All customers".
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const row = (over: Partial<PriceHistoryRow> = {}): PriceHistoryRow => ({
  date: "2026-09-10T00:00:00.000Z",
  source: "INVOICE",
  unitPrice: 25,
  unitLabel: "Box",
  unitsPerBox: 12,
  salePack: 12,
  qty: 2,
  boxes: 2,
  pieces: 0,
  avgCostAtSale: null,
  invoiceId: "inv-1",
  invoiceNumber: "INV-B",
  orderId: "b",
  orderNumber: "ORD-1",
  priceType: null,
  ...over,
});
const comparison: PriceHistoryComparisonLine = {
  unitLabel: "Box",
  unitsPerBox: 12,
  likeForLike: [
    { month: "2026-08", average: 24 },
    { month: "2026-09", average: 24.5 },
  ],
  converted: [{ month: "2026-09", average: 25.11 }],
};
const data = (over: Partial<PriceHistoryResponse> = {}): PriceHistoryResponse => ({
  customerId: "c1",
  customerName: "Acme Foods",
  productId: "p1",
  productName: "Cola",
  costVisible: false,
  rows: [
    row({ date: "2026-08-10T00:00:00.000Z", unitPrice: 24, orderId: "a", invoiceNumber: "INV-A" }),
    row(),
  ],
  summaries: [{ unitLabel: "Box", last: 25, low: 24, high: 25, qtySold: 4, currentAvgCost: null }],
  references: { listPrice: null, tierPrice: null, changeSinceLast: null },
  aggregate: null,
  comparison: [comparison],
  ...over,
});

const setViewport = (narrow: boolean) => {
  window.matchMedia = jest.fn().mockImplementation((q: string) => ({
    matches: q.includes("min-width: 640px") ? !narrow : false,
    media: q,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
};

const open = async () => {
  renderWithProviders(
    <div>
      <PriceHistoryButton
        customerId="c1"
        customerName="Acme Foods"
        productId="p1"
        productName="Cola"
        onUsePrice={jest.fn()}
      />
      <p>outside</p>
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Price history" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Price history" });
  await within(dialog).findByText("INV-B");
  await waitFor(() => expect(within(dialog).queryByText("Loading averages…")).toBeNull());
  return { dialog, trigger };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ data: data() });
});
afterEach(() => {
  // @ts-expect-error: put jsdom's missing matchMedia back
  delete window.matchMedia;
});

describe("H1: a close button in the panel header at every width", () => {
  it.each([
    ["390px", true],
    ["desktop", false],
  ])("at %s: it closes the panel and returns focus to the trigger", async (_n, narrow) => {
    setViewport(narrow);
    const { dialog, trigger } = await open();
    const close = within(dialog).getByRole("button", { name: "Close price history" });
    expect(close.className).toMatch(/min-h-11/); // 44px under sm
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Price history" })).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("H2: an outside pointerdown dismisses (touch sends no mouse events)", () => {
  it("pointerDown on the page closes the panel; a pointerDown inside does not", async () => {
    setViewport(true);
    const { dialog } = await open();
    fireEvent.pointerDown(within(dialog).getByText(/Customer:/));
    expect(screen.getByRole("dialog", { name: "Price history" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText("outside"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Price history" })).toBeNull());
  });
});

describe("H3: the chart is 140px tall under 640px", () => {
  it("is 140 under 640px and 96 from 640px", async () => {
    setViewport(true);
    const narrow = await open();
    expect(within(narrow.dialog).getByRole("img", { name: /Price over time/ })).toHaveAttribute(
      "height",
      "140",
    );
  });
  it("is 96 from 640px up", async () => {
    setViewport(false);
    const wide = await open();
    expect(within(wide.dialog).getByRole("img", { name: /Price over time/ })).toHaveAttribute(
      "height",
      "96",
    );
  });
});

describe("H4: line 2 is named All customers, and says this customer is out of it", () => {
  it("the chip reads All customers, its title says except this one, its name follows", async () => {
    setViewport(false);
    const { dialog } = await open();
    const chip = within(dialog).getByTestId("chip-like");
    expect(chip).toHaveTextContent("All customers");
    expect(chip).not.toHaveTextContent("Other customers");
    expect(chip).toHaveAttribute("title", "All customers except this one");
    expect(chip.getAttribute("aria-label")).toMatch(/^All customers/);
    expect(chip.getAttribute("aria-label")).not.toMatch(/Other customers/);
    expect(within(dialog).getByTestId("chip-conv")).toHaveTextContent("All units");
  });
});

describe("H5: the Compare pill and the Low / Typical / High panel stay", () => {
  it("the pill is still there", async () => {
    setViewport(false);
    const { dialog } = await open();
    expect(
      within(dialog).getByRole("button", { name: "All customers", pressed: false }),
    ).toBeInTheDocument();
  });
});

describe("H7: tapping the trigger while open closes once", () => {
  it("pointerdown + click on the trigger leaves it closed (the outside rule excludes the trigger)", async () => {
    setViewport(true);
    const { trigger } = await open();
    fireEvent.pointerDown(trigger);
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Price history" })).toBeNull());
  });
});
