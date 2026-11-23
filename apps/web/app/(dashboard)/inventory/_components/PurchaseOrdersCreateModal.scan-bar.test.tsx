/**
 * P1 (SA-1207 spec 21): the "scan or type to add items" bar on Create purchase order, the labelled
 * Boxes / Extra pieces fields, the full-name sort of the product select, and the guards around them
 * (Enter never submits from a line field, the catalog fails closed, a costless line is refused).
 */
import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreatePOModal } from "./PurchaseOrdersCreateModal";
import { unitWords } from "@routeflow/pricing";

const UW = unitWords();

jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: mockToast }) };
});
const mockToast = jest.fn();
const mockCreate = jest.fn();
jest.mock("@/lib/api/inventory", () => ({
  useCreatePurchaseOrder: () => ({ mutate: mockCreate, isPending: false }),
}));

// The whole-catalog read (parent info for the full-name sort); the bar's own search answers nothing.
const mockCatalogRows = [
  { id: "fam", name: "Acme Vape", kind: "FAMILY", unitsPerBox: null, variants: [] },
  { id: "v1", name: "Mint", kind: "VARIANT", parentProductId: "fam", unitsPerBox: 10 },
];
let mockCatalogState: "ready" | "loading" | "error" = "ready";
const mockRefetch = jest.fn();
let mockCatalogFetching = false;
const mockUseProducts = jest.fn();
jest.mock("@/lib/api/products", () => ({
  useProducts: (params: { limit?: number }) => mockUseProducts(params),
}));
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: (...a: unknown[]) => mockResolve(...a),
}));

const suppliers = [{ id: "s1", name: "Acme Supply", isActive: true }];
const products = [
  { id: "z", name: "Zed Gadget", sku: "Z-1", unitsPerBox: 12 },
  { id: "fam", name: "Acme Vape", unitsPerBox: null },
  { id: "v1", name: "Mint", unitsPerBox: 10 },
  { id: "w", name: "Widget", sku: "W-1", unitsPerBox: null },
];
const hit = (product: object) => ({ product, source: "barcode" as const });
const zed = { id: "z", name: "Zed Gadget", unitsPerBox: 12, barcode: "111" };
const widget = { id: "w", name: "Widget", unitsPerBox: null, barcode: "222" };

const BOXES = `${UW.pack.other}, line 1`;
const PIECES = `Extra ${UW.base.lowerOther}, line 1`;
const COST_BOX = `Cost per ${UW.pack.lower}`;
const COST_PIECE = `Cost per ${UW.base.lower}`;
const selects = () => document.querySelectorAll("select");
const bar = () => screen.getByLabelText("Scan or type to add items");
const scan = (code: string) => {
  fireEvent.change(bar(), { target: { value: code } });
  fireEvent.keyDown(bar(), { key: "Enter" });
};
const optionLabels = () =>
  within(selects()[1] as HTMLElement)
    .getAllByRole("option")
    .map((o) => o.textContent);

beforeEach(() => {
  jest.clearAllMocks();
  mockCatalogState = "ready";
  mockCatalogFetching = false;
  mockUseProducts.mockImplementation((params: { limit?: number }) => {
    if (params?.limit !== 0) return { data: { data: [] }, isFetching: false };
    if (mockCatalogState === "loading")
      return { data: undefined, isLoading: true, isFetching: true };
    if (mockCatalogState === "error")
      return {
        data: undefined,
        isError: true,
        isFetching: mockCatalogFetching,
        refetch: mockRefetch,
      };
    return { data: { data: mockCatalogRows }, isFetching: false };
  });
});
const open = () =>
  render(<CreatePOModal suppliers={suppliers} products={products} onClose={jest.fn()} />);

