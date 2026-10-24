import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

// B1188 owner UI rule: never lose or hide a feature. Pins EVERY control of the Settings >
// Invoicing tab around "Invoice Numbering" (the card and the controls sharing its save handler),
// and proves "Save Defaults" no longer sends the dropped invoicePrefix / paymentDueDays fields.

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "op", role: "TENANT_ADMIN" } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=invoicing"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

let serverTerms = "Net 30";
const mockGet = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
    put: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/import/numbering")
      return Promise.resolve({
        data: [
          {
            docType: "INVOICE",
            prefix: "INV-",
            nextNumber: 7,
            padding: 4,
            preview: "INV-0007",
            configured: true,
          },
        ],
      });
    if (url === "/settings/invoice")
      return Promise.resolve({ data: { defaultTerms: serverTerms, hideOriginalPrice: false } });
    if (url === "/settings")
      return Promise.resolve({ data: { invoiceNotes: "thanks", invoiceTerms: "terms" } });
    return Promise.resolve({ data: {} });
  });
  serverTerms = "Net 30";
  mockPatch.mockImplementation((url: string, body: { defaultTerms?: string }) => {
    if (url === "/settings/invoice" && body.defaultTerms) serverTerms = body.defaultTerms;
    return Promise.resolve({ data: {} });
  });
});

describe("Settings > Invoicing: control inventory (B1188)", () => {
  it("keeps every control of the numbering section and its neighbours", async () => {
    renderWithProviders(<SettingsPage />);
    // The numbering card
    expect(await screen.findByText("Invoice Numbering")).toBeInTheDocument();
    expect(screen.getByText("Invoice Number Prefix")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("INV-")).toBeInTheDocument();
    expect(screen.getByText("Payment Due Days")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save numbering/i })).toBeInTheDocument();
    // Neighbours that share the page's save handler / the same terms store
    expect(screen.getByText("Payment Terms")).toBeInTheDocument();
    expect(screen.getByLabelText(/show original price on discounted lines/i)).toBeInTheDocument();
    expect(screen.getByText("Customer Notes")).toBeInTheDocument();
    expect(screen.getByText("Terms & Conditions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save defaults/i })).toBeInTheDocument();
  });

  it("Save Defaults sends only notes + terms to /settings (no dropped fields)", async () => {
    renderWithProviders(<SettingsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /save defaults/i }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/settings", expect.anything()));
    const body = mockPatch.mock.calls.find((c) => c[0] === "/settings")![1];
    expect(body).toEqual({ invoiceNotes: "thanks", invoiceTerms: "terms" });
    expect(body).not.toHaveProperty("invoicePrefix");
    expect(body).not.toHaveProperty("paymentDueDays");
  });

  it("Payment Terms and Payment Due Days are ONE value: either change shows in both at once", async () => {
    renderWithProviders(<SettingsPage />);
    const days = (await screen.findByLabelText(/payment due days/i)) as HTMLSelectElement;
    const terms = (await screen.findByLabelText("Payment Terms")) as HTMLSelectElement;
    await waitFor(() => expect(days.value).toBe("Net 30"));

    await userEvent.selectOptions(days, "Net 45");
    expect(terms.value).toBe("Net 45");
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/settings/invoice", { defaultTerms: "Net 45" }),
    );

    await userEvent.selectOptions(terms, "Net 15");
    expect(days.value).toBe("Net 15");
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/settings/invoice", { defaultTerms: "Net 15" }),
    );
    expect(mockPatch.mock.calls.filter((c) => c[0] === "/settings")).toHaveLength(0);
  });
});
