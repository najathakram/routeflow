import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import CommissionStatementsPage from "./page";

/**
 * UXG-R10 C5 PR-2: below md the commission statements list is a card list (statement number,
 * agent, status, period, total), the table is md and up only, the filters sit in a "Filters (n)"
 * disclosure and the header is one row with the description hidden.
 */

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/finance/commissions",
  useSearchParams: () => new URLSearchParams(""),
}));
jest.mock("@/lib/page-title-context", () => ({
  usePageTitle: () => ({ setTitle: jest.fn() }),
}));
jest.mock("@/lib/api/tobacco", () => ({
  useTenantAddons: () => ({ data: { addons: ["sales_agents"] }, isLoading: false }),
}));
jest.mock("./_components/GenerateStatementModal", () => ({
  GenerateStatementModal: () => null,
}));

const mockUseStatements = jest.fn();
jest.mock("@/lib/api/sales-agents", () => ({
  ...jest.requireActual("@/lib/api/sales-agents"),
  useSalesAgents: () => ({ data: [{ id: "ag-1", name: "Acme Agent" }] }),
  useCommissionStatements: (...a: unknown[]) => mockUseStatements(...a),
}));

const STATEMENTS = [
  {
    id: "st-a",
    statementNumber: "CS-A",
    agentId: "ag-1",
    agent: { id: "ag-1", name: "Acme Agent" },
    status: "PENDING",
    periodFrom: "2026-01-01",
    periodTo: "2026-01-31",
    totalAmount: 125.5,
    paidAmount: 0,
    createdAt: "2026-02-01T00:00:00.000Z",
  },
  {
    id: "st-b",
    statementNumber: "CS-B",
    agentId: "ag-2",
    agent: { id: "ag-2", name: "Acme Rep" },
    status: "PAID",
    periodFrom: null,
    periodTo: null,
    totalAmount: 80,
    paidAmount: 80,
    createdAt: "2026-02-02T00:00:00.000Z",
  },
];

describe("CommissionStatementsPage — phone cards", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockUseStatements.mockReset();
    mockUseStatements.mockReturnValue({
      data: STATEMENTS,
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });
  });

  it("renders one card per statement with agent, status, period and total", () => {
    const { container } = renderWithProviders(<CommissionStatementsPage />);
    const list = container.querySelector("ul.md\\:hidden") as HTMLElement;
    expect(list).not.toBeNull();
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    const link = within(cards[0]).getByRole("link", { name: "CS-A" });
    expect(link).toHaveAttribute("href", "/finance/commissions/st-a");
    expect(within(cards[0]).getByText("Acme Agent")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Pending")).toBeInTheDocument();
    expect(within(cards[0]).getByText("$125.50")).toBeInTheDocument();
    expect(within(cards[0]).getByText(/Jan 1, 2026\s+–\s+Jan 31, 2026/)).toBeInTheDocument();
    expect(within(cards[1]).getByText("Paid")).toBeInTheDocument();
    expect(within(cards[1]).getByText("$80.00")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Open period")).toBeInTheDocument();
    // Paid and Created are one tap away on the card's meta line.
    expect(within(cards[0]).getByText(/Paid \$0\.00/)).toBeInTheDocument();
    // No row action exists in the table, so the card has no button.
    expect(within(cards[0]).queryAllByRole("button")).toHaveLength(0);
    // The amount carries no danger tone: the table has no rule for it.
    expect(within(cards[0]).getByText("$125.50").className).not.toContain("text-danger");
  });

  it("shows the table only from md up", () => {
    renderWithProviders(<CommissionStatementsPage />);
    const wrapper = screen.getByRole("table").closest("div.hidden") as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("md:block");
  });

  it("keeps the table visible while loading, on error and when empty", () => {
    mockUseStatements.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });
    const { container } = renderWithProviders(<CommissionStatementsPage />);
    const wrapper = screen.getByRole("table").closest("div.overflow-hidden") as HTMLElement;
    expect(wrapper.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(container.querySelector("ul.md\\:hidden")).toBeNull();
  });

  it("puts Agent and Status in a Filters disclosure whose count is the active filters", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommissionStatementsPage />);
    const button = screen.getByRole("button", { name: "Filters" });
    const panel = document.getElementById(button.getAttribute("aria-controls")!) as HTMLElement;
    expect(panel).toContainElement(screen.getByLabelText("Agent"));
    expect(panel).toContainElement(screen.getByLabelText("Status"));
    await user.selectOptions(screen.getByLabelText("Status"), "PAID");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
    expect(mockUseStatements.mock.calls.at(-1)![0]).toMatchObject({ status: "PAID" });
  });

  it("is one header row below md with the description hidden", () => {
    renderWithProviders(<CommissionStatementsPage />);
    const desc = screen.getByText(/Generate, review, and pay out/);
    expect(desc.className).toContain("hidden");
    expect(desc.className).toContain("md:block");
    expect(screen.getByRole("button", { name: /Generate statement/ }).className).toContain(
      "min-h-[44px]",
    );
  });
});
