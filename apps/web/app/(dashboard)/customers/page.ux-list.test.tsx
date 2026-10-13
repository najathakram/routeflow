import * as React from "react";
import { screen, within, renderWithProviders, fireEvent } from "@/test-utils/render";
import CustomersPage from "./page";

/**
 * PKG-1 (apple-ux F16/F17/F24/F26) — customers list UX. RTL cannot measure layout, so the
 * 390px proof is Playwright (e2e/65-customers-list-ux); here we pin the rendered classes,
 * links, text and the owner-rule "never lose a feature" checklist. Selection is by role /
 * data-testid (L-212), never by a responsive utility class.
 */

let mockRows: any[] = [];
let lastListParams: any = {};
const mockApprovals: any[] = [];
const push = jest.fn();
const clearUrlFilters = jest.fn();
const setUrlFilter = jest.fn();
const mergeMutate = jest.fn();
const restoreMutate = jest.fn();
let mockFilters: Record<string, unknown> = {
  status: "",
  regulated: false,
  unassigned: false,
  removed: false,
};

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "x", role: "TENANT_ADMIN" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/hooks/useUrlFilters", () => ({
  useUrlFilters: () => [mockFilters, setUrlFilter, clearUrlFilters],
}));

jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: (params: any) => {
    lastListParams = params;
    return {
      data: stableData(),
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
  },
  useCustomerTags: () => ({ data: [], isLoading: false, isError: false }),
  useUpdateCustomerStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteCustomer: () => ({ mutate: jest.fn(), isPending: false }),
  useBatchDeleteCustomers: () => ({ mutate: jest.fn(), isPending: false }),
  useExportCustomers: () => ({ mutate: jest.fn(), isPending: false }),
  useMergeCustomers: () => ({ mutate: mergeMutate, isPending: false }),
  useRestoreCustomer: () => ({ mutate: restoreMutate, isPending: false }),
}));

jest.mock("@/lib/api/portal-approvals", () => ({
  ...jest.requireActual("@/lib/api/portal-approvals"),
  usePendingPortalApprovals: () => ({ data: mockApprovals, isLoading: false, isError: false }),
  useApprovePortalRequest: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/routes", () => ({
  ...jest.requireActual("@/lib/api/routes"),
  useCustomerRouteAssignments: () => ({ data: [], isLoading: false, isError: false }),
}));

// A fresh object per render would trip the page's "reset selection on data change" effect.
let cachedRows: any[] | null = null;
let cachedData: any = null;
function stableData() {
  if (cachedRows !== mockRows) {
    cachedRows = mockRows;
    cachedData = {
      data: mockRows,
      meta: { total: mockRows.length, page: 1, limit: 20, totalPages: 1 },
    };
  }
  return cachedData;
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "cA",
  businessName: "Acme Market",
  contactName: "Ada Buyer",
  phone: "555-0100",
  email: "ada@acme.test",
  receivables: 1234.5,
  unusedCredits: 0,
  tagAssignments: [
    { tag: { id: "t1", name: "VIP", color: "#123456" } },
    { tag: { id: "t2", name: "Cash", color: "#654321" } },
    { tag: { id: "t3", name: "Dairy", color: "#111111" } },
  ],
  user: { id: "uA", email: "ada@acme.test", username: "ada", status: "ACTIVE" },
  addresses: [],
  ...over,
});

const A = () => row();
const B = () =>
  row({
    id: "cB",
    businessName: "Bo Deli",
    contactName: "Bo",
    receivables: 0,
    phone: undefined,
    tagAssignments: [],
  });
const C = () =>
  row({
    id: "cC",
    businessName: "Cy Cafe",
    contactName: "Cy",
    receivables: undefined,
    unusedCredits: 25,
  });

beforeEach(() => {
  mockRows = [A(), B(), C()];
  mockFilters = { status: "", regulated: false, unassigned: false, removed: false };
  jest.clearAllMocks();
});

describe("PKG-1 customers list — F17 name link", () => {
  it("C1: the name is a real link to the detail page (tab stop) and the row still navigates", () => {
    renderWithProviders(<CustomersPage />);
    const link = screen.getByRole("link", { name: "Ada Buyer" });
    expect(link).toHaveAttribute("href", "/customers/cA");
    // Clicking the link lets the link navigate; the row handler must NOT also push (no double nav).
    fireEvent.click(link);
    expect(push).not.toHaveBeenCalled();
    // Clicking elsewhere on the row still navigates.
    fireEvent.click(screen.getAllByRole("row")[1]);
    expect(push).toHaveBeenCalledWith("/customers/cA");
  });
});

