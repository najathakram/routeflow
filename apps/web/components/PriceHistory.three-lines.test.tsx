import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within, fireEvent } from "@/test-utils/render";
import { PriceHistoryButton } from "./PriceHistory";
import type {
  PriceHistoryComparisonLine,
  PriceHistoryResponse,
  PriceHistoryRow,
} from "@/lib/api/price-history";

/**
 * SA-954 (owner 16:15Z) + the mm-ux spec (2026-10-25): three lines on one plot, one toggle chip per line. The web draws
 * the server's `comparison` and never converts. Never a silent hide: each line that cannot draw says why.
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const row = (over: Partial<PriceHistoryRow> = {}): PriceHistoryRow => ({
  date: "2026-09-20T00:00:00.000Z",
  source: "INVOICE",
  unitPrice: 25,
  unitLabel: "Box",
  unitsPerBox: 12,
  salePack: over.unitsPerBox !== undefined ? (over.unitsPerBox ?? 1) : 12, // the server's pairing unless a case sets it
  qty: 2,
  boxes: 2,
  pieces: 0,
  avgCostAtSale: null,
  invoiceId: "inv-1",
  invoiceNumber: "INV-1",
  orderId: "o-1",
  orderNumber: "ORD-1",
  priceType: null,
  ...over,
});
const entry = (over: Partial<PriceHistoryComparisonLine> = {}): PriceHistoryComparisonLine => ({
  unitLabel: "Box",
  unitsPerBox: 12,
  likeForLike: [
    { month: "2026-08", average: 24 },
    { month: "2026-09", average: 24.5 },
  ],
  converted: [
    { month: "2026-08", average: 25.2 },
    { month: "2026-09", average: 25.11 },
  ],
  ...over,
});
const base = (over: Partial<PriceHistoryResponse> = {}): PriceHistoryResponse => ({
  customerId: "c1",
  customerName: "Acme Foods",
  productId: "p1",
  productName: "Cola",
  costVisible: false,
  rows: [
    row({ date: "2026-08-10T00:00:00.000Z", unitPrice: 24, invoiceNumber: "INV-A", orderId: "a" }),
    row({ date: "2026-09-10T00:00:00.000Z", unitPrice: 25, invoiceNumber: "INV-B", orderId: "b" }),
  ],
  summaries: [{ unitLabel: "Box", last: 25, low: 24, high: 25, qtySold: 4, currentAvgCost: null }],
  references: { listPrice: null, tierPrice: null, changeSinceLast: null },
  aggregate: { low: 9, median: 11.5, high: 15, customers: 7, unitLabel: "Box" },
  comparison: [entry()],
  ...over,
});

/** The base request carries no comparison; `?compare=all` adds it (mirrors the server). */
const serve = (data: PriceHistoryResponse, cmp?: () => Promise<unknown>) =>
  mockGet.mockImplementation((_url: string, cfg?: { params?: { compare?: string } }) => {
    if (cfg?.params?.compare !== "all") {
      const { aggregate: _a, comparison: _c, ...plain } = data;
      return Promise.resolve({ data: plain });
    }
    return cmp ? cmp() : Promise.resolve({ data });
  });