describe("product select", () => {
  it("sorts by FULL name, shows a variant as '<Family> - <Variant>' and never lists a family", () => {
    open();
    expect(optionLabels()).toEqual([
      "Select…",
      "Acme Vape - Mint",
      "Widget (W-1)",
      "Zed Gadget (Z-1)",
    ]);
  });

  it.each([
    ["loading", "Loading products…"],
    ["error", "Couldn't load products."],
  ] as const)(
    "fails closed while the catalog is %s: no bare variant names, no family, the bar is off",
    (state, hint) => {
      mockCatalogState = state;
      open();
      expect(optionLabels()).toEqual(["Select…"]);
      expect(bar()).toBeDisabled();
      expect(screen.getByText(hint)).toBeInTheDocument();
    },
  );

  it("W-1319: a failed catalog read shows Try again; one click reads again and the options appear", () => {
    mockCatalogState = "error";
    const view = open();
    expect(screen.queryByText(/Reopen this window/)).not.toBeInTheDocument();
    mockRefetch.mockImplementation(() => {
      mockCatalogState = "ready";
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    view.rerender(<CreatePOModal suppliers={suppliers} products={products} onClose={jest.fn()} />);
    expect(bar()).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(optionLabels()).toContain("Widget (W-1)");
  });

  it("W-1319: while a retry is reading (error and fetching) it says Loading and offers no Try again", () => {
    mockCatalogState = "error";
    mockCatalogFetching = true;
    open();
    expect(screen.getByText("Loading products…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(bar()).toBeDisabled();
  });

  it("W-1319: no Try again while the catalog is loading", () => {
    mockCatalogState = "loading";
    open();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});

describe("line fields", () => {
  it("labels Boxes, Extra pieces and Remove with the row number, with a readable width", () => {
    open();
    fireEvent.change(selects()[1], { target: { value: "z" } });
    const boxes = screen.getByLabelText(BOXES);
    expect(boxes).toHaveAttribute("name", "boxes-0");
    expect(boxes.className).toContain("min-w-[3.5rem]");
    expect(screen.getByLabelText(PIECES)).toHaveAttribute("name", "pieces-0");
    expect(screen.getByRole("button", { name: "Remove line 1" })).toBeInTheDocument();
  });
});

describe("scan or type to add items", () => {
  it("adds a boxed product as one box and a repeat scan adds one more box", async () => {
    open();
    mockResolve.mockResolvedValue(hit(zed));
    scan("111");
    await waitFor(() => expect(screen.getByLabelText(BOXES)).toHaveValue(1));
    scan("111");
    await waitFor(() => expect(screen.getByLabelText(BOXES)).toHaveValue(2));
    expect(selects()).toHaveLength(2); // supplier + ONE product line
    expect(selects()[1]).toHaveValue("z");
  });

  it("adds a per-piece product as quantity 1, then 2", async () => {
    open();
    mockResolve.mockResolvedValue(hit(widget));
    scan("222");
    await waitFor(() => expect(screen.getByLabelText("Quantity, line 1")).toHaveValue(1));
    scan("222");
    await waitFor(() => expect(screen.getByLabelText("Quantity, line 1")).toHaveValue(2));
  });

  it("never adds a family, keeps the text and says what to do", async () => {
    open();
    mockResolve.mockResolvedValue(hit({ id: "fam", name: "Acme Vape", kind: "FAMILY" }));
    scan("333");
    expect(await screen.findByText("Pick a flavour: Acme Vape has variants")).toBeInTheDocument();
    expect(selects()[1]).toHaveValue("");
    expect(bar()).toHaveValue("333");
  });
});

describe("Enter never submits the order", () => {
  it("from the scan bar", async () => {
    const user = userEvent.setup();
    open();
    mockResolve.mockResolvedValue(hit(zed));
    await user.type(bar(), "111{Enter}");
    await screen.findByLabelText(BOXES);
    expect(mockCreate).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["Boxes", "z", BOXES, COST_BOX],
    ["Extra pieces", "z", PIECES, COST_BOX],
    ["Cost", "z", COST_BOX, COST_BOX],
    ["Quantity", "w", "Quantity, line 1", COST_PIECE],
  ])("from the %s field", async (_name, id, label, costLabel) => {
    const user = userEvent.setup();
    open();
    mockResolve.mockResolvedValue(hit(id === "z" ? zed : widget));
    await user.type(bar(), `${id === "z" ? "111" : "222"}{Enter}`);
    await user.type(await screen.findByLabelText(costLabel), "5");
    await user.type(screen.getByLabelText(label), "{Enter}");
    expect(mockCreate).toHaveBeenCalledTimes(0);
  });
});

describe("a scanned line with no cost", () => {
  it("refuses the submit and names the line, instead of dropping it", async () => {
    const user = userEvent.setup();
    open();
    mockResolve.mockResolvedValueOnce(hit(zed)).mockResolvedValueOnce(hit(widget));
    await user.type(bar(), "111{Enter}");
    await screen.findByLabelText(BOXES);
    await user.type(bar(), "222{Enter}");
    await user.type(await screen.findByLabelText(COST_PIECE), "5");
    await user.click(screen.getByRole("button", { name: "Create PO" }));
    expect(mockCreate).toHaveBeenCalledTimes(0);
    expect(screen.getByText("Add a cost for line 1")).toBeInTheDocument();
  });
});

describe("the code's level decides what a scan adds (SA-1218)", () => {
  // box-only code B111 (sku), unit-only code U111 (unitSku), both-levels code 111 (legacy barcode).
  const zedCodes = { ...zed, barcode: "111", sku: "B111", unitSku: "U111" };
  const pieces = () => screen.getByLabelText(PIECES);
  const boxes = () => screen.getByLabelText(BOXES);

  it("a UNIT code on a 12-per-box product adds one Extra piece, not a box; a repeat adds another", async () => {
    open();
    mockResolve.mockResolvedValue(hit(zedCodes));
    scan("U111");
    await waitFor(() => expect(pieces()).toHaveValue(1));
    expect(boxes()).toHaveValue(0);
    scan("U111");
    await waitFor(() => expect(pieces()).toHaveValue(2));
  });

  it("a BOX code adds a box, and BOX then UNIT gives 1 box + 1 piece", async () => {
    open();
    mockResolve.mockResolvedValue(hit(zedCodes));
    scan("B111");
    await waitFor(() => expect(boxes()).toHaveValue(1));
    scan("U111");
    await waitFor(() => expect(pieces()).toHaveValue(1));
    expect(boxes()).toHaveValue(1);
  });

  it("12 UNIT scans roll into one box (normalizeBoxesPieces), 0 pieces", async () => {
    open();
    mockResolve.mockResolvedValue(hit(zedCodes));
    for (let n = 1; n <= 12; n++) {
      scan("U111");
      await waitFor(() => expect(pieces()).toHaveValue(n % 12));
    }
    expect(boxes()).toHaveValue(1);
  });

  it("a code at both levels takes the default (a box)", async () => {
    open();
    mockResolve.mockResolvedValue(hit(zedCodes));
    scan("111");
    await waitFor(() => expect(boxes()).toHaveValue(1));
    expect(pieces()).toHaveValue(null);
  });
});
