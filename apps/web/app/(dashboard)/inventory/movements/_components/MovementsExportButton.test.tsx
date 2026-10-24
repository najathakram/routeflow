import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MovementsExportButton } from "./MovementsExportButton";

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

const FILTERS = { productId: "p1", type: "PURCHASE", from: "2026-09-01", to: "2026-09-29" };
const blob = new Blob(["a,b\r\n1,2\r\n"], { type: "text/csv" });
const btn = () => screen.queryByTestId("movements-export-button");

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "OPERATOR";
  get.mockResolvedValue({ data: blob, headers: {} });
});

describe("MovementsExportButton (CSV-3)", () => {
  it.each([
    ["OPERATOR", true],
    ["TENANT_ADMIN", true],
    ["DRIVER", false],
  ])("role %s -> shown: %s", (role, shown) => {
    mockRole = role;
    render(<MovementsExportButton total={5} filters={FILTERS} />);
    expect(!!btn()).toBe(shown);
  });

  it("empty result: disabled with a tooltip, and a click sends nothing", () => {
    render(<MovementsExportButton total={0} filters={FILTERS} />);
    expect(btn()).toBeDisabled();
    expect(btn()).toHaveAttribute("title", "Nothing to export — no movements match these filters");
    fireEvent.click(btn()!);
    expect(get).not.toHaveBeenCalled();
  });

  it("while the list is still loading it is disabled (total is not a real count yet)", () => {
    render(<MovementsExportButton total={0} loading filters={FILTERS} />);
    expect(btn()).toBeDisabled();
    expect(btn()).not.toHaveAttribute(
      "title",
      "Nothing to export — no movements match these filters",
    );
  });

  it("success: GET with ONLY the filters (no paging), downloads the blob, no toast", async () => {
    render(<MovementsExportButton total={12} filters={FILTERS} />);
    fireEvent.click(btn()!);
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("/inventory/movements/export.csv", {
      params: { productId: "p1", type: "PURCHASE", from: "2026-09-01", to: "2026-09-29" },
      responseType: "blob",
    });
    expect(downloadCsvBlob.mock.calls[0][0]).toMatch(
      /^inventory-movements-2026-09-01-to-2026-09-29\.csv$/,
    );
    expect(downloadCsvBlob.mock.calls[0][1]).toBe(blob);
    expect(toast).not.toHaveBeenCalled();
  });

  it("blank filters are not sent", async () => {
    render(
      <MovementsExportButton total={3} filters={{ productId: "", type: "", from: "", to: "" }} />,
    );
    fireEvent.click(btn()!);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls[0][1].params).toEqual({
      productId: undefined,
      type: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it("failure: the fixed toast, never the server text; nothing downloaded", async () => {
    get.mockRejectedValue({
      response: { status: 500, data: new Blob([JSON.stringify({ message: "SQL exploded" })]) },
    });
    render(<MovementsExportButton total={3} filters={FILTERS} />);
    fireEvent.click(btn()!);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: "Export failed, please try again",
        variant: "error",
      }),
    );
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/SQL exploded/);
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });

  it("a file the server ended early ('# export failed' / '# truncated') still downloads but warns", async () => {
    get.mockResolvedValue({
      data: new Blob(["a,b\r\n1,2\r\n# truncated at 50000 rows\r\n"], { type: "text/csv" }),
      headers: {},
    });
    render(<MovementsExportButton total={60000} filters={FILTERS} />);
    fireEvent.click(btn()!);
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalled());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "warning" })),
    );
  });

  it("busy lock: a second click while in flight sends nothing new", async () => {
    let resolve!: (v: unknown) => void;
    get.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<MovementsExportButton total={3} filters={FILTERS} />);
    fireEvent.click(btn()!);
    await waitFor(() => expect(btn()).toBeDisabled());
    fireEvent.click(btn()!);
    expect(get).toHaveBeenCalledTimes(1);
    resolve({ data: blob, headers: {} });
    await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalled());
  });
});
