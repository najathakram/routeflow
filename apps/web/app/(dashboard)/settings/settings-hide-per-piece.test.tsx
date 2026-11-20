import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

// Owner ruling 2026-11-04: Settings > Invoicing has a "Show price per piece on invoices" checkbox. It is checked by default
// (the server's `hidePerPiece: false`, so today's invoices are unchanged) and a change sends `{ hidePerPiece: !checked }`.

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
          hideBarcodes: false,
          hidePerPiece: serverHide,
          depositDefaultPercent: null,
        },
      });
    return Promise.resolve({ data: url === "/import/numbering" ? [] : {} });
  });
  mockPatch.mockResolvedValue({ data: {} });
});

const perPieceBox = async () =>
  (await screen.findByRole("checkbox", {
    name: "Show price per piece on invoices",
  })) as HTMLInputElement;
const perPiecePatches = () =>
  mockPatch.mock.calls.filter((c) => c[0] === "/settings/invoice" && "hidePerPiece" in c[1]);

describe("Settings > Invoicing: Show price per piece on invoices", () => {
  it("is checked when the business never turned it off, and unticking sends hidePerPiece: true", async () => {
    serverHide = false;
    renderWithProviders(<SettingsPage />);
    const box = await perPieceBox();
    await waitFor(() => expect(box.checked).toBe(true));
    await userEvent.click(box);
    await waitFor(() => expect(perPiecePatches()).toHaveLength(1));
    expect(perPiecePatches()[0][1]).toEqual({ hidePerPiece: true });
  });

  it("is unchecked when the column is off, and ticking sends hidePerPiece: false", async () => {
    serverHide = true;
    renderWithProviders(<SettingsPage />);
    const box = await perPieceBox();
    await waitFor(() => expect(box.checked).toBe(false));
    await userEvent.click(box);
    await waitFor(() => expect(perPiecePatches()).toHaveLength(1));
    expect(perPiecePatches()[0][1]).toEqual({ hidePerPiece: false });
  });

  it("says what it prints", async () => {
    serverHide = false;
    renderWithProviders(<SettingsPage />);
    await perPieceBox();
    expect(
      screen.getByText(
        "Adds a Per piece column beside pack lines, on the invoice page, the PDF, the email and reminders. Turn off to print invoices without it.",
      ),
    ).toBeInTheDocument();
  });
});
