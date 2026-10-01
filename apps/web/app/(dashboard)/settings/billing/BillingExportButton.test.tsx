import * as React from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { BillingExportButton } from "./BillingExportButton";

const get = jest.fn();
const toast = jest.fn();
const downloadJsonFile = jest.fn();
let role: string | null = "TENANT_ADMIN";

jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
jest.mock("@/lib/auth-context", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ user: role ? { role } : null }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/json-export", () => ({
  ...jest.requireActual("@/lib/json-export"),
  downloadJsonFile: (...a: unknown[]) => downloadJsonFile(...a),
}));

const button = () => screen.queryByRole("button", { name: /Download billing data \(JSON\)/ });

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
});

describe("BillingExportButton", () => {
  it.each([
    ["OPERATOR", true],
    ["TENANT_ADMIN", true],
    ["DRIVER", false],
    ["CUSTOMER", false],
  ])("role %s -> shown: %s", (r, shown) => {
    role = r;
    renderWithProviders(<BillingExportButton />);
    expect(!!button()).toBe(shown);
  });

  it("no user -> no button", () => {
    role = null;
    renderWithProviders(<BillingExportButton />);
    expect(button()).toBeNull();
  });

  it("success: GET /billing/export, downloads the JSON under the header filename, no error toast", async () => {
    get.mockResolvedValue({
      data: { exportedAt: "2026-09-30T00:00:00Z", invoices: [] },
      headers: { "content-disposition": 'attachment; filename="acme-billing.json"' },
    });
    renderWithProviders(<BillingExportButton />);
    fireEvent.click(button()!);
    await waitFor(() => expect(downloadJsonFile).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("/billing/export");
    expect(downloadJsonFile).toHaveBeenCalledWith("acme-billing.json", {
      exportedAt: "2026-09-30T00:00:00Z",
      invoices: [],
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("no Content-Disposition -> a dated billing-….json fallback", async () => {
    get.mockResolvedValue({ data: {}, headers: {} });
    renderWithProviders(<BillingExportButton />);
    fireEvent.click(button()!);
    await waitFor(() => expect(downloadJsonFile).toHaveBeenCalled());
    expect(downloadJsonFile.mock.calls[0][0]).toMatch(/^billing-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("failure: the fixed toast, never the server text; nothing downloaded", async () => {
    get.mockRejectedValue({ response: { status: 500, data: { message: "SQL exploded" } } });
    renderWithProviders(<BillingExportButton />);
    fireEvent.click(button()!);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: "Export failed, please try again",
        variant: "error",
      }),
    );
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/SQL exploded/);
    expect(downloadJsonFile).not.toHaveBeenCalled();
  });

  it("busy lock: a second click while the request is in flight sends nothing new", async () => {
    let resolve!: (v: unknown) => void;
    get.mockReturnValue(new Promise((r) => (resolve = r)));
    renderWithProviders(<BillingExportButton />);
    fireEvent.click(button()!);
    const busy = await screen.findByRole("button", { name: /Exporting/ });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(get).toHaveBeenCalledTimes(1);
    resolve({ data: {}, headers: {} });
    await waitFor(() => expect(downloadJsonFile).toHaveBeenCalled());
  });
});
