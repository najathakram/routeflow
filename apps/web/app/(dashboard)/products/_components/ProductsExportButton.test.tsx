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
    expect(screen.getByTestId("products-export-from")).toHaveValue("2026-08-31");
    expect(screen.getByTestId("products-export-to")).toHaveValue("2026-09-29");
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(screen.getByTestId("products-export-from")).toHaveValue("2026-09-23");
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    expect(screen.getByTestId("products-export-from")).toHaveValue("2026-07-02");
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

  it("the Hidden-from-portal filter is forwarded, so the file matches the filtered count shown (N1)", async () => {
    render(<ProductsExportButton total={3} filters={{ portalVisible: false }} />);
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0][1].params).toMatchObject({ portalVisible: false });
  });

  it("no portal filter -> portalVisible is not sent at all", async () => {
    renderBtn();
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0][1].params.portalVisible).toBeUndefined();
  });

  it("the Inactive filter exports isActive=false (the same set the list shows)", async () => {
    render(<ProductsExportButton total={3} filters={{ isActive: false }} />);
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0][1].params).toMatchObject({ isActive: false });
    expect(get.mock.calls[0][1].params.stockStatus).toBeUndefined();
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

  it("surfaces the server message from a Blob error body, never the raw status line", async () => {
    get.mockRejectedValue({
      message: "Request failed with status code 400",
      response: {
        status: 400,
        data: new Blob([JSON.stringify({ message: "from must be on or before to" })]),
      },
    });
    renderBtn();
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "from must be on or before to" }),
      ),
    );
  });

  it("is disabled until the product list has loaded", () => {
    render(<ProductsExportButton total={0} loading filters={FILTERS} />);
    expect(screen.getByTestId("products-export-button")).toBeDisabled();
  });

  it.each([["# export failed: the file is incomplete\r\n"], ["# truncated at 50000 rows\r\n"]])(
    "still downloads but warns when the file ends with %j",
    async (tail) => {
      const blob = new Blob(["Name\r\nA\r\n" + tail]);
      get.mockResolvedValue({ data: blob });
      renderBtn();
      open();
      fireEvent.click(screen.getByTestId("products-export-download"));
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Export may be incomplete", variant: "warning" }),
        ),
      );
      expect(downloadCsvBlob).toHaveBeenCalledTimes(1);
    },
  );

  it("does not warn on a complete file", async () => {
    get.mockResolvedValue({ data: new Blob(["Name\r\nA\r\n"]) });
    renderBtn();
    open();
    fireEvent.click(screen.getByTestId("products-export-download"));
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledTimes(1));
    expect(toast).not.toHaveBeenCalled();
  });
  // jsdom cannot measure layout, so pin the viewport-bounding classes; the 390px bounding-box
  // check lives in e2e/63-csv-export.spec.ts.
  it("bounds the popover to the viewport (left-anchored on phones, right-aligned from sm)", () => {
    renderBtn();
    open();
    const cls = screen.getByTestId("products-export-popover").className;
    expect(cls).toContain("w-[min(20rem,calc(100vw-2rem))]");
    expect(cls).toContain("left-0");
    expect(cls).toContain("sm:left-auto");
    expect(cls).toContain("sm:right-0");
    expect(cls).not.toMatch(/(^|\s)right-0(\s|$)/);
    expect(cls).not.toMatch(/(^|\s)w-72(\s|$)/);
  });
});
