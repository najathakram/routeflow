import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import CustomersPage from "./page";

/**
 * UXG-R10 C5 PR-2: below md the customers list is a card list (name, business name, status, open
 * balance, with Edit and Deactivate on the card), the table is md and up only, the header keeps
 * New customer and moves Import / Export / Select into a More menu, the status chips are one
 * sideways row, search stays outside the Filters panel and the sort control sits beside the
 * Filters button.
 */

let mockRows: any[] = [];
let mockTags: any[] = [];
let mockFilters: Record<string, unknown> = {};
const push = jest.fn();
const setUrlFilter = jest.fn();
const exportMutate = jest.fn();
let lastListParams: any = {};

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockRejectedValue(new Error("no network in this test")),
    post: jest.fn(),
  },
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "x", role: "TENANT_ADMIN" } }),
  useOptionalAuth: () => ({ user: { id: "u1", username: "x", role: "TENANT_ADMIN" } }),
}));
jest.mock("@/lib/api/my-permissions", () => ({
  ...jest.requireActual("@/lib/api/my-permissions"),
  useMyPermissions: () => ({ data: undefined }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => "/customers",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/hooks/useUrlFilters", () => ({
  useUrlFilters: () => [mockFilters, setUrlFilter, jest.fn()],
}));

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
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: (params: any) => {
    lastListParams = params;
    return { data: stableData(), isLoading: false, isError: false, refetch: jest.fn() };
  },
  useCustomerTags: () => ({ data: mockTags, isLoading: false, isError: false }),
  useUpdateCustomerStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteCustomer: () => ({ mutate: jest.fn(), isPending: false }),
  useBatchDeleteCustomers: () => ({ mutate: jest.fn(), isPending: false }),
  useExportCustomers: () => ({ mutate: exportMutate, isPending: false }),
  useMergeCustomers: () => ({ mutate: jest.fn(), isPending: false }),
  useRestoreCustomer: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/portal-approvals", () => ({
  ...jest.requireActual("@/lib/api/portal-approvals"),
  usePendingPortalApprovals: () => ({ data: [], isLoading: false, isError: false }),
  useApprovePortalRequest: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/routes", () => ({
  ...jest.requireActual("@/lib/api/routes"),
  useCustomerRouteAssignments: () => ({ data: [], isLoading: false, isError: false }),
}));

const row = (over: Record<string, unknown> = {}) => ({
  id: "cA",
  businessName: "Acme Market",
  contactName: "Ada Buyer",
  phone: "555-0100",
  email: "ada@acme.test",
  openBalance: 1234.5,
  unusedCredits: 0,
  tagAssignments: [{ tag: { id: "t1", name: "VIP", color: "#123456" } }],
  user: { id: "uA", email: "ada@acme.test", username: "ada", status: "ACTIVE" },
  addresses: [],
  ...over,
});

const ROWS = () => [
  row(),
  row({
    id: "cB",
    businessName: "Bo Deli",
    contactName: "Bo",
    openBalance: 0,
    phone: undefined,
    tagAssignments: [],
    user: { id: "uB", email: "bo@acme.test", username: "bo", status: "INACTIVE" },
  }),
  row({
    id: "cW",
    businessName: "Walk-in",
    contactName: "Walk-in",
    openBalance: undefined,
    isWalkIn: true,
    tagAssignments: [],
  }),
];

const cards = (container: HTMLElement) =>
  within(container.querySelector("ul.md\\:hidden") as HTMLElement).getAllByRole("listitem");

beforeEach(() => {
  mockRows = ROWS();
  mockTags = [];
  mockFilters = { status: "", regulated: false, unassigned: false, removed: false };
  jest.clearAllMocks();
});

