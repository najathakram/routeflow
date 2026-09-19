import * as React from "react";
import { render, screen } from "@testing-library/react";
import { splitProductName } from "@/lib/product-display";
import { LineItemRowReadOnly, type LineItemRowReadOnlyProps } from "./LineItemRowReadOnly";

/**
 * order-ui-redesign-spec §3 / §11.2 fixtures for the read-only row. JSDOM has no layout, so the
 * "bounded height" and "no overlap" claims are pinned as class contracts here and proven in
 * pixels by the Lane F Playwright pass once step 9 mounts the row on the order-detail page.
 */

const base: LineItemRowReadOnlyProps = {
  displayName: "Sample Pod - Strawberry Banana - 5ct",
  sku: "100200300",
  unitPrice: 65,
  qty: 8,
};

function renderRow(over: Partial<LineItemRowReadOnlyProps> = {}) {
  return render(
    <ul>
      <LineItemRowReadOnly {...base} {...over} />
    </ul>,
  );
}

describe("splitProductName", () => {
  it("splits at the FIRST separator: family stem, flavor + pack anchor", () => {
    expect(splitProductName("Sample Pod - Strawberry Banana - 5ct")).toEqual({
      stem: "Sample Pod",
      anchor: "Strawberry Banana - 5ct",
    });
  });

  it("a name with no separator has no stem", () => {
    expect(splitProductName("Sample Chips 1oz")).toEqual({
      stem: null,
      anchor: "Sample Chips 1oz",
    });
  });

  it("does not split on a bare hyphen, or when either side would be empty", () => {
    expect(splitProductName("Cola-12pk").stem).toBeNull();
    expect(splitProductName(" - Leading")).toEqual({ stem: null, anchor: " - Leading" });
    expect(splitProductName("Trailing - ")).toEqual({ stem: null, anchor: "Trailing - " });
  });
});

describe("LineItemRowReadOnly — name anatomy (the two reported screenshots)", () => {
  it("two names that differ only in their tail stay distinguishable: the anchor is never clamped", () => {
    const a = renderRow({ displayName: "Sample Pod - Strawberry Banana - 5ct" });
    const anchorA = screen.getByTestId("line-name-anchor");
    expect(anchorA).toHaveTextContent("Strawberry Banana - 5ct");
    expect(anchorA.className).not.toMatch(/line-clamp/);
    a.unmount();

    renderRow({ displayName: "Sample Pod - Strawberry B-Burst - 5ct" });
    const anchorB = screen.getByTestId("line-name-anchor");
    expect(anchorB).toHaveTextContent("Strawberry B-Burst - 5ct");
    expect(anchorB.className).not.toMatch(/line-clamp/);
  });

  it("a very long family stem is clamped to 2 lines (bounded row), the anchor still shows in full", () => {
    const family = "SAMPLE DIAMOND INFUSED PREROLL 1.25GM ".repeat(8).trim();
    renderRow({ displayName: `${family} - Berry Blast Sativa - 20CT` });
    expect(screen.getByTestId("line-name-stem")).toHaveClass("line-clamp-2");
    expect(screen.getByTestId("line-name-anchor")).toHaveTextContent("Berry Blast Sativa - 20CT");
  });

  it("a flat name with no separator falls back to a plain 3-line clamp", () => {
    renderRow({ displayName: "Sample Chips 1oz ".repeat(30).trim() });
    expect(screen.queryByTestId("line-name-stem")).toBeNull();
    expect(screen.getByTestId("line-name-anchor")).toHaveClass("line-clamp-3");
  });
});

describe("LineItemRowReadOnly — qty, price, total", () => {
  it("non-boxed: '8 × $65.00' and the plain total", () => {
    renderRow();
    expect(screen.getByText("8 × $65.00")).toBeInTheDocument();
    expect(screen.getByText("$520.00")).toBeInTheDocument();
  });

  it("boxed: split qty + per-box price, and a total prorated per box (never qty × price)", () => {
    renderRow({ unitPrice: 30, unitsPerBox: 12, boxes: 2, pieces: 3, qty: 27 });
    expect(screen.getByText("2 boxes + 3 pcs · $30.00 / box of 12")).toBeInTheDocument();
    // 2 boxes + 3/12 of a box at $30/box = 67.50 — qty × price would over-charge to $810.
    expect(screen.getByText("$67.50")).toBeInTheDocument();
    expect(screen.queryByText("$810.00")).toBeNull();
  });
});

describe("LineItemRowReadOnly — SKU, thumbnail, status, delivery, note", () => {
  it("shows the SKU line, and omits it when there is none", () => {
    const r = renderRow();
    expect(screen.getByText("SKU 100200300")).toBeInTheDocument();
    r.unmount();
    renderRow({ sku: null });
    expect(screen.queryByText(/^SKU /)).toBeNull();
  });

  it("thumbnail: an image when present, an icon tile in the same 40x40 box when missing", () => {
    const withImg = renderRow({ thumbnailUrl: "https://files.test/p.jpg" });
    const img = withImg.container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://files.test/p.jpg");
    const box = img.parentElement!;
    expect(box).toHaveClass("h-10", "w-10");
    withImg.unmount();

    const without = renderRow({ thumbnailUrl: null });
    expect(without.container.querySelector("img")).toBeNull();
    const svg = without.container.querySelector("svg")!;
    expect(svg.parentElement).toHaveClass("h-10", "w-10");
  });

  it("renders the caller-derived status as text, not colour alone", () => {
    renderRow({ lineStatus: "PARTIAL" });
    expect(screen.getByText("Partial")).toBeInTheDocument();
  });

  it("'N of M delivered' only for a line that is short-picked", () => {
    const r = renderRow({ deliveredQty: 6, qty: 8 });
    expect(screen.getByText("6 of 8 delivered")).toBeInTheDocument();
    r.unmount();
    const full = renderRow({ deliveredQty: 8, qty: 8 });
    expect(full.container.textContent).not.toMatch(/delivered/);
    full.unmount();
    const none = renderRow({ deliveredQty: null });
    expect(none.container.textContent).not.toMatch(/delivered/);
  });

  it("shows the per-line note", () => {
    renderRow({ note: "  leave at dock  " });
    expect(screen.getByText("leave at dock")).toBeInTheDocument();
  });
});

describe("LineItemRowReadOnly — nothing editable, no cost data", () => {
  it("renders no controls and no margin/cost hint", () => {
    const { container } = renderRow({
      unitPrice: 30,
      unitsPerBox: 12,
      boxes: 1,
      pieces: 0,
      qty: 12,
    });
    expect(container.querySelector("button, input, select, textarea")).toBeNull();
    expect(container.textContent).not.toMatch(/margin|cost|floor|sell anyway/i);
  });
});