const onUse = jest.fn();
const open = async (extra: Record<string, unknown> = {}) => {
  renderWithProviders(
    <div>
      <input aria-label="price input" />
      <PriceHistoryButton
        customerId="c1"
        customerName="Acme Foods"
        productId="p1"
        productName="Cola"
        onUsePrice={onUse}
        {...extra}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Price history" }));
  const dialog = await screen.findByRole("dialog", { name: "Price history" });
  await within(dialog).findByText("INV-B");
  return dialog;
};
const chip = (dialog: HTMLElement, id: "own" | "like" | "conv") =>
  within(dialog).getByTestId(`chip-${id}`);
const line = (dialog: HTMLElement, id: "own" | "like" | "conv") =>
  within(dialog).getByTestId(`line-${id}`);
const settled = (dialog: HTMLElement) =>
  waitFor(() => expect(within(dialog).queryByText("Loading averages…")).toBeNull());

beforeEach(() => {
  jest.clearAllMocks();
});

describe("three lines, three toggles", () => {
  it("all three start on, in order, as pressed buttons in a labelled group", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    const group = within(dialog).getByRole("group", { name: "Lines on the chart" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("data-testid"))).toEqual([
      "chip-own",
      "chip-like",
      "chip-conv",
    ]);
    for (const c of chips) expect(c).toHaveAttribute("aria-pressed", "true");
    for (const id of ["own", "like", "conv"] as const)
      expect(line(dialog, id)).toHaveAttribute("data-on", "true");
  });

  it("the chips carry their accessible names and the reference lines' newest values", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    expect(chip(dialog, "own")).toHaveAccessibleName("This customer's prices, Box of 12");
    expect(chip(dialog, "like")).toHaveAccessibleName(
      "Other customers' average, Box of 12, latest Sep 2026: $24.50",
    );
    expect(chip(dialog, "conv")).toHaveAccessibleName(
      "All customers, all units, average per Box of 12, latest Sep 2026: $25.11",
    );
    expect(chip(dialog, "like")).toHaveTextContent("$24.50");
    expect(chip(dialog, "conv")).toHaveTextContent("$25.11");
    expect(chip(dialog, "own")).not.toHaveTextContent("$"); // it would repeat the Last stat
  });

  it("a click turns a line off and on; the other lines and the price scale stay put", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    const ownBefore = line(dialog, "own").querySelector("polyline")!.getAttribute("points");
    const convBefore = line(dialog, "conv").querySelector("polyline")!.getAttribute("points");
    fireEvent.click(chip(dialog, "like"));
    expect(chip(dialog, "like")).toHaveAttribute("aria-pressed", "false");
    expect(line(dialog, "like")).toHaveAttribute("data-on", "false");
    expect(line(dialog, "own")).toHaveAttribute("data-on", "true");
    expect(line(dialog, "conv")).toHaveAttribute("data-on", "true");
    // turning a line off never rescales the others
    expect(line(dialog, "own").querySelector("polyline")!.getAttribute("points")).toBe(ownBefore);
    expect(line(dialog, "conv").querySelector("polyline")!.getAttribute("points")).toBe(convBefore);
    fireEvent.click(chip(dialog, "like"));
    expect(chip(dialog, "like")).toHaveAttribute("aria-pressed", "true");
    expect(line(dialog, "like")).toHaveAttribute("data-on", "true");
  });

  it("the choice survives a unit-tab change while the popover is open", async () => {
    const two = base({
      rows: [
        row({ date: "2026-09-10T00:00:00.000Z", unitLabel: "Box", invoiceNumber: "INV-B" }),
        row({
          date: "2026-09-05T00:00:00.000Z",
          unitLabel: "Piece",
          unitsPerBox: null,
          unitPrice: 2.1,
          invoiceNumber: "INV-P",
          orderId: "p",
        }),
      ],
      summaries: [
        { unitLabel: "Box", last: 25, low: 25, high: 25, qtySold: 1, currentAvgCost: null },
        { unitLabel: "Piece", last: 2.1, low: 2.1, high: 2.1, qtySold: 1, currentAvgCost: null },
      ],
      comparison: [entry(), entry({ unitLabel: "Piece", unitsPerBox: null })],
    });
    serve(two);
    const dialog = await open();
    await settled(dialog);
    fireEvent.click(chip(dialog, "conv"));
    fireEvent.click(within(dialog).getByRole("tab", { name: "Piece" }));
    expect(chip(dialog, "conv")).toHaveAttribute("aria-pressed", "false");
    expect(chip(dialog, "own")).toHaveAttribute("aria-pressed", "true");
  });

  it("keyboard: Tab reaches every chip, Space toggles, focus stays, the popover stays, no price is used", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    const user = userEvent.setup();
    chip(dialog, "own").focus();
    await user.tab();
    expect(chip(dialog, "like")).toHaveFocus();
    await user.keyboard(" ");
    expect(chip(dialog, "like")).toHaveAttribute("aria-pressed", "false");
    expect(chip(dialog, "like")).toHaveFocus();
    await user.tab();
    expect(chip(dialog, "conv")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(chip(dialog, "conv")).toHaveAttribute("aria-pressed", "false");
    expect(chip(dialog, "conv")).toHaveFocus();
    expect(onUse).not.toHaveBeenCalled(); // Enter on a chip never uses a row's price
    expect(screen.getByRole("dialog", { name: "Price history" })).toBeInTheDocument();
  });

  it("every drawable line off keeps the plot and says how to bring one back", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    for (const id of ["own", "like", "conv"] as const) fireEvent.click(chip(dialog, id));
    expect(within(dialog).getByText("Turn on a line to see it.")).toBeInTheDocument();
    expect(within(dialog).getByRole("img")).toHaveAccessibleName(
      "Price over time: every line is off",
    );
  });

  it("the plot's label lists the lines that are drawn", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    expect(within(dialog).getByRole("img")).toHaveAccessibleName(
      "Price over time: this customer, 2 sales; other customers' monthly average; all customers, all units, monthly average",
    );
    fireEvent.click(chip(dialog, "like"));
    expect(within(dialog).getByRole("img")).toHaveAccessibleName(
      "Price over time: this customer, 2 sales; all customers, all units, monthly average",
    );
  });
});

