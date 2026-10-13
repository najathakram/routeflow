import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import CustomerDetailPage from "./page";

// ACTION-ITEMS row 318c (SA-770): the customer page's Invoices tab coloured the due date red only for
// `status === "OVERDUE"`, so a past-due PARTIAL (the status a part-paid, past-due invoice keeps: the sweep never
// flips it) was not red. The server's `isOverdue` flag is the one rule (open status AND balance due AND the
// due day ended in the tenant's zone), so the cell follows it.
const get = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/customers/c1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: true, loading: false }),
  useRoutesAccess: () => ({ enabled: true, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

const customer = {
  id: "c1",
  businessName: "Acme Foods",
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ACTIVE",
  pricingTier: 1,
  user: { status: "ACTIVE" },
  addresses: [],
};

const invoice = (id: string, number: string, over: Record<string, unknown>) => ({
  id,
  invoiceNumber: number,
  customerId: "c1",
  issueDate: "2026-09-01T00:00:00.000Z",
  total: 100,
  balanceDue: 100,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const open = async (invoices: unknown[]) => {
  get.mockImplementation((url: string) => {
    if (url === "/customers/c1") return Promise.resolve({ data: customer });
    if (url === "/customers/c1/statement")
      return Promise.resolve({ data: { transactions: [], creditExposure: 0 } });
    if (url === "/customers/c1/routes") return Promise.resolve({ data: [] });
    if (url === "/policies") return Promise.resolve({ data: { policies: [] } });
    if (url === "/invoices")
      return Promise.resolve({
        data: {
          data: invoices,
          meta: { total: invoices.length, page: 1, limit: 50, totalPages: 1 },
        },
      });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <CustomerDetailPage />
    </Providers>,
  );
  await screen.findAllByText("Acme Foods");
  await userEvent.click(await screen.findByRole("tab", { name: /^Invoices/ }));
};

/** The due-date cell of the row for invoice `number`. */
const dueCell = async (number: string) => {
  const row = (await screen.findByText(number)).closest("tr")!;
  return row.querySelectorAll("td")[2] as HTMLElement;
};

beforeAll(() => {
  // jsdom has no scrollIntoView; the tab strip calls it when a tab is activated.
  Element.prototype.scrollIntoView = jest.fn();
});
beforeEach(() => jest.clearAllMocks());

describe("customer page Invoices tab: due date colour follows the server's isOverdue (row 318c)", () => {
  it("a past-due PARTIAL that still owes is red even though its status is not OVERDUE", async () => {
    await open([
      invoice("i1", "INV-PARTIAL", {
        status: "PARTIAL",
        balanceDue: 5,
        dueDate: "2026-09-15T00:00:00.000Z",
        isOverdue: true,
      }),
    ]);
    const cell = await dueCell("INV-PARTIAL");
    expect(cell.className).toMatch(/\btext-danger\b/);
    expect(cell.className).toMatch(/\bfont-semibold\b/);
  });

  it("a status-OVERDUE row the server says is not overdue (due day not ended) is not red", async () => {
    await open([
      invoice("i2", "INV-STALE", {
        status: "OVERDUE",
        dueDate: "2099-01-01T00:00:00.000Z",
        isOverdue: false,
      }),
    ]);
    expect((await dueCell("INV-STALE")).className).not.toMatch(/\btext-danger\b/);
  });

  it("an overdue-status invoice the server flags overdue stays red; an on-time one is not", async () => {
    await open([
      invoice("i3", "INV-LATE", {
        status: "OVERDUE",
        dueDate: "2026-09-01T00:00:00.000Z",
        isOverdue: true,
      }),
      invoice("i4", "INV-OK", {
        status: "SENT",
        dueDate: "2099-01-01T00:00:00.000Z",
        isOverdue: false,
      }),
    ]);
    expect((await dueCell("INV-LATE")).className).toMatch(/\btext-danger\b/);
    expect((await dueCell("INV-OK")).className).not.toMatch(/\btext-danger\b/);
  });
});