describe("CustomersPage — phone cards", () => {
  it("renders one card per customer with name, business, status and open balance", () => {
    const { container } = renderWithProviders(<CustomersPage />);
    const list = cards(container);
    expect(list).toHaveLength(3);
    const link = within(list[0]).getByRole("link", { name: "Ada Buyer" });
    expect(link).toHaveAttribute("href", "/customers/cA");
    expect(within(list[0]).getByText("Acme Market")).toBeInTheDocument();
    expect(within(list[0]).getByText("Active")).toBeInTheDocument();
    expect(within(list[0]).getByText("$1,234.50")).toBeInTheDocument();
    expect(within(list[1]).getByText("Inactive")).toBeInTheDocument();
    expect(within(list[1]).getByText("$0.00")).toBeInTheDocument();
    // The phone and the tags show on the card; email and credits are on the detail page.
    expect(within(list[0]).getByRole("link", { name: "555-0100" })).toHaveAttribute(
      "href",
      "tel:5550100",
    );
    expect(within(list[0]).getByText("VIP")).toBeInTheDocument();
  });

  it("tones the balance danger exactly where the table cell does", () => {
    const { container } = renderWithProviders(<CustomersPage />);
    const list = cards(container);
    const cell = (i: number) => screen.getAllByTestId("open-balance-cell")[i];
    const tone = (el: HTMLElement) => (el.className.includes("text-danger") ? "danger" : "default");
    // The card's figure is the same button the table cell holds.
    const figure = (i: number) =>
      within(list[i]).getByTestId("open-balance-button").parentElement as HTMLElement;
    expect(tone(figure(0))).toBe("danger");
    expect(tone(cell(0))).toBe("danger");
    expect(tone(figure(1))).toBe("default");
    expect(tone(cell(1))).toBe("default");
    expect(tone(figure(2))).toBe("default");
    expect(tone(cell(2))).toBe("default");
    // The table opens the statement from the figure, so the card's figure is a 44px button too.
    const button = within(list[0]).getByTestId("open-balance-button");
    expect(button.className).toContain("min-h-[44px]");
    expect(button.className).toContain("sm:min-h-[44px]");
  });

  it("puts Edit and Deactivate on the card with Deactivate last and 16px away; no View", () => {
    const { container } = renderWithProviders(<CustomersPage />);
    const list = cards(container);
    expect(within(list[0]).queryByRole("button", { name: /^View/ })).toBeNull();
    const edit = within(list[0]).getByRole("button", { name: "Edit Ada Buyer" });
    const off = within(list[0]).getByRole("button", { name: "Deactivate Ada Buyer" });
    for (const b of [edit, off]) {
      expect(b.className).toContain("min-h-[44px]");
      expect(b.className).toContain("min-w-[44px]");
    }
    expect(off.className).toContain("ml-2");
    expect(off.previousElementSibling).toBe(edit);
    expect(off.nextElementSibling).toBeNull();
    // An inactive customer offers Activate.
    expect(within(list[1]).getByRole("button", { name: "Activate Bo" })).toBeInTheDocument();
    // The walk-in customer can only be edited.
    expect(within(list[2]).getByRole("button", { name: "Edit Walk-in" })).toBeInTheDocument();
    expect(within(list[2]).queryByRole("button", { name: /Deactivate|Activate/ })).toBeNull();
  });

  it("offers Restore on a removed customer, in place of Edit and Deactivate", () => {
    mockRows = [row({ deletedAt: "2026-01-01T00:00:00.000Z" })];
    mockFilters = { status: "", regulated: false, unassigned: false, removed: true };
    const { container } = renderWithProviders(<CustomersPage />);
    const list = cards(container);
    expect(within(list[0]).getByText("Removed")).toBeInTheDocument();
    expect(within(list[0]).getByRole("button", { name: "Restore Ada Buyer" })).toBeInTheDocument();
    expect(within(list[0]).queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  it("shows the table only from md up, and keeps it for the empty state", () => {
    const { rerender } = renderWithProviders(<CustomersPage />);
    const wrapper = screen.getByRole("table").closest("div.hidden") as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("md:block");
    mockRows = [];
    rerender(<CustomersPage />);
    expect(screen.getByRole("table").closest("div.hidden")).toBeNull();
    expect(document.querySelector("ul.md\\:hidden")).toBeNull();
  });

  it("is one header row below md: description hidden, New customer visible, the rest in More", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersPage />);
    const desc = screen.getByText(/your current filters are saved/);
    expect(desc.className).toContain("hidden");
    expect(desc.className).toContain("md:block");
    for (const name of [/Import/, /Export/, /Select/]) {
      const plain = screen.getByRole("button", { name });
      expect(plain.className).toContain("hidden");
      expect(plain.className).toContain("md:inline-flex");
    }
    expect(screen.getByRole("button", { name: "New customer" }).className).toContain(
      "min-h-[44px]",
    );
    const more = screen.getByRole("button", { name: "More actions" });
    expect(more.className).toContain("md:hidden");
    await user.click(more);
    expect(await screen.findByRole("menuitem", { name: "Import" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Select" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(exportMutate).toHaveBeenCalled();
  });

  it("scrolls the status chips in one row below md and keeps them in the bar from md up", () => {
    renderWithProviders(<CustomersPage />);
    const all = screen.getByRole("button", { name: "All" });
    const scroller = all.parentElement as HTMLElement;
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("snap-x");
    expect(scroller.className).toContain("md:contents");
    expect(scroller.className.split(" ")).not.toContain("flex-wrap");
    expect(all.className).toContain("shrink-0");
    expect(all.className).toContain("h-11");
    for (const name of ["Regulated", "Removed"]) {
      expect(screen.getByRole("button", { name }).parentElement).toBe(scroller);
    }
  });

  it("keeps search outside the Filters panel; Type and Tag open from Filters (n) and search is not counted", async () => {
    const user = userEvent.setup();
    mockTags = [{ id: "t1", name: "VIP", color: "#123456" }];
    renderWithProviders(<CustomersPage />);
    const search = screen.getByPlaceholderText("Name, business or phone…") as HTMLElement;
    const button = screen.getByRole("button", { name: "Filters" });
    const panel = document.getElementById(button.getAttribute("aria-controls")!) as HTMLElement;
    expect(panel).not.toContainElement(search);
    expect(search.className).toContain("w-full");
    expect(panel).toContainElement(screen.getByLabelText("Type"));
    expect(panel).toContainElement(screen.getByLabelText("Tag"));
    await user.type(search, "ada");
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Type"), "BUSINESS");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
    expect(lastListParams.customerType).toBe("BUSINESS");
  });

  it("has no Filters button when there is only the Type filter; the Type select shows with its label", () => {
    renderWithProviders(<CustomersPage />);
    expect(screen.queryByRole("button", { name: /^Filters/ })).toBeNull();
    expect(screen.getByLabelText("Type")).toBeInTheDocument();
  });

  it("has a phone sort control that tells the truth: Newest while nothing is sorted, direction disabled then", async () => {
    renderWithProviders(<CustomersPage />);
    const select = screen.getByLabelText("Sort customers by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["", "Newest"],
      ["contactName", "Name"],
      ["businessName", "Business name"],
    ]);
    expect(select.value).toBe("");
    const dir = screen.getByRole("button", { name: /^Sort (ascending|descending)$/ });
    expect(dir).toBeDisabled();
    expect(dir.className).toContain("h-11");
    expect(dir.className).toContain("w-11");
    expect(lastListParams.sortBy).toBeUndefined();
  });

  it("picking a column sorts like the table header first click (ascending); the direction button then flips it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersPage />);
    const select = screen.getByLabelText("Sort customers by") as HTMLSelectElement;
    await user.selectOptions(select, "businessName");
    expect(lastListParams).toMatchObject({ sortBy: "businessName", sortDir: "asc" });
    expect(select.value).toBe("businessName");
    const dir = screen.getByRole("button", { name: "Sort descending" });
    expect(dir).toBeEnabled();
    await user.click(dir);
    expect(lastListParams).toMatchObject({ sortBy: "businessName", sortDir: "desc" });
    expect(screen.getByRole("button", { name: "Sort ascending" })).toBeInTheDocument();
  });

  it("picking Newest clears the sort and disables the direction button again", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersPage />);
    const select = screen.getByLabelText("Sort customers by") as HTMLSelectElement;
    await user.selectOptions(select, "contactName");
    await user.click(screen.getByRole("button", { name: "Sort descending" }));
    await user.selectOptions(select, "");
    expect(select.value).toBe("");
    expect(lastListParams.sortBy).toBeUndefined();
    expect(screen.getByRole("button", { name: /^Sort (ascending|descending)$/ })).toBeDisabled();
    // Sorting again starts ascending, not from the old direction.
    await user.selectOptions(select, "contactName");
    expect(lastListParams).toMatchObject({ sortBy: "contactName", sortDir: "asc" });
  });

  it("shows a customer name in the normal text, not the mono number style", () => {
    const { container } = renderWithProviders(<CustomersPage />);
    const link = within(cards(container)[0]).getByRole("link", { name: "Ada Buyer" });
    expect(link.className).not.toContain("font-mono");
  });

  it("marks every regulated customer on its card, in the badges row, also when the title is the business name", () => {
    mockRows = [
      row({ id: "cR1", regulatedCount: 2 }),
      row({
        id: "cR2",
        contactName: "",
        businessName: "Acme Tobacco",
        regulatedCount: 1,
        user: { id: "uR2", email: "r2@acme.test", username: "r2", status: "ACTIVE" },
      }),
      row({ id: "cR3", contactName: "Cy", businessName: "Cy Shop", regulatedCount: 0 }),
    ];
    const { container } = renderWithProviders(<CustomersPage />);
    const list = cards(container);
    for (const i of [0, 1]) {
      const mark = within(list[i]).getByTitle("Sells regulated items");
      const badgesRow = within(list[i]).getByText("Active").closest("div.flex-wrap") as HTMLElement;
      expect(badgesRow).toContainElement(mark);
    }
    expect(within(list[2]).queryByTitle("Sells regulated items")).toBeNull();
  });

  it("keeps Type and Tag as separate items of the desktop bar, in the old order", () => {
    mockTags = [{ id: "t1", name: "VIP", color: "#123456" }];
    renderWithProviders(<CustomersPage />);
    const search = screen.getByPlaceholderText("Name, business or phone…") as HTMLElement;
    const bar = search.parentElement as HTMLElement;
    const itemOf = (control: HTMLElement) => {
      let node = control.parentElement as HTMLElement;
      // The field wrapper is the item itself; any wrapper above it must be md:contents.
      const item = node;
      node = node.parentElement as HTMLElement;
      while (node !== bar) {
        expect(node.className).toContain("md:contents");
        node = node.parentElement as HTMLElement;
      }
      return item;
    };
    const type = itemOf(screen.getByText("Type", { selector: "label" }));
    const tag = itemOf(screen.getByText("Tag", { selector: "label" }));
    expect(type).not.toBe(tag);
    expect(type.className).toContain("md:order-1");
    expect(tag.className).toContain("md:order-1");
    expect(type.className).toContain("md:w-32");
    expect(tag.className).toContain("md:w-32");
    expect(search.className).toContain("md:order-3");
  });

  it("wraps the bulk bar only below md", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersPage />);
    await user.click(screen.getByRole("button", { name: /^Select$/ }));
    await user.click(screen.getByRole("checkbox", { name: "Select Ada Buyer" }));
    const bar = screen.getByText("1 customer selected").parentElement as HTMLElement;
    const inner = screen.getByRole("button", { name: "Deselect all" }).parentElement as HTMLElement;
    for (const el of [bar, inner]) {
      const classes = el.className.split(" ");
      expect(classes).toContain("max-md:flex-wrap");
      expect(classes).not.toContain("flex-wrap");
    }
  });

  it("in select mode every card has a checkbox, the walk-in one disabled, and Select all works", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<CustomersPage />);
    expect(within(cards(container)[0]).queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Select$/ }));
    const list = cards(container);
    const box = within(list[0]).getByRole("checkbox", { name: "Select Ada Buyer" });
    expect(within(list[2]).getByRole("checkbox", { name: "Select Walk-in" })).toBeDisabled();
    // Like the table row, tapping the card while selecting toggles it and does not open it.
    await user.click(within(list[1]).getByRole("link", { name: "Bo" }));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("1 customer selected")).toBeInTheDocument();
    await user.click(box);
    expect(screen.getByText("2 customers selected")).toBeInTheDocument();
    await user.click(within(list[1]).getByRole("checkbox", { name: "Select Bo" }));
    expect(screen.getByText("1 customer selected")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all customers on this page" }));
    expect(screen.getByText("2 customers selected")).toBeInTheDocument();
  });

  it("uses the contents filter panel layout (its controls stay direct items of the bar)", () => {
    mockTags = [{ id: "t1", name: "VIP", color: "#123456" }];
    renderWithProviders(<CustomersPage />);
    const button = screen.getByRole("button", { name: /^Filters/ });
    const root = button.parentElement!.parentElement as HTMLElement;
    const panel = document.getElementById(button.getAttribute("aria-controls")!) as HTMLElement;
    expect(panel.parentElement).toBe(root);
    expect(root.className.split(" ")).toContain("md:contents");
  });

  it("offers only sort values the customers list endpoint really sorts by (class pin against the service allowlist)", () => {
    const service = fs.readFileSync(
      path.resolve(__dirname, "../../../../api/src/customers/customers.service.ts"),
      "utf8",
    );
    const block = /const validSortFields[^=]*=\s*\{([\s\S]*?)\};/.exec(service);
    expect(block).not.toBeNull();
    const allowed = Array.from(block![1].matchAll(/^\s*(\w+)\s*:/gm)).map((m) => m[1]);
    expect(allowed.length).toBeGreaterThan(3);
    renderWithProviders(<CustomersPage />);
    const select = screen.getByLabelText("Sort customers by") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("");
    for (const v of values.filter(Boolean)) expect(allowed).toContain(v);
  });
});