describe("the compare pills are labelled (mm-ux 93.8% follow-up 2)", () => {
  it("a visible 'Compare:' precedes the pills, so two 'This customer' controls do not read as one", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    const label = within(dialog).getByText("Compare:");
    expect(label).toBeVisible();
    const pills = within(dialog).getByRole("group", { name: "Compare" });
    expect(pills.contains(label)).toBe(true);
    // the pill stays "This customer" there; the chart chip has its own accessible name
    expect(within(pills).getByRole("button", { name: "This customer" })).toBeInTheDocument();
    expect(chip(dialog, "own")).toHaveAccessibleName("This customer's prices, Box of 12");
  });

  it("W-785 type lens: the small label and the small notes are navy/70 (6.4 on white, 6.3 on canvas, 6.0 on sunken), not navy/60 (4.4 on sunken)", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    const small = [within(dialog).getByText("Compare:"), within(dialog).getByText(/^Customer: /)];
    for (const el of small) {
      expect(el.className).toContain("text-navy/70");
      expect(el.className).not.toContain("text-navy/60");
    }
  });
});

describe("the three lines look different by shape, not colour alone", () => {
  it("line 1 is solid and thick with a dot per sale; lines 2 and 3 are thin, dashed and dotted", async () => {
    serve(base());
    const dialog = await open();
    await settled(dialog);
    const own = line(dialog, "own").querySelector("polyline")!;
    const like = line(dialog, "like").querySelector("polyline")!;
    const conv = line(dialog, "conv").querySelector("polyline")!;
    expect(own.getAttribute("stroke-width")).toBe("2");
    expect(own.getAttribute("stroke-dasharray")).toBeNull();
    expect(like.getAttribute("stroke-width")).toBe("1.25");
    expect(like.getAttribute("stroke-dasharray")).toBe("5 3");
    expect(conv.getAttribute("stroke-dasharray")).toBe("0.01 3.5");
    expect(within(dialog).getAllByTestId("own-dot")).toHaveLength(2);
  });

  it("WCAG 1.4.11: the reference stroke colour alone reaches 3:1 against white", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
    const m = css.match(/--ink-900-rgb:\s*(\d+)\s+(\d+)\s+(\d+)/)!;
    const alpha = 0.6; // text-navy/60, the reference lines' class
    const [r, g, b] = [m[1], m[2], m[3]].map((c) =>
      Math.round(alpha * Number(c) + (1 - alpha) * 255),
    );
    const lin = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const lum = 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    expect(1.05 / (lum + 0.05)).toBeGreaterThanOrEqual(3);
  });

  it("a month the server withheld is a gap, never bridged; a lone month is a marker", async () => {
    serve(
      base({
        comparison: [
          entry({
            likeForLike: [
              { month: "2026-06", average: 23 },
              { month: "2026-08", average: 24 },
            ],
            converted: [{ month: "2026-09", average: 25.11 }],
          }),
        ],
      }),
    );
    const dialog = await open();
    await settled(dialog);
    expect(line(dialog, "like").querySelector("polyline")).toBeNull();
    expect(within(dialog).getAllByTestId("lone-like")).toHaveLength(2);
    expect(within(dialog).getAllByTestId("lone-conv")).toHaveLength(1);
  });
});

