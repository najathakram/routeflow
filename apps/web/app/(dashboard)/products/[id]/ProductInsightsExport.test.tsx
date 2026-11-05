import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProductInsightsExport } from "./ProductInsightsExport";

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { role: mockRole } }),
}));

let mockFlag = { enabled: true, resolved: true, failed: false };
jest.mock("@/lib/api/plan-flags", () => ({ usePlanFlag: () => mockFlag }));

// SA-1087: the export also renders "Full insights" (FullInsightsLink), which asks which groups the
// signed-in operator may use. This file stubs that answer; the link's own gating is pinned in
// FullInsightsLink.test.tsx.
let mockDenied: string[] = [];
jest.mock("@/lib/api/my-permissions", () => ({ useDeniedGroups: () => mockDenied }));

const get = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

const downloadCsvBlob = jest.fn();
jest.mock("@/lib/export", () => ({
  ...jest.requireActual("@/lib/export"),
  downloadCsvBlob: (...a: unknown[]) => downloadCsvBlob(...a),
}));

let mockSales: { data?: { summary: { count: number } }; isLoading: boolean } = {
  data: { summary: { count: 4 } },
  isLoading: false,
};
jest.mock("@/lib/api/product-sales", () => ({ useProductSales: () => mockSales }));

const click = () => fireEvent.click(screen.getByTestId("product-insights-export-button"));

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "OPERATOR";
  mockDenied = [];
  mockFlag = { enabled: true, resolved: true, failed: false };
  mockSales = { data: { summary: { count: 4 } }, isLoading: false };
});

