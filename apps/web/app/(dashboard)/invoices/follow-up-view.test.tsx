import * as React from "react";
import { renderWithProviders, screen, fireEvent, within } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import { FollowUpView, FOLLOW_UP_BATCH_KEY } from "./follow-up-view";

/**
 * P-30 / SA-1264 PR-1: the Follow up view on the Invoices list. Three lenses over the list API (Due soon, Overdue, To
 * collect), a daily batch of 10 sent as `limit` with a 5/10/20/50 chooser kept per user on this device, the owed amount
 * read from the server's `balanceDue` with `pendingAmount` beside it (never total minus paid here), and Record payment
 * for ONE customer's invoices only (F-R4).
 */
const mockUseInvoices = jest.fn();
const mockToast = jest.fn();
const mockReplace = jest.fn();
let mockQuery = "";
let mockRows: unknown[] = [];
let mockTotal = 0;
const modalProps = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/invoices",
  useSearchParams: () => new URLSearchParams(mockQuery),
}));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoices: (...args: unknown[]) => {
    mockUseInvoices(...args);
    return {
      data: { data: mockRows, meta: { total: mockTotal, page: 1, limit: 10, totalPages: 1 } },
      isLoading: false,
      isError: false,
    };
  },
  useSendInvoiceReminder: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/components/CustomerRecordPaymentModal", () => ({
  CustomerRecordPaymentModal: (props: unknown) => {
    modalProps(props);
    return <div role="dialog">Record payment dialog</div>;
  },
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

const row = (id: string, customerId: string, extra: Record<string, unknown> = {}) => ({
  id,
  invoiceNumber: `INV-${id}`,
  status: "SENT",
  total: 100,
  balanceDue: 100,
  pendingAmount: 0,
  dueDate: "2026-11-23T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  customer: { id: customerId, businessName: `Customer ${customerId}` },
  ...extra,
});
const lastParams = () => mockUseInvoices.mock.calls.at(-1)?.[0];

beforeEach(() => {
  mockUseInvoices.mockClear();
  mockToast.mockClear();
  modalProps.mockClear();
  localStorage.clear();
  seedSession("OPERATOR");
  mockQuery = "";
  mockRows = [];
  mockTotal = 0;
});
afterEach(() => seedSession(null));

describe("FollowUpView lenses", () => {
  it.each([
    ["overdue", { isOverdue: true }],
    ["due-soon", { dueWithinDays: 7 }],
    ["to-collect", { toCollect: true }],
  ])("the %s lens asks the list API for %j, oldest due first", (lens, expected) => {
    mockQuery = `lens=${lens}`;
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    expect(lastParams()).toEqual(
      expect.objectContaining({ ...expected, sortBy: "dueDate", sortOrder: "asc", page: 1 }),
    );
  });

  it("tapping a lens writes it to the URL", () => {
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Due soon" }));
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining("lens=due-soon"), {
      scroll: false,
    });
  });
});

describe("FollowUpView daily batch", () => {
  it("defaults to 10, sent as limit, with the header 'Today's 10 · Show all (48)'", () => {
    mockRows = [row("a", "c1")];
    mockTotal = 48;
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    expect(lastParams().limit).toBe(10);
    expect(screen.getByText("Today's 10")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all (48)" })).toBeTruthy();
  });

  it("the chooser offers 5, 10, 20 and 50 and keeps the pick per user on this device", () => {
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    const chooser = screen.getByRole("combobox", { name: "Daily batch" }) as HTMLSelectElement;
    expect(Array.from(chooser.options).map((o) => o.value)).toEqual(["5", "10", "20", "50"]);
    fireEvent.change(chooser, { target: { value: "20" } });
    expect(lastParams().limit).toBe(20);
    expect(localStorage.getItem(`${FOLLOW_UP_BATCH_KEY}.user-operator`)).toBe("20");
  });

  it("reads a kept pick back, and ignores a value outside 5/10/20/50", () => {
    localStorage.setItem(`${FOLLOW_UP_BATCH_KEY}.user-operator`, "50");
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    expect(lastParams().limit).toBe(50);
    localStorage.setItem(`${FOLLOW_UP_BATCH_KEY}.user-operator`, "7");
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    expect(lastParams().limit).toBe(10);
  });

  it("Show all asks for the whole list", () => {
    mockTotal = 48;
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show all (48)" }));
    expect(lastParams().limit).toBe(1000);
  });
});

describe("FollowUpView money", () => {
  it("F-P4: owed is the server balance (60.00) with 60.00 pending beside it", () => {
    mockRows = [row("a", "c1", { total: 100, balanceDue: 60, pendingAmount: 60 })];
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    const r = screen.getByRole("row", { name: /INV-a/ });
    expect(within(r).getByText("$60.00")).toBeTruthy();
    expect(within(r).getByText("$60.00 pending")).toBeTruthy();
  });

  it("F-P8: 100.00 with 33.33 paid reads the server's 66.67 and shows no pending", () => {
    mockRows = [row("a", "c1", { total: 100, balanceDue: 66.67, pendingAmount: 0 })];
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    const r = screen.getByRole("row", { name: /INV-a/ });
    expect(within(r).getByText("$66.67")).toBeTruthy();
    expect(within(r).queryByText(/pending/)).toBeNull();
  });
});

describe("FollowUpView Record payment (F-R4)", () => {
  const pick = (id: string) =>
    fireEvent.click(screen.getByRole("checkbox", { name: `Select INV-${id}` }));

  it("refuses a second customer's invoice with 'Select one customer's invoices.'", () => {
    mockRows = [row("a", "c1"), row("b", "c2")];
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    pick("a");
    pick("b");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Select one customer's invoices." }),
    );
    expect(
      (screen.getByRole("checkbox", { name: "Select INV-b" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("one customer's three invoices open ONE payment dialog for those three", () => {
    mockRows = [row("a", "c1"), row("b", "c1"), row("c", "c1"), row("d", "c2")];
    renderWithProviders(<FollowUpView onExit={jest.fn()} />);
    pick("a");
    pick("b");
    pick("c");
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(modalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ customerId: "c1", invoiceIds: ["a", "b", "c"] }),
    );
  });
});
