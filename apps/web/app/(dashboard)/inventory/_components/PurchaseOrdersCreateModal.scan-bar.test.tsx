/**
 * P1 (SA-1207 spec 21): the "scan or type to add items" bar on Create purchase order, the labelled
 * Boxes / Extra pieces fields, and the full-name sort of the product select.
 */
import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
jest.mock("@/lib/api/products", () => ({
  useProducts: (params: { limit?: number }) => ({
    data: { data: params?.limit === 0 ? mockCatalogRows : [] },
    isFetching: false,
  }),
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

const bar = () => screen.getByLabelText("Scan or type to add items");
const scan = (code: string) => {
  fireEvent.change(bar(), { target: { value: code } });
  fireEvent.keyDown(bar(), { key: "Enter" });
};

beforeEach(() => {
  jest.clearAllMocks();
  render(<CreatePOModal suppliers={suppliers} products={products} onClose={jest.fn()} />);
});

describe("product select", () => {
  it("sorts by FULL name, shows a variant as '<Family> - <Variant>' and never lists a family", () => {
    const select = document.querySelectorAll("select")[1] as HTMLElement;
    const labels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels).toEqual(["Select…", "Acme Vape - Mint", "Widget (W-1)", "Zed Gadget (Z-1)"]);
  });
});

describe("boxed line fields", () => {
  it("labels Boxes and Extra pieces, with a readable width", () => {
    fireEvent.change(document.querySelectorAll("select")[1], { target: { value: "z" } });
    const boxes = screen.getByLabelText(UW.pack.other);
    expect(boxes).toHaveAttribute("name", "boxes-0");
    expect(boxes.className).toContain("min-w-[3.5rem]");
    expect(screen.getByLabelText(`Extra ${UW.base.lowerOther}`)).toHaveAttribute(
      "name",
      "pieces-0",
    );
  });
});

describe("scan or type to add items", () => {
  it("adds a boxed product as one box and a repeat scan adds one more box", async () => {
    mockResolve.mockResolvedValue(hit(zed));
    scan("111");
    await waitFor(() => expect(screen.getByLabelText(UW.pack.other)).toHaveValue(1));
    scan("111");
    await waitFor(() => expect(screen.getByLabelText(UW.pack.other)).toHaveValue(2));
    expect(document.querySelectorAll("select")).toHaveLength(2); // supplier + ONE product line
    expect(document.querySelectorAll("select")[1]).toHaveValue("z");
  });

  it("adds a per-piece product as quantity 1, then 2", async () => {
    mockResolve.mockResolvedValue(hit(widget));
    scan("222");
    await waitFor(() => expect(screen.getByLabelText("Quantity")).toHaveValue(1));
    scan("222");
    await waitFor(() => expect(screen.getByLabelText("Quantity")).toHaveValue(2));
  });

  it("keeps Enter from submitting the order", async () => {
    mockResolve.mockResolvedValue(hit(zed));
    scan("111");
    await waitFor(() => expect(screen.getByLabelText(UW.pack.other)).toBeInTheDocument());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("never adds a family", async () => {
    mockResolve.mockResolvedValue(hit({ id: "fam", name: "Acme Vape", kind: "FAMILY" }));
    scan("333");
    await waitFor(() => expect(mockResolve).toHaveBeenCalled());
    expect(document.querySelectorAll("select")[1]).toHaveValue("");
  });
});
