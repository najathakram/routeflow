import * as React from "react";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { LineStockNote } from "@/components/LineStockNote";
import {
  savedPiecesByProduct,
  stockLineOfEditItem,
  useEditLineStock,
  type EditStockItem,
} from "./edit-line-stock";

/**
 * SA-1086 (LS-3, LS-7) on the order edit builder: the note counts only the INCREASE over the saved lines,
 * per product, and a line it cannot count honestly shows nothing.
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const item = (over: Partial<EditStockItem> = {}): EditStockItem => ({
  id: "l1",
  cancelled: false,
  productId: "p1",
  originalProductId: "p1",
  qty: 6,
  originalQty: 6,
  ...over,
});

describe("savedPiecesByProduct", () => {
  it("counts every saved line under its ORIGINAL product, a cancelled or substituted one included", () => {
    const saved = savedPiecesByProduct([
      item({ id: "a", originalQty: 6 }),
      item({ id: "b", originalQty: 4, cancelled: true }),
      item({ id: "c", productId: "p2", originalProductId: "p3", originalQty: 5 }),
    ]);
    expect(saved.get("p1")).toBe(10);
    expect(saved.get("p3")).toBe(5);
    expect(saved.has("p2")).toBe(false);
  });

  it("a line added on this screen, an unlisted line and a locked unit line hold nothing", () => {
    const saved = savedPiecesByProduct([
      item({ id: "n", isNew: true, originalQty: 0 }),
      item({ id: "u", isUnlisted: true }),
      item({ id: "k", countLocked: true }),
    ]);
    expect(saved.size).toBe(0);
  });

  it("a saved box-unaware line is boxes x its pack, a box-split line already holds pieces", () => {
    const saved = savedPiecesByProduct([
      item({ id: "a", originalQty: 2, originalUnitsPerBox: 12, originalBoxSplit: false }),
      item({
        id: "b",
        productId: "p2",
        originalProductId: "p2",
        originalQty: 30,
        originalUnitsPerBox: 12,
        originalBoxSplit: true,
      }),
    ]);
    expect(saved.get("p1")).toBe(24);
    expect(saved.get("p2")).toBe(30);
  });
});

describe("named-unit lines (read 2 hold 1)", () => {
  // A stored unit line: qty is the COUNT of the unit; unitsPerBox is that unit's factor.
  const caseLine = (over: Partial<EditStockItem> = {}) =>
    item({
      unitLabel: "Case",
      originalUnitLabel: "Case",
      unitsPerBox: 12,
      originalUnitsPerBox: 12,
      qty: 5,
      originalQty: 3,
      ...over,
    });

  it("a saved line of 3 Cases holds 36 pieces, and the line passes its factor", () => {
    expect(savedPiecesByProduct([caseLine()]).get("p1")).toBe(36);
    expect(stockLineOfEditItem(caseLine())).toMatchObject({ unitLabel: "Case", unitFactor: 12 });
  });

  it("a saved unit line with no known factor poisons its product (no honest count)", () => {
    const saved = savedPiecesByProduct([
      caseLine({ originalUnitsPerBox: null, unitsPerBox: null }),
    ]);
    expect(Number.isNaN(saved.get("p1"))).toBe(true);
  });

  it("saved 3 Cases raised to 5 with 5 pieces on hand is over by 24 pieces", async () => {
    mockGet.mockResolvedValue({
      data: { allowOversell: true, items: [{ productId: "p1", availablePieces: 5 }] },
    });
    renderWithProviders(<Probe items={[caseLine()]} />);
    await waitFor(() =>
      expect(screen.getByTestId("line-stock").getAttribute("data-level")).toBe("low"),
    );
    expect(screen.getByTestId("line-stock").textContent).toMatch(/5 pieces/);
  });
});

describe("a draft holds no stock (read 2 hold 2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({
      data: { allowOversell: false, items: [{ productId: "p1", availablePieces: 1 }] },
    });
  });

  function DraftProbe({ status }: { status?: string }) {
    const views = useEditLineStock([item({ qty: 6, originalQty: 6 })], status);
    return <LineStockNote stock={views.get("l1")} />;
  }

  it("a draft's saved 6, unchanged, with 1 on hand is over: publishing takes all 6", async () => {
    renderWithProviders(<DraftProbe status="DRAFT" />);
    await waitFor(() =>
      expect(screen.getByTestId("line-stock").getAttribute("data-level")).toBe("low"),
    );
    expect(screen.getByTestId("line-stock-message")).toBeInTheDocument();
  });

  it("the same line on a confirmed order is unchanged and asks for nothing", async () => {
    renderWithProviders(<DraftProbe status="CONFIRMED" />);
    await waitFor(() =>
      expect(screen.getByTestId("line-stock").getAttribute("data-level")).toBe("ok"),
    );
  });
});

describe("stockLineOfEditItem", () => {
  it("passes a box-split line as pieces and a named-unit line as its own unit", () => {
    expect(stockLineOfEditItem(item({ boxSplit: true, unitsPerBox: 12 }))).toMatchObject({
      boxes: 0,
      pieces: 0,
      unitsPerBox: 12,
    });
    expect(stockLineOfEditItem(item({ unitLabel: "Case" }))).toMatchObject({
      boxes: null,
      unitLabel: "Case",
    });
  });
});

function Probe({ items }: { items: EditStockItem[] }) {
  const views = useEditLineStock(items);
  return (
    <>
      {items.map((it) => (
        <div key={it.id} data-testid={`row-${it.id}`}>
          <LineStockNote stock={views.get(it.id)} />
        </div>
      ))}
    </>
  );
}

describe("useEditLineStock", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({
      data: { allowOversell: true, items: [{ productId: "p1", availablePieces: 1 }] },
    });
  });

  it("LS-3: saved 6 raised to 8 with 1 on hand is over by the increase of 2, and asks in edit mode", async () => {
    renderWithProviders(<Probe items={[item({ qty: 8 })]} />);
    await waitFor(() =>
      expect(screen.getByTestId("line-stock").getAttribute("data-level")).toBe("low"),
    );
    expect(screen.getByTestId("line-stock-message").textContent).toMatch(/backorder/i);
    expect(mockGet).toHaveBeenCalledWith(
      "/orders/stock-availability",
      expect.objectContaining({
        params: expect.objectContaining({ mode: "edit", productIds: "p1" }),
      }),
    );
  });

  it("an unchanged line asks for nothing more, however little is left", async () => {
    renderWithProviders(<Probe items={[item({ qty: 6 })]} />);
    await waitFor(() =>
      expect(screen.getByTestId("line-stock").getAttribute("data-level")).toBe("ok"),
    );
    expect(screen.queryByTestId("line-stock-message")).not.toBeInTheDocument();
  });

  it("a cancelled line, an unlisted line and a locked unit line show nothing and are not read", async () => {
    renderWithProviders(
      <Probe
        items={[
          item({ id: "x", cancelled: true }),
          item({ id: "y", isUnlisted: true, productId: "" }),
          item({ id: "z", countLocked: true }),
        ]}
      />,
    );
    expect(screen.queryByTestId("line-stock")).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("LS-7: a failed read shows nothing", async () => {
    mockGet.mockRejectedValue(new Error("boom"));
    renderWithProviders(<Probe items={[item({ qty: 8 })]} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("line-stock")).not.toBeInTheDocument());
  });
});