describe("ProductInsightsExport", () => {
  it("SA-1087: carries the Full insights link, unless the insights page asks it not to", () => {
    const { unmount } = render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.getByRole("link", { name: "Full insights" })).toHaveAttribute(
      "href",
      "/insights/products/p1",
    );
    unmount();
    render(<ProductInsightsExport productId="p1" sku="SKU-1" hideFullLink />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("product-insights-export-button")).toBeInTheDocument();
  });

  it.each(["DRIVER", "CUSTOMER"])("is hidden for %s", (role) => {
    mockRole = role;
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.queryByTestId("product-insights-export-button")).toBeNull();
  });

  it("SA-1087 PR-2: opens on the period it is seeded with, and follows a new period", () => {
    const { rerender } = render(
      <ProductInsightsExport
        productId="p1"
        sku="SKU-1"
        seedFrom="2025-10-01"
        seedTo="2026-09-26"
      />,
    );
    const from = screen.getByTestId("product-insights-export-from") as HTMLInputElement;
    const to = screen.getByTestId("product-insights-export-to") as HTMLInputElement;
    expect([from.value, to.value]).toEqual(["2025-10-01", "2026-09-26"]);
    // The boxes stay editable ...
    fireEvent.change(from, { target: { value: "2026-01-01" } });
    expect(from.value).toBe("2026-01-01");
    // ... and picking another period on the panel reseeds them.
    rerender(
      <ProductInsightsExport
        productId="p1"
        sku="SKU-1"
        seedFrom="2026-06-26"
        seedTo="2026-09-26"
      />,
    );
    expect([from.value, to.value]).toEqual(["2026-06-26", "2026-09-26"]);
  });

  it("SA-1087 PR-2: a seeded period is what the download asks for", async () => {
    get.mockResolvedValue({ data: new Blob(["a"]), headers: {} });
    render(
      <ProductInsightsExport
        productId="p1"
        sku="SKU-1"
        seedFrom="2025-10-01"
        seedTo="2026-09-26"
      />,
    );
    click();
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/analytics/products/p1/insights.csv",
        expect.objectContaining({ params: { from: "2025-10-01", to: "2026-09-26" } }),
      ),
    );
  });

  it("is hidden when the plan lacks flag.analytics", () => {
    mockFlag = { enabled: false, resolved: true, failed: false };
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.queryByTestId("product-insights-export-button")).toBeNull();
  });

  it("is hidden while the flag is still unresolved (no flash)", () => {
    mockFlag = { enabled: true, resolved: false, failed: false };
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.queryByTestId("product-insights-export-button")).toBeNull();
  });

  it("SA-1087: fails open when the plan read failed: the export and the Full insights link both show", () => {
    mockFlag = { enabled: false, resolved: false, failed: true };
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.getByTestId("product-insights-export-button")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Full insights" })).toBeInTheDocument();
  });

  it("J10: is hidden when the product has never sold, and while sales are loading", () => {
    mockSales = { data: { summary: { count: 0 } }, isLoading: false };
    const { unmount } = render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.queryByTestId("product-insights-export")).toBeNull();
    unmount();
    mockSales = { data: undefined, isLoading: true };
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.queryByTestId("product-insights-export")).toBeNull();
  });

  it("J10: stays available when the sales lookup failed (no data, not loading)", () => {
    mockSales = { data: undefined, isLoading: false };
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.getByTestId("product-insights-export-button")).toBeInTheDocument();
  });

  it("is shown for TENANT_ADMIN when the flag is on", () => {
    mockRole = "TENANT_ADMIN";
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    expect(screen.getByTestId("product-insights-export-button")).toHaveTextContent(
      "Download product sales CSV",
    );
  });

  it("with no dates: requests insights.csv without from/to and names the file from Content-Disposition", async () => {
    const blob = new Blob(["x"]);
    get.mockResolvedValue({
      data: blob,
      headers: { "content-disposition": 'attachment; filename="acme-cola-2026.csv"' },
    });
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    click();
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("/analytics/products/p1/insights.csv", {
      params: { from: undefined, to: undefined },
      responseType: "blob",
    });
    expect(downloadCsvBlob).toHaveBeenCalledWith("acme-cola-2026.csv", blob);
  });

  it("with dates and no Content-Disposition: falls back to csvFilename(product-sales-<sku>)", async () => {
    const blob = new Blob(["x"]);
    get.mockResolvedValue({ data: blob, headers: {} });
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    fireEvent.change(screen.getByTestId("product-insights-export-from"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByTestId("product-insights-export-to"), {
      target: { value: "2026-08-31" },
    });
    click();
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("/analytics/products/p1/insights.csv", {
      params: { from: "2026-08-01", to: "2026-08-31" },
      responseType: "blob",
    });
    expect(downloadCsvBlob).toHaveBeenCalledWith(
      "product-sales-SKU-1-2026-08-01-to-2026-08-31.csv",
      blob,
    );
  });

  it("is disabled while exporting", async () => {
    let resolve!: (v: unknown) => void;
    get.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    click();
    await waitFor(() =>
      expect(screen.getByTestId("product-insights-export-button")).toBeDisabled(),
    );
    expect(screen.getByTestId("product-insights-export-button")).toHaveTextContent("Exporting…");
    resolve({ data: new Blob(["x"]), headers: {} });
    await waitFor(() =>
      expect(screen.getByTestId("product-insights-export-button")).not.toBeDisabled(),
    );
  });

  it("toasts on error and on 429", async () => {
    get.mockRejectedValueOnce({ message: "boom" });
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    click();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Export failed", description: "boom" }),
      ),
    );
    get.mockRejectedValueOnce({ response: { status: 429 } });
    click();
    await waitFor(() =>
      expect(toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ description: expect.stringMatching(/try again in a minute/i) }),
      ),
    );
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });

  it("surfaces the server message from a Blob error body", async () => {
    get.mockRejectedValueOnce({
      message: "Request failed with status code 403",
      response: {
        status: 403,
        data: new Blob([JSON.stringify({ message: "Plan does not include analytics" })]),
      },
    });
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    click();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Plan does not include analytics" }),
      ),
    );
  });

  it("warns when the file ends with the export-failed line", async () => {
    get.mockResolvedValue({
      data: new Blob(["a\r\n\r\n# export failed: the file is incomplete\r\n"]),
      headers: {},
    });
    render(<ProductInsightsExport productId="p1" sku="SKU-1" />);
    click();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Export may be incomplete", variant: "warning" }),
      ),
    );
    expect(downloadCsvBlob).toHaveBeenCalledTimes(1);
  });
});
