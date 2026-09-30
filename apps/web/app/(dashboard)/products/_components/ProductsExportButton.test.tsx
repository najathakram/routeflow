import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProductsExportButton } from "./ProductsExportButton";

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { role: mockRole } }),
}));

const get = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

const downloadCsvBlob = jest.fn();
jest.mock("@/lib/export", () => ({
  ...jest.requireActual("@/lib/export"),
  downloadCsvBlob: (...a: unknown[]) => downloadCsvBlob(...a),
}));

const FILTERS = { search: "cola", category: "Drinks", stockStatus: "LOW" as const, section: "s1" };

function renderBtn(total = 42) {
  return render(<ProductsExportButton total={total} filters={FILTERS} />);
}
function open() {
  fireEvent.click(screen.getByTestId("products-export-button"));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "OPERATOR";
  jest.useFakeTimers().setSystemTime(new Date("2026-09-29T12:00:00Z"));
});
afterEach(() => jest.useRealTimers());

describe("ProductsExportButton", () => {
  it.each(["DRIVER", "CUSTOMER"])("is hidden for %s", (role) => {
    mockRole = role;
    renderBtn();
    expect(screen.queryByTestId("products-export-button")).toBeNull();
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])("is shown for %s with the count in the label", (role) => {
    mockRole = role;
    renderBtn(42);
    expect(screen.getByTestId("products-export-button")).toHaveTextContent(
      "Export CSV (42 products)",
    );
  });

  it("uses the singular for one product", () => {
    renderBtn(1);
    expect(screen.getByTestId("products-export-button")).toHaveTextContent(
      "Export CSV (1 product)",
    );
  });

  it("opens a popover defaulting to the last 30 days, presets change the range", () => {
    renderBtn();
    expect(screen.queryByTestId("products-export-popover")).toBeNull();
    open();
    expect(screen.getByTestId("products-export-popover")).toBeInTheDocument();
    expect(screen.getByTestId("products-export-from")).toHaveValue("2026-08-30");
    expect(screen.getByTestId("products-export-to")).toHaveValue("2026-09-29");
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(screen.getByTestId("products-export-from")).toHaveValue("2026-09-22");
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    expect(screen.getByTestId("products-export-from")).toHaveValue("2026-07-01");
  });

  it("with nothing to export: toasts, sends no request and downloads no file", async () => {
    renderBtn(0);
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Nothing to export" })),
    );
    expect(get).not.toHaveBeenCalled();
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });

  it("requests /products/export.csv with the current filters and the period, then downloads", async () => {
    const blob = new Blob(["a,b"]);
    get.mockResolvedValue({ data: blob });
    renderBtn();
    open();
    fireEvent.change(screen.getByTestId("products-export-from"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("/products/export.csv", {
      params: {
        search: "cola",
        category: "Drinks",
        stockStatus: "LOW",
        section: "s1",
        from: "2026-09-01",
        to: "2026-09-29",
      },
      responseType: "blob",
    });
    expect(downloadCsvBlob).toHaveBeenCalledWith("products-2026-09-01-to-2026-09-29.csv", blob);
  });

  it("is disabled and reads Exporting… while the request runs", async () => {
    let resolve!: (v: unknown) => void;
    get.mockReturnValue(new Promise((r) => (resolve = r)));
    renderBtn();
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() => expect(screen.getByTestId("products-export-download")).toBeDisabled());
    expect(screen.getByTestId("products-export-download")).toHaveTextContent("Exporting…");
    expect(screen.getByTestId("products-export-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("products-export-download"));
    expect(get).toHaveBeenCalledTimes(1);
    resolve({ data: new Blob(["x"]) });
    await waitFor(() => expect(screen.getByTestId("products-export-button")).not.toBeDisabled());
  });

  it("toasts Export failed with the message on an error", async () => {
    get.mockRejectedValue({
      message: "boom",
      response: { status: 500, data: { message: "db down" } },
    });
    renderBtn();
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Export failed",
          description: "db down",
          variant: "error",
        }),
      ),
    );
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });

  it("gives a friendly try-again-in-a-minute on a 429", async () => {
    get.mockRejectedValue({ response: { status: 429 } });
    renderBtn();
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Export failed",
          description: expect.stringMatching(/try again in a minute/i),
        }),
      ),
    );
  });
});