describe("a line that cannot draw says why (never a silent hide)", () => {
  it("line 2 empty: its chip is disabled, focusable, described by its note; line 3 still draws", async () => {
    serve(base({ comparison: [entry({ likeForLike: [] })] }));
    const dialog = await open();
    await settled(dialog);
    const c = chip(dialog, "like");
    expect(c).toHaveAttribute("aria-disabled", "true");
    expect(c).not.toBeDisabled();
    expect(c).toHaveAttribute("aria-pressed", "false");
    const note =
      "Other customers: no average for Box of 12 yet. It needs 3 other buyers in a month.";
    expect(within(dialog).getByText(note)).toBeInTheDocument();
    expect(c).toHaveAccessibleDescription(note);
    fireEvent.click(c);
    expect(c).toHaveAttribute("aria-pressed", "false");
    expect(line(dialog, "conv")).toHaveAttribute("data-on", "true");
    expect(within(dialog).queryByTestId("line-like")).toBeNull();
  });

  it("both reference lines empty: one note replaces both", async () => {
    serve(base({ comparison: [entry({ likeForLike: [], converted: [] })] }));
    const dialog = await open();
    await settled(dialog);
    expect(
      within(dialog).getAllByText("No averages yet. Each needs 3 other buyers in a month."),
    ).toHaveLength(1);
    expect(chip(dialog, "like")).toHaveAttribute("aria-disabled", "true");
    expect(chip(dialog, "conv")).toHaveAttribute("aria-disabled", "true");
  });

  it("an older server with no comparison field: the lines cannot draw and the note says so", async () => {
    serve(base({ comparison: undefined }));
    const dialog = await open();
    await settled(dialog);
    expect(within(dialog).getByText("Averages aren't available.")).toBeInTheDocument();
    expect(chip(dialog, "like")).toHaveAttribute("aria-disabled", "true");
  });

  it("never sold with reference lines: the never-sold note, line 1 disabled and described by it", async () => {
    serve(base({ rows: [], summaries: [] }));
    renderWithProviders(
      <PriceHistoryButton
        customerId="c1"
        customerName="Acme Foods"
        productId="p1"
        productName="Cola"
        onUsePrice={onUse}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    expect(await within(dialog).findByText("Not sold to this customer before.")).toHaveAttribute(
      "role",
      "status",
    );
    await settled(dialog);
    expect(chip(dialog, "own")).toHaveAttribute("aria-disabled", "true");
    expect(chip(dialog, "own")).toHaveAccessibleDescription("Not sold to this customer before.");
    expect(line(dialog, "like")).toHaveAttribute("data-on", "true");
    expect(line(dialog, "conv")).toHaveAttribute("data-on", "true");
  });

  it("never sold, line 2 empty and line 3 drawn: the never-sold note plus line 2's note", async () => {
    serve(base({ rows: [], summaries: [], comparison: [entry({ likeForLike: [] })] }));
    renderWithProviders(
      <PriceHistoryButton customerId="c1" productId="p1" productName="Cola" onUsePrice={onUse} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    expect(await within(dialog).findByText(/no average for Box of 12 yet/)).toBeInTheDocument();
    expect(within(dialog).getByText("Not sold to this customer before.")).toBeInTheDocument();
  });

  it("never sold and no averages anywhere: the kept sentence", async () => {
    serve(base({ rows: [], summaries: [], aggregate: null, comparison: [] }));
    renderWithProviders(
      <PriceHistoryButton customerId="c1" productId="p1" productName="Cola" onUsePrice={onUse} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Price history" }));
    const dialog = await screen.findByRole("dialog", { name: "Price history" });
    expect(
      await within(dialog).findByText(
        "There aren't enough sales to other customers to show an average yet.",
      ),
    ).toBeInTheDocument();
  });

  it("the comparison request failed: line 1 stays, the legend says so with Retry", async () => {
    serve(base(), () => Promise.reject(new Error("429")));
    const dialog = await open();
    expect(await within(dialog).findByText(/Couldn't load the averages\./)).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Retry");
    expect(line(dialog, "own")).toHaveAttribute("data-on", "true");
    expect(chip(dialog, "like")).toHaveAttribute("aria-disabled", "true");
    expect(chip(dialog, "conv")).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).queryByText(/couldn.t load price history/i)).toBeNull();
  });

  it("failed with the All customers panel open: ONE message, and the chips point at the panel's", async () => {
    serve(base(), () => Promise.reject(new Error("429")));
    const dialog = await open();
    await within(dialog).findByText(/Couldn't load the averages\./);
    fireEvent.click(within(dialog).getByRole("button", { name: "All customers" }));
    await within(dialog).findByText(/Couldn't load the comparison\./);
    expect(within(dialog).queryByText(/Couldn't load the averages\./)).toBeNull();
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    expect(chip(dialog, "like")).toHaveAccessibleDescription(/Couldn't load the comparison\./);
  });

  it("while loading, lines 2 and 3 are not drawn and the chips say Loading averages…", async () => {
    let release: (v: unknown) => void = () => undefined;
    serve(base(), () => new Promise((resolve) => (release = () => resolve({ data: base() }))));
    const dialog = await open();
    expect(await within(dialog).findByText("Loading averages…")).toBeInTheDocument();
    expect(chip(dialog, "like")).toHaveAttribute("aria-disabled", "true");
    release(null);
    await settled(dialog);
    expect(chip(dialog, "like")).not.toHaveAttribute("aria-disabled");
  });

  it("a tab whose pack differs from the summary's draws lines 2 and 3 from the matching entry", async () => {
    serve(
      base({
        comparison: [
          entry({
            unitsPerBox: 24,
            likeForLike: [{ month: "2026-09", average: 50 }],
            converted: [],
          }),
          entry({ unitsPerBox: 12 }),
        ],
      }),
    );
    const dialog = await open();
    await settled(dialog);
    expect(chip(dialog, "like")).toHaveTextContent("$24.50");
    expect(chip(dialog, "like")).not.toHaveTextContent("$50.00");
  });

  it("line 1 filtered by pack: the chart draws the newest pack only and says so", async () => {
    serve(
      base({
        rows: [
          row({ date: "2026-09-10T00:00:00.000Z", unitsPerBox: 12, invoiceNumber: "INV-B" }),
          row({
            date: "2026-08-10T00:00:00.000Z",
            unitsPerBox: 24,
            unitPrice: 48,
            invoiceNumber: "INV-OLD",
            orderId: "x",
          }),
        ],
      }),
    );
    const dialog = await open();
    await settled(dialog);
    expect(
      within(dialog).getByText("The chart shows Box of 12 sales only. The table lists them all."),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByTestId("own-dot")).toHaveLength(1);
    expect(within(dialog).getByText("INV-OLD")).toBeInTheDocument(); // the table keeps every row
  });
});
