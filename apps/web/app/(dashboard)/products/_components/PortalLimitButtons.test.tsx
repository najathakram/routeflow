import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { PortalLimitButtons } from "./PortalVisibilityControls";

/** The bulk bar's "Limit in portal…" and "Select all in category" (state portal limits spec §1, C a). */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));
let mockRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: mockRole } }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

beforeEach(() => {
  mockRole = "TENANT_ADMIN";
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/product-categories")
      return {
        data: [
          { id: "c1", name: "Vapes", productCount: 38, archivedAt: null },
          { id: "c2", name: "Old", productCount: 2, archivedAt: "2026-01-01" },
        ],
      };
    return { data: { enabled: false } };
  });
});

const sel = (n: number) => new Set(Array.from({ length: n }, (_, i) => `p${i}`));

describe("PortalLimitButtons", () => {
  it("opens the dialog titled with the selected count", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PortalLimitButtons selected={sel(12)} onDone={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Limit in portal…" }));
    expect(screen.getByText("Limit 12 products in your portal")).toBeInTheDocument();
  });

  it("Select all in category opens the category chooser (non-archived labels with counts)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PortalLimitButtons selected={sel(3)} onDone={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Select all in category" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Limit a whole category in your portal")).toBeInTheDocument();
    const select = await within(dialog).findByLabelText(/which category/i);
    await within(dialog).findByRole("option", { name: "Vapes (38)" });
    expect(within(dialog).queryByRole("option", { name: /old/i })).toBeNull();
    await user.selectOptions(select, "c1");
    expect(within(dialog).getByText("Limit “Vapes” in your portal")).toBeInTheDocument();
  });

  it("over 200 rows offers a whole category instead", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PortalLimitButtons selected={sel(201)} onDone={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Limit in portal…" }));
    expect(
      screen.getByText("Select up to 200 products, or limit a whole category instead."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Vapes (38)" })).toBeInTheDocument();
  });

  it("is hidden from roles that cannot limit", () => {
    mockRole = "DRIVER";
    renderWithProviders(<PortalLimitButtons selected={sel(2)} onDone={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Limit in portal…" })).toBeNull();
  });
});
