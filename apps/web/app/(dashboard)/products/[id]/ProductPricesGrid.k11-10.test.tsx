import * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricesGrid } from "./ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";
import type { GridEditApi } from "./units-v2/edit/edit-types";

// K11-10: all five tiers fit at 1440 (read and edit), or the grid says what is clipped. Jest cannot lay anything out, so
// the barcode, Contains and box sizes are asserted as classes and the overflow cue is driven through a mocked
// IntersectionObserver (the real geometry is the Playwright spec's job).

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockLabels: Record<string, string> = { "2": "Wholesale", "3": "Distributor" };
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => mockGrid }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: mockLabels }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));

const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "piece",
  revision: 0,
  priceState: "state-0",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 960,
      kind: "pack",
      editable: true,
      code: "012345678905",
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "box",
      label: "Box",
      factor: 24,
      kind: "unit",
      editable: true,
      code: null,
      cells: cells([24.5, 22, 21, 20, 19]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set", "auto", "auto", "auto", "auto"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

interface IoEntryInit {
  target: Element;
  ratio: number;
  right: number;
  rootRight: number;
}
let io: MockIO | null = null;

class MockIO {
  observed: Element[] = [];
  cb: IntersectionObserverCallback;
  opts: IntersectionObserverInit | undefined;
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.cb = cb;
    this.opts = opts;
    io = this;
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const report = (entries: IoEntryInit[]) =>
  act(() => {
    io!.cb(
      entries.map(
        (e) =>
          ({
            target: e.target,
            intersectionRatio: e.ratio,
            isIntersecting: e.ratio > 0,
            boundingClientRect: { left: e.right - 80, right: e.right },
            rootBounds: { left: 0, right: e.rootRight },
          }) as unknown as IntersectionObserverEntry,
      ),
      io as unknown as IntersectionObserver,
    );
  });
const heads = () => io!.observed as HTMLElement[];
/** Report these tiers (1 to 5) as cut off on the right and every other header as fully inside. */
const clip = (...tiers: number[]) =>
  report(
    heads().map((h, i) => ({
      target: h,
      ratio: tiers.includes(i + 1) ? 0.3 : 1,
      right: tiers.includes(i + 1) ? 1100 : 500,
      rootRight: 900,
    })),
  );

const editApi = (): GridEditApi => ({
  editing: true,
  begin: jest.fn(),
  text: (_r, _t, original) => original,
  setText: jest.fn(),
  changed: () => false,
  problem: () => null,
  addUnitProblem: () => null,
  rows: null,
  focus: null,
  focused: jest.fn(),
});

beforeEach(() => {
  io = null;
  mockLabels = { "2": "Wholesale", "3": "Distributor" };
  mockGrid = { data: grid, isLoading: false, isError: false };
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;
});
afterEach(() => {
  delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe("K11-10: the barcode sits in the Unit cell", () => {
  it("the table has no Barcode column and shows each barcode once, as a second line under the unit name", () => {
    render(<ProductPricesGrid product={product} />);
    const table = within(screen.getByTestId(T.unitsTable));
    expect(table.queryByRole("columnheader", { name: "Barcode" })).toBeNull();
    for (const row of grid.rows) {
      const inRow = within(screen.getByTestId(T.row(row.ref)));
      expect(inRow.getAllByTestId(T.code(row.ref))).toHaveLength(1);
    }
    const cell = within(screen.getByTestId(T.row("case"))).getByRole("rowheader");
    const code = within(cell).getByTestId(T.code("case"));
    expect(code.textContent).toBe("012345678905");
    expect(code.className).toMatch(/\btext-xs\b/);
    expect(code.className).toMatch(/\bfont-normal\b/);
    expect(code.className).toMatch(/\btabular-nums\b/);
    expect(code.className).toMatch(/\btext-navy\/60\b/);
    expect(within(screen.getByTestId(T.row("box"))).getByTestId(T.code("box")).textContent).toBe(
      "No barcode",
    );
  });

  it("the Unit cell is bounded so a long reason cannot widen the pinned column", () => {
    render(<ProductPricesGrid product={product} />);
    const cell = within(screen.getByTestId(T.row("case"))).getByRole("rowheader");
    expect(cell.className).toMatch(/min-w-\[7rem\]/);
    expect(cell.className).toMatch(/max-w-\[10rem\]/);
    expect(cell.className).toMatch(/\bwhitespace-normal\b/);
    expect(cell.className).toMatch(/\bbg-white\b/);
  });

  it("order inside the Unit cell: name, barcode, then the not-editable reason", () => {
    mockGrid = {
      data: {
        ...grid,
        rows: grid.rows.map((r) =>
          r.ref === "case"
            ? { ...r, editable: false, notEditableReason: "Priced by the family." }
            : r,
        ),
      },
      isLoading: false,
      isError: false,
    };
    render(<ProductPricesGrid product={product} />);
    const cell = within(screen.getByTestId(T.row("case"))).getByRole("rowheader");
    const text = cell.textContent ?? "";
    expect(text.indexOf("Case")).toBeLessThan(text.indexOf("012345678905"));
    expect(text.indexOf("012345678905")).toBeLessThan(text.indexOf("Priced by the family."));
  });

  it("the phone cards are unchanged: the barcode is still its own labelled line", () => {
    render(<ProductPricesGrid product={product} />);
    const card = within(screen.getByTestId(T.card("case")));
    expect(card.getAllByTestId(T.code("case"))).toHaveLength(1);
    expect(card.getByText(/^Barcode:/)).toBeTruthy();
  });
});

describe("K11-10: Contains and the price boxes are narrower", () => {
  it("Contains has a minimum width, each line stays on its own line, the second line is quiet", () => {
    render(<ProductPricesGrid product={product} />);
    const contains = within(screen.getByTestId(T.row("case")))
      .getByText("40 Boxes")
      .closest("td")!;
    expect(contains.className).toMatch(/min-w-\[7rem\]/);
    const lines = Array.from(contains.children) as HTMLElement[];
    expect(lines.map((l) => l.textContent)).toEqual(["40 Boxes", "= 960 Pieces in all"]);
    lines.forEach((l) => expect(l.className).toMatch(/\bwhitespace-nowrap\b/));
    expect(lines[1].className).toMatch(/\btext-xs\b/);
    expect(lines[1].className).toMatch(/\btext-navy\/60\b/);
  });

  it("the table has no 720 px minimum, and the edit boxes are 5.5rem wide", () => {
    render(<ProductPricesGrid product={product} edit={editApi()} />);
    const table = screen.getByTestId(T.unitsTable).querySelector("table")!;
    expect(table.className).not.toMatch(/min-w-\[720px\]/);
    const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
    expect(input.className).toMatch(/w-\[5\.5rem\]/);
    expect(input.className).not.toMatch(/\bw-24\b/);
  });
});

describe("K11-10: the grid says what is clipped", () => {
  it("observes the five tier headers with the scroll region as root", () => {
    render(<ProductPricesGrid product={product} />);
    expect(io).not.toBeNull();
    expect(io!.opts?.root).toBe(screen.getByTestId(T.unitsTable));
    expect(heads().map((h) => h.textContent)).toEqual([
      "Retail",
      "Wholesale",
      "Distributor",
      "Tier 4",
      "Tier 5",
    ]);
  });

  it("no cue and no visible fade while nothing is clipped", () => {
    render(<ProductPricesGrid product={product} />);
    clip();
    expect(screen.queryByTestId(T.scrollCue)).toBeNull();
    expect(screen.getByTestId(T.scrollFade).className).toMatch(/\bopacity-0\b/);
  });

  it("names exactly the tiers that are clipped, with the tenant's own names", () => {
    mockLabels = { "2": "Wholesale", "3": "Distributor", "4": "Club" };
    render(<ProductPricesGrid product={product} />);
    clip(4, 5);
    const cue = screen.getByTestId(T.scrollCue);
    expect(cue.textContent).toBe("Scroll for Club and Tier 5");
    expect(cue.getAttribute("aria-live")).toBeNull();
    expect(cue.getAttribute("role")).toBeNull();
    expect(screen.getByTestId(T.scrollFade).className).toMatch(/\bopacity-100\b/);
    clip(5);
    expect(screen.getByTestId(T.scrollCue).textContent).toBe("Scroll for Tier 5");
    clip(3, 4, 5);
    expect(screen.getByTestId(T.scrollCue).textContent).toBe(
      "Scroll for Distributor, Club and Tier 5",
    );
  });

  it("the cue goes away once scrolled to the end (every header is back inside)", () => {
    render(<ProductPricesGrid product={product} />);
    clip(4, 5);
    expect(screen.getByTestId(T.scrollCue)).toBeTruthy();
    clip();
    expect(screen.queryByTestId(T.scrollCue)).toBeNull();
  });

  it("a tier scrolled out on the left is not named", () => {
    render(<ProductPricesGrid product={product} />);
    report(
      heads().map((h, i) => ({
        target: h,
        ratio: i === 0 ? 0.2 : 1,
        right: i === 0 ? 40 : 500,
        rootRight: 900,
      })),
    );
    expect(screen.queryByTestId(T.scrollCue)).toBeNull();
  });

  it("the fade is decorative, ignores the pointer and does not animate under reduced motion", () => {
    render(<ProductPricesGrid product={product} />);
    const fade = screen.getByTestId(T.scrollFade);
    expect(fade.getAttribute("aria-hidden")).toBe("true");
    expect(fade.className).toMatch(/\bpointer-events-none\b/);
    expect(fade.className).toMatch(/\bmotion-reduce:transition-none\b/);
    expect(fade.className).toMatch(/\bw-6\b/);
    expect(fade.className).toMatch(/\bbg-gradient-to-r\b/);
  });

  it("without IntersectionObserver the grid still renders and shows no cue", () => {
    delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    render(<ProductPricesGrid product={product} />);
    expect(screen.getByTestId(T.grid)).toBeTruthy();
    expect(screen.queryByTestId(T.scrollCue)).toBeNull();
  });
});
