import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

// SA-1031 W-R1: Settings > Invoicing has a "Show barcodes on invoices" checkbox under "Show original price on discounted
// lines". It is checked by default (the server's `hideBarcodes: false`) and a change sends `{ hideBarcodes: !checked }`.

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "op", role: "TENANT_ADMIN" } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=invoicing"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

let serverHide = false;
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
    if (url === "/settings/invoice")
      return Promise.resolve({
        data: {
          defaultTerms: "Net 30",
          hideOriginalPrice: false,
          hideBarcodes: serverHide,
          depositDefaultPercent: null,
        },
      });
    return Promise.resolve({ data: url === "/import/numbering" ? [] : {} });
  });
  mockPatch.mockResolvedValue({ data: {} });
});

const barcodeBox = async () =>
  (await screen.findByRole("checkbox", { name: "Show barcodes on invoices" })) as HTMLInputElement;
const barcodePatches = () =>
  mockPatch.mock.calls.filter((c) => c[0] === "/settings/invoice" && "hideBarcodes" in c[1]);

describe("Settings > Invoicing: Show barcodes on invoices (SA-1031 W-R1)", () => {
  it("is checked when the tenant has never turned barcodes off, and unticking sends hideBarcodes: true", async () => {
    serverHide = false;
    renderWithProviders(<SettingsPage />);
    const box = await barcodeBox();
    await waitFor(() => expect(box.checked).toBe(true));
    await userEvent.click(box);
    await waitFor(() => expect(barcodePatches()).toHaveLength(1));
    expect(barcodePatches()[0][1]).toEqual({ hideBarcodes: true });
  });

  it("is unchecked when barcodes are off, and ticking sends hideBarcodes: false", async () => {
    serverHide = true;
    renderWithProviders(<SettingsPage />);
    const box = await barcodeBox();
    await waitFor(() => expect(box.checked).toBe(false));
    await userEvent.click(box);
    await waitFor(() => expect(barcodePatches()).toHaveLength(1));
    expect(barcodePatches()[0][1]).toEqual({ hideBarcodes: false });
  });

  it("sits right under the original-price row, and says what it prints", async () => {
    serverHide = false;
    renderWithProviders(<SettingsPage />);
    const box = await barcodeBox();
    const original = screen.getByRole("checkbox", {
      name: "Show original price on discounted lines",
    });
    expect(original.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByText(
        "Prints each product's barcode and code on its line. Turn off to print invoices without them.",
      ),
    ).toBeInTheDocument();
  });
});
