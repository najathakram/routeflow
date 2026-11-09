import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import FinanceReportsPage from "./page";

/**
 * B476. The "All reports" catalog was a fixed 288px column that never collapsed, so at 390px the
 * report viewer got 102px. Below md the catalog is now collapsed behind an "All reports" button
 * (aria-expanded / aria-controls) that shows the active report's name; choosing a report closes it.
 * From md up the list is always visible.
 *
 * Collapse approach: the list stays in the DOM and is hidden with CSS (`hidden` when closed,
 * always `md:block`). jsdom has no stylesheet, so the contract is pinned on the class tokens of
 * the panel the button controls, not on visibility. The measured result lives in the phone-width
 * live check.
 */
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("report=sales-by-customer"),
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/finance/reports",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: true, loading: false }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: [] }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

async function renderCatalog() {
  renderWithProviders(<FinanceReportsPage />);
  const toggle = await screen.findByRole("button", { name: /^All reports/ });
  const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  if (!panel) throw new Error("the All reports button controls no element");
  return { toggle, panel };
}

describe("Reports catalog at phone width (B476)", () => {
  beforeEach(() => mockPush.mockClear());

  it("starts collapsed behind an All reports button that names the active report", async () => {
    const { toggle, panel } = await renderCatalog();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Sales by customer");
    expect(panel.classList.contains("hidden")).toBe(true);
    // from md up the list is always visible, no behaviour change
    expect(panel.classList.contains("md:block")).toBe(true);
    expect(within(panel).getByRole("button", { name: "Sales by Item" })).toBeInTheDocument();
  });

  it("the layout is a column below md and a row from md", async () => {
    const { panel } = await renderCatalog();
    const root = panel.parentElement?.parentElement as HTMLElement;
    expect(root.classList.contains("flex-col")).toBe(true);
    expect(root.classList.contains("md:flex-row")).toBe(true);
  });

  it("the button opens the list and picking a report closes it again", async () => {
    const user = userEvent.setup();
    const { toggle, panel } = await renderCatalog();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel.classList.contains("hidden")).toBe(false);

    await user.click(within(panel).getByRole("button", { name: "Sales by Item" }));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("report=sales-by-item"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel.classList.contains("hidden")).toBe(true);
  });
});