describe("PKG-1 customers list — F16 money cells", () => {
  it("C4/C5: zero and missing receivables show $0.00; a balance is danger, zero is not", () => {
    renderWithProviders(<CustomersPage />);
    const cells = screen.getAllByTestId("receivables-cell");
    expect(cells.map((c) => c.textContent)).toEqual(["$1,234.50", "$0.00", "$0.00"]);
    expect(cells[0]).toHaveClass("text-danger");
    expect(cells[1]).not.toHaveClass("text-danger");
    expect(cells[2]).not.toHaveClass("text-danger");
  });

  it("Credits also shows $0.00 for zero (no dashes for zero money), success colour only when > 0", () => {
    renderWithProviders(<CustomersPage />);
    const cells = screen.getAllByTestId("credits-cell");
    expect(cells.map((c) => c.textContent)).toEqual(["$0.00", "$0.00", "$25.00"]);
    expect(cells[2]).toHaveClass("text-success");
    expect(cells[0]).not.toHaveClass("text-success");
  });
});

describe("PKG-1 customers list — F24 columns below sm (relocation, not removal)", () => {
  it("C7: Email, Phone, Credits, Tags hide below sm on th and td; Name, Business, Receivables, Status do not", () => {
    renderWithProviders(<CustomersPage />);
    for (const id of ["email-cell", "phone-cell", "credits-cell", "tags-cell"]) {
      const td = screen.getAllByTestId(id)[0].closest("td")!;
      expect(td).toHaveClass("hidden", "sm:table-cell");
    }
    for (const name of [/^email$/i, /^phone$/i, /^credits$/i, /^tags$/i]) {
      expect(screen.getByRole("columnheader", { name })).toHaveClass("hidden", "sm:table-cell");
    }
    for (const id of ["receivables-cell"]) {
      expect(screen.getAllByTestId(id)[0].closest("td")).not.toHaveClass("hidden");
    }
    expect(screen.getByRole("columnheader", { name: /receivables/i })).not.toHaveClass("hidden");
    expect(screen.getByRole("columnheader", { name: /business name/i })).not.toHaveClass("hidden");
    expect(screen.getByRole("columnheader", { name: /^status$/i })).not.toHaveClass("hidden");
  });

  it("the hidden phone + tags stay reachable on a phone via a sm:hidden secondary line in the Name cell", () => {
    renderWithProviders(<CustomersPage />);
    const lines = screen.getAllByTestId("name-secondary-line");
    expect(lines[0]).toHaveClass("sm:hidden");
    const nameWrap = screen.getAllByRole("link", { name: "Ada Buyer" })[0].parentElement!;
    expect(nameWrap.className).toMatch(/overflow-wrap:anywhere/);
    const tel = within(lines[0]).getByTestId("name-secondary-phone");
    expect(tel).toHaveAttribute("href", "tel:5550100");
    // tapping the phone must not open the row
    fireEvent.click(tel);
    expect(push).not.toHaveBeenCalled();
    const chips = within(lines[0]).getAllByTestId("name-secondary-tag");
    expect(chips.map((c) => c.textContent)).toEqual(["VIP", "Cash"]);
    expect(within(lines[0]).getByText("+1")).toBeInTheDocument();
    // row B has neither phone nor tags: no empty line at all
    expect(lines).toHaveLength(2);
  });
});

describe("PKG-1 customers list — F26 empty state", () => {
  it("C9: Clear search empties the input only; Clear filters is kept and calls clearUrlFilters once", () => {
    mockRows = [];
    renderWithProviders(<CustomersPage />);
    const input = screen.getByPlaceholderText(/name, business or phone/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzzz" } });
    const clearSearch = screen.getByRole("button", { name: /^clear search$/i });
    fireEvent.click(clearSearch);
    expect(input.value).toBe("");
    expect(clearUrlFilters).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "zzzz" } });
    fireEvent.click(screen.getByRole("button", { name: /^clear filters$/i }));
    expect(clearUrlFilters).toHaveBeenCalledTimes(1);
  });

  it("the empty text can wrap (no nowrap) so it fits a phone", () => {
    mockRows = [];
    renderWithProviders(<CustomersPage />);
    fireEvent.change(screen.getByPlaceholderText(/name, business or phone/i), {
      target: { value: "zzzz" },
    });
    const text = screen.getByText(/no customers match your current search and filters/i);
    expect(text.className).not.toMatch(/whitespace-nowrap/);
    expect(text).toHaveClass("break-words");
  });
});

