import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

// Row 652: clearing the tenant default deposit sends 0, never null (the API no longer accepts null
// on this money field, so it is off the money-dto-null allow-list).

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "op", role: "TENANT_ADMIN" } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=invoicing"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

let serverPercent: number | null = 30;
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
          depositDefaultPercent: serverPercent,
        },
      });
    return Promise.resolve({ data: url === "/import/numbering" ? [] : {} });
  });
  mockPatch.mockResolvedValue({ data: {} });
});

const depositField = async () => (await screen.findByPlaceholderText("—")) as HTMLInputElement;
const depositPatches = () =>
  mockPatch.mock.calls.filter(
    (c) => c[0] === "/settings/invoice" && "depositDefaultPercent" in c[1],
  );

describe("Settings > Invoicing: default deposit (652)", () => {
  it("clearing a saved percent sends 0, not null", async () => {
    serverPercent = 30;
    renderWithProviders(<SettingsPage />);
    const field = await depositField();
    await waitFor(() => expect(field.value).toBe("30"));
    await userEvent.clear(field);
    await userEvent.tab();
    await waitFor(() => expect(depositPatches()).toHaveLength(1));
    expect(depositPatches()[0][1]).toEqual({ depositDefaultPercent: 0 });
  });

  it("an unset default left blank is not re-saved", async () => {
    serverPercent = null;
    renderWithProviders(<SettingsPage />);
    const field = await depositField();
    await userEvent.click(field);
    await userEvent.tab();
    expect(depositPatches()).toHaveLength(0);
  });

  it("a saved 0 reads as blank and leaving it blank is not re-saved", async () => {
    serverPercent = 0;
    renderWithProviders(<SettingsPage />);
    const field = await depositField();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/settings/invoice"));
    expect(field.value).toBe("");
    await userEvent.click(field);
    await userEvent.tab();
    expect(depositPatches()).toHaveLength(0);
  });
});
