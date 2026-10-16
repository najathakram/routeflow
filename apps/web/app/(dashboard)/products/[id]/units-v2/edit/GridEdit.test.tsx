import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { EDIT_TESTIDS as E } from "./edit-testids";

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockFlag = true;
const mockSave = jest.fn();
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => mockGrid }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => mockFlag }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("./contract-stubs", () => ({
  ...jest.requireActual("./contract-stubs"),
  useSavePriceGrid: () => ({ mutate: mockSave, isPending: false }),
}));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));

const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "piece",
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 960,
      kind: "pack",
      code: "012345678905",
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "box",
      label: "Box",
      factor: 24,
      kind: "unit",
      code: null,
      cells: cells([24.5, 22, 21, 20, 19]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set", "auto", "auto", "auto", "auto"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };
const caseRow = () => within(screen.getByTestId(T.row("case")));
const enterEdit = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(caseRow().getByRole("button", { name: "Edit Wholesale Case price, $13.91" }));

beforeEach(() => {
  mockFlag = true;
  mockSave.mockReset();
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("units v2 edit grid (S12a)", () => {
  it("V08: clicking a price enters edit mode focused on that cell's input, without scrolling", async () => {
    const focus = jest.spyOn(HTMLElement.prototype, "focus");
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    const input = caseRow().getByTestId(E.input("case", 2)) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("13.91");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it("V08: Edit and Change prices sit in the section actions; Change prices opens K4's panel", async () => {
    const onOpen = jest.fn();
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} onOpenChangePrices={onOpen} />);
    await user.click(screen.getByTestId(E.changeOpen));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId(E.editOpen));
    expect(screen.getByRole("region", { name: "Unsaved changes" })).toBeTruthy();
    expect(screen.queryByTestId(E.editOpen)).toBeNull();
    expect(screen.getByTestId(E.changeOpen)).toBeTruthy();
  });

  it("V04: Ctrl+S saves once while editing and stops the browser save; idle it does nothing", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    expect(fireEvent.keyDown(document, { key: "s", ctrlKey: true })).toBe(true);
    expect(mockSave).not.toHaveBeenCalled();
    await enterEdit(user);
    const input = caseRow().getByTestId(E.input("case", 2));
    await user.clear(input);
    await user.type(input, "14.5");
    expect(fireEvent.keyDown(input, { key: "s", ctrlKey: true })).toBe(false);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        productId: "p1",
        patches: [{ ref: "case", tier: 2, to: 14.5 }],
        orderUnit: null,
      }),
    );
  });

  it("V04: a skip link jumps to Save, and the bar says Ctrl+S saves", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    expect(screen.queryByRole("link", { name: "Skip to Save" })).toBeNull();
    await enterEdit(user);
    await user.click(screen.getByRole("link", { name: "Skip to Save" }));
    expect(document.activeElement).toBe(screen.getByTestId(E.save));
    expect(screen.getByRole("region", { name: "Unsaved changes" }).textContent).toMatch(
      /(Ctrl|⌘)\+?S saves/,
    );
  });

  it("V14: exactly one save bar, Cancel then Save, in the DOM", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    expect(screen.getAllByRole("region", { name: "Unsaved changes" })).toHaveLength(1);
    expect(screen.getAllByTestId(E.saveBar)).toHaveLength(1);
    const names = within(screen.getByTestId(E.saveBar))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["Cancel", "Save"]);
  });

  it("V06: an order-unit switch is a draft with an inline review; Save is the one commit", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    await user.selectOptions(screen.getByTestId(E.orderUnit), "case");
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getByTestId(E.switchReview).textContent).toContain("Orders now use the Case.");
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
    await user.click(screen.getByTestId(E.save));
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0]).toEqual(expect.objectContaining({ orderUnit: "case" }));
  });

  it("V06: Undo switch removes the draft switch", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    await user.selectOptions(screen.getByTestId(E.orderUnit), "case");
    await user.click(screen.getByTestId(E.switchUndo));
    expect(screen.queryByTestId(E.switchReview)).toBeNull();
    expect((screen.getByTestId(E.orderUnit) as HTMLSelectElement).value).toBe("piece");
  });

  it("a refused price (zero) is explained by the pricing package and blocks Save", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    const input = caseRow().getByTestId(E.input("case", 2));
    await user.clear(input);
    await user.type(input, "0");
    expect(screen.getByTestId(E.problems).textContent?.length).toBeGreaterThan(0);
    expect((screen.getByTestId(E.save) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an edited cell hands its consequences to the also-update slot only", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    expect(screen.queryByTestId(E.alsoSlot)).toBeNull();
    const input = caseRow().getByTestId(E.input("case", 2));
    await user.clear(input);
    await user.type(input, "14.5");
    expect(screen.getByTestId(E.alsoSlot)).toBeTruthy();
  });

  it("Cancel discards the draft and returns to view mode without saving", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    await user.click(screen.getByTestId(E.cancel));
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    expect(
      caseRow().getByRole("button", { name: "Edit Wholesale Case price, $13.91" }),
    ).toBeTruthy();
  });

  it("flag off renders today's read-only grid: no buttons, inputs, save bar or skip link", () => {
    mockFlag = false;
    render(<ProductPricingV2 product={product} />);
    const g = screen.getByTestId(T.grid);
    expect(g.querySelectorAll("input, button, select, textarea").length).toBe(0);
    expect(caseRow().getByTestId(T.cell("case", 2)).getAttribute("aria-label")).toBe(
      "Wholesale Case price, $13.91",
    );
    expect(screen.queryByTestId(E.editOpen)).toBeNull();
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  it("no money math in the edit folder: no rounding or toFixed", () => {
    for (const f of fs.readdirSync(__dirname)) {
      if (!/\.tsx?$/.test(f) || /\.test\./.test(f)) continue;
      expect(fs.readFileSync(path.join(__dirname, f), "utf8")).not.toMatch(
        /Math\.(round|floor|ceil)|toFixed/,
      );
    }
  });
});
