import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, renderWithProviders } from "@/test-utils/render";
import { ProductFinder } from "./ProductFinder";

/**
 * #2119 (plan §A9): the finder — camera scan through the existing barcode
 * resolve ladder, or a typeahead on `GET /products?search=`, `limit=20`,
 * never `limit=0`. Both paths land on `/insights/products/[id]`.
 *
 * `BarcodeScannerButton` owns its own camera/decode state machine and has
 * its own test file (BarcodeScannerButton.test.tsx); it's mocked down to a
 * plain button here so these tests own ONLY ProductFinder's wiring —
 * which resolve-result branch (hit / archived / not-found / error) does
 * what — the same isolation BarcodeScannerButton's own suite relies on.
 */

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const useProductsSpy = jest.fn();
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: (...args: unknown[]) => useProductsSpy(...args),
}));

const resolveProductByCodeMock = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: (...args: unknown[]) => resolveProductByCodeMock(...args),
}));

let capturedOnScan: ((code: string) => void) | null = null;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: ({ onScan, title }: { onScan: (code: string) => void; title?: string }) => {
    capturedOnScan = onScan;
    return (
      <button type="button" title={title} onClick={() => onScan("TEST-CODE-123")}>
        scan
      </button>
    );
  },
}));

const RESULTS = [
  { id: "prod-1", name: "Sample Cola 12oz", sku: "COLA-12" },
  { id: "prod-2", name: "Sample Cola 24oz", sku: "COLA-24" },
];

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnScan = null;
  useProductsSpy.mockReturnValue({ data: { data: RESULTS }, isLoading: false });
});

describe("ProductFinder — typeahead", () => {
  it("queries GET /products?search= with limit=20, never limit=0", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<ProductFinder />);

    await user.type(screen.getByLabelText("Search products"), "cola");

    await waitFor(() =>
      expect(useProductsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ search: "cola", limit: 20 }),
        expect.objectContaining({ enabled: true }),
      ),
    );
    // Guard against a future edit silently widening the query to "fetch all".
    const allLimits = useProductsSpy.mock.calls.map(([params]) => params?.limit);
    expect(allLimits).not.toContain(0);
  });

  it("does not query while the search box is empty", () => {
    renderWithProviders(<ProductFinder />);
    expect(useProductsSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("selecting a result navigates to /insights/products/[id]", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<ProductFinder />);

    await user.type(screen.getByLabelText("Search products"), "cola");
    const row = await screen.findByRole("button", { name: /Sample Cola 12oz/i });
    await user.click(row);

    expect(pushMock).toHaveBeenCalledWith("/insights/products/prod-1");
  });

  it("shows a no-match message when the search finds nothing", async () => {
    useProductsSpy.mockReturnValue({ data: { data: [] }, isLoading: false });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<ProductFinder />);

    await user.type(screen.getByLabelText("Search products"), "zzzznotreal");
    expect(await screen.findByText(/no products match/i)).toBeInTheDocument();
  });
});

describe("ProductFinder — camera scan (barcode resolve ladder)", () => {
  it("a resolved hit navigates straight to /insights/products/[id]", async () => {
    resolveProductByCodeMock.mockResolvedValue({ product: { id: "prod-9" }, source: "barcode" });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<ProductFinder />);

    await user.click(screen.getByText("scan"));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/insights/products/prod-9"));
    expect(resolveProductByCodeMock).toHaveBeenCalledWith("TEST-CODE-123");
  });

  it("an archived hit still navigates (insights is a read surface) with a warning toast", async () => {
    resolveProductByCodeMock.mockResolvedValue({
      archived: true,
      product: { id: "prod-5", name: "Retired Widget", isActive: false },
      source: "barcode",
    });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<ProductFinder />);

    await user.click(screen.getByText("scan"));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/insights/products/prod-5"));
    expect(await screen.findByText(/archived/i)).toBeInTheDocument();
  });

  it("a not-found code shows a message and does not navigate", async () => {
    resolveProductByCodeMock.mockResolvedValue({ notFound: true });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<ProductFinder />);

    await user.click(screen.getByText("scan"));

    expect(await screen.findByText(/No product for "TEST-CODE-123"/)).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("a lookup failure shows an error toast and does not navigate", async () => {
    resolveProductByCodeMock.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<ProductFinder />);

    await user.click(screen.getByText("scan"));

    expect(await screen.findByText(/couldn't look up that code/i)).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