describe("PKG-1 owner rule — nothing on the customers list is lost", () => {
  it("C2: every row action button keeps an accessible name and title", () => {
    renderWithProviders(<CustomersPage />);
    const body = screen.getAllByRole("rowgroup")[1];
    const names = new Set([
      "View customer",
      "Edit customer",
      "Deactivate customer",
      "Activate customer",
      "Restore customer",
    ]);
    const buttons = within(body).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(names.has(b.getAttribute("aria-label") ?? "")).toBe(true);
      expect(b.getAttribute("title")).toBeTruthy();
    }
  });

  it("header actions, status chips, filters, search, sort and pagination all remain", () => {
    renderWithProviders(<CustomersPage />);
    for (const n of [
      /^import$/i,
      /^export$/i,
      /^select$/i,
      /new customer/i,
      /^all$/i,
      /^active$/i,
      /^inactive$/i,
      /^suspended$/i,
      /regulated/i,
      /unassigned/i,
      /removed/i,
    ]) {
      expect(screen.getByRole("button", { name: n })).toBeInTheDocument();
    }
    expect(screen.getByPlaceholderText(/name, business or phone/i)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^name$/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /receivables/i })).toBeInTheDocument();
    expect(screen.getByText(/per page/i)).toBeInTheDocument();
    expect(screen.getByText(/showing 1–3 of 3 customers/i)).toBeInTheDocument();
  });

  it("status chip writes the URL filter; sort by Receivables works", () => {
    renderWithProviders(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: /^active$/i }));
    expect(setUrlFilter).toHaveBeenCalledWith("status", "ACTIVE");
    const th = screen.getByRole("columnheader", { name: /receivables/i });
    expect(lastListParams.sortBy).toBeUndefined();
    fireEvent.click(th.querySelector("button")!);
    expect(lastListParams).toMatchObject({ sortBy: "receivables", sortDir: "asc" });
    fireEvent.click(th.querySelector("button")!);
    expect(lastListParams).toMatchObject({ sortBy: "receivables", sortDir: "desc" });
  });

  it("Edit customer opens the editor without navigating; row checkbox + bulk bar + merge in select mode", () => {
    renderWithProviders(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    expect(screen.getByText(/2 customers selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^merge$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete 2/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deselect all/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
  });

  it("select mode: clicking the name link toggles selection and never navigates", () => {
    renderWithProviders(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: /^select$/i }));
    const link = screen.getByRole("link", { name: "Ada Buyer" });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false); // default (navigation) prevented
    expect(screen.getByText(/1 customer selected/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("Edit customer does not navigate (it opens the editor)", () => {
    renderWithProviders(<CustomersPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit customer" })[0]);
    expect(push).not.toHaveBeenCalled();
  });

  it("trash view: removed rows offer Restore + View only", () => {
    mockFilters = { ...mockFilters, removed: true };
    mockRows = [row({ deletedAt: "2026-01-01T00:00:00Z" })];
    renderWithProviders(<CustomersPage />);
    const body = screen.getAllByRole("rowgroup")[1];
    const labels = within(body)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Restore customer", "View customer"]);
    fireEvent.click(screen.getByRole("button", { name: "Restore customer" }));
    expect(restoreMutate).toHaveBeenCalledWith({ id: "cA" });
  });
});

describe("PKG-1 customers list — secondary line robustness", () => {
  it("tel: href is sanitised to digits and +", () => {
    mockRows = [row({ phone: "(555) 010-0100 ext. 2" })];
    renderWithProviders(<CustomersPage />);
    expect(screen.getByTestId("name-secondary-phone")).toHaveAttribute("href", "tel:55501001002");
  });

  it("long tag names truncate inside the secondary line (class pin; Playwright proves layout)", () => {
    mockRows = [
      row({
        tagAssignments: [
          {
            tag: {
              id: "t9",
              name: "An extremely long tag name that must never widen the row",
              color: "#123456",
            },
          },
        ],
      }),
    ];
    renderWithProviders(<CustomersPage />);
    const chip = screen.getByTestId("name-secondary-tag");
    expect(chip).toHaveClass("truncate", "inline-block");
    expect(chip).toHaveAttribute(
      "title",
      "An extremely long tag name that must never widen the row",
    );
    expect(chip.className).toMatch(/max-w-/);
  });

  it("approvals panel View button has an accessible name", () => {
    mockApprovals.splice(0, mockApprovals.length, {
      id: "ap1",
      customer: { id: "cA", contactName: "Ada Buyer", businessName: "Acme Market" },
      buyerAccount: { email: "ada@acme.test" },
    });
    try {
      renderWithProviders(<CustomersPage />);
      const view = screen.getAllByRole("button", { name: "View customer" })[0];
      fireEvent.click(view);
      expect(push).toHaveBeenCalledWith("/customers/cA");
    } finally {
      mockApprovals.splice(0, mockApprovals.length);
    }
  });
});
