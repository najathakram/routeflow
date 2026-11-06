import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import FinanceReportsPage from "./page";

/**
 * SA-1078 A-4 (#4061, T2 review): closing the statement sheet refreshes every ["reports"] query, and that refresh must not
 * blank AR aging or Customer Balance Summary. The real report hooks and a real QueryClient run; only `apiClient` is mocked,
 * and a report read can be held open the way a slow read is. Entry for every case: the sheet's own read has landed while it
 * is open, then it closes, so the refresh runs.
 *   U27 / U28  the tapped figure's node is still there, and focused, while the refresh is held (red before A-4)
 *   U29        the new total shows in that same node, and it keeps focus
 *   U30        a first load shows the skeleton
 *   U31        AR aging, 30 to 60 days with 60 never loaded, shows the skeleton and never the 30-day rows
 */
let mockSearch = "report=ar-aging";
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/reports",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: true, loading: false }),
}));
jest.mock("@/lib/api/account-statement", () => ({
  ...jest.requireActual("@/lib/api/account-statement"),
  useMayOpenStatement: () => true,
}));
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const AR_URL = "/bookkeeping/reports/ar-aging-invoices";
const CBS_URL = "/bookkeeping/reports/customer-balance";
const STATEMENT = {
  asOf: "2026-10-31T15:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Co" },
  openBalance: 1000,
  overdue: 250,
  creditAvailable: 0,
  afterCredit: 0,
  waitingToClear: 0,
  openInvoices: [],
  recentPayments: [],
  recentPaymentsTruncated: false,
  credits: [],
};
const arAging = (total: number, name = "Acme Co") => ({
  buckets: {
    current: [
      {
        id: "i1",
        invoiceNumber: "i1",
        customer: { id: "c1", businessName: name },
        total,
        balance: total,
        status: "SENT",
      },
    ],
  },
  totals: { current: total, total },
  toCollectByCustomer: [],
});
const balances = (balance: number) => ({
  data: [{ customerId: "c1", businessName: "Acme Co", invoiceCount: 2, balance, overdue: 250 }],
});

type User = ReturnType<typeof userEvent.setup>;

/**
 * Routes the statement and the report reads. A report read is answered at once for the first `answered` reads and held
 * from then on (AR aging at 60 days is always held); `release(body)` answers every held read. Reads are counted per URL.
 */
function harness(opts: { url: string; first: unknown; answered?: number }) {
  const answered = opts.answered ?? 1;
  let reads = 0;
  const held: Array<(body: unknown) => void> = [];
  const hold = () => new Promise((r) => held.push((b) => r({ data: b })));
  mockGet.mockImplementation((url: string, cfg?: { params?: { intervalDays?: number } }) => {
    if (url === "/customers/c1/account-statement") return Promise.resolve({ data: STATEMENT });
    if (url === opts.url) {
      reads += 1;
      if (opts.url === AR_URL && cfg?.params?.intervalDays === 60) return hold();
      return reads <= answered ? Promise.resolve({ data: opts.first }) : hold();
    }
    return Promise.resolve({ data: [] });
  });
  return {
    reads: () => reads,
    release: (body: unknown) => act(async () => held.splice(0).forEach((h) => h(body))),
  };
}

const rowOf = async () => (await screen.findByText("Acme Co")).closest("tr")!;
const figureOf = (row: HTMLElement) => within(row).getByTestId("open-balance-button");
const hasSkeleton = () => document.querySelector("tbody .animate-pulse") !== null;

/** Opens the sheet on the figure and waits until its own read has landed (the entry condition for the refresh). */
async function openAndLoad(user: User, figure: HTMLElement) {
  await user.click(figure);
  const dialog = await screen.findByRole("dialog", { name: "Statement" });
  await waitFor(() => expect(within(dialog).queryByText("Loading…")).toBeNull());
  return dialog;
}

const REPORTS = [
  ["U27 AR aging", "report=ar-aging", AR_URL, arAging(1000), arAging(1200)],
  [
    "U28 Customer Balance Summary",
    "report=customer-balance",
    CBS_URL,
    balances(1000),
    balances(1200),
  ],
] as const;

describe.each(REPORTS)("%s", (_name, search, url, first, changed) => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSearch = search;
  });

  it.each([
    ["the X", (user: User) => user.click(screen.getByRole("button", { name: "Close" }))],
    ["Esc", (user: User) => user.keyboard("{Escape}")],
  ])(
    "closing by %s keeps the tapped figure's node, focused, while the refresh is held",
    async (_how, close) => {
      const user = userEvent.setup();
      const probe = harness({ url, first });
      renderWithProviders(<FinanceReportsPage />);
      const figure = figureOf(await rowOf());

      await openAndLoad(user, figure);
      await close(user);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(probe.reads()).toBe(2));

      expect(document.body.contains(figure)).toBe(true);
      expect(document.activeElement).toBe(figure);
      expect(hasSkeleton()).toBe(false);
      await probe.release(first);
    },
  );

  it("U29: the new total shows in the same node, and it keeps focus", async () => {
    const user = userEvent.setup();
    const probe = harness({ url, first });
    renderWithProviders(<FinanceReportsPage />);
    const figure = figureOf(await rowOf());
    expect(figure).toHaveTextContent("$1,000.00");

    await openAndLoad(user, figure);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(probe.reads()).toBe(2));
    await probe.release(changed);

    await waitFor(() => expect(figure).toHaveTextContent("$1,200.00"));
    expect(document.body.contains(figure)).toBe(true);
    expect(document.activeElement).toBe(figure);
  });
});

describe("U30: a first load shows the skeleton", () => {
  it.each([
    ["AR aging", "report=ar-aging", AR_URL, arAging(1000)],
    ["Customer Balance Summary", "report=customer-balance", CBS_URL, balances(1000)],
  ])("%s", async (_name, search, url, body) => {
    mockGet.mockReset();
    mockSearch = search;
    const probe = harness({ url, first: body, answered: 0 });
    renderWithProviders(<FinanceReportsPage />);
    await waitFor(() => expect(probe.reads()).toBe(1));
    expect(hasSkeleton()).toBe(true);
    expect(screen.queryByText("Acme Co")).toBeNull();
    await probe.release(body);
    await screen.findByText("Acme Co");
    expect(hasSkeleton()).toBe(false);
  });
});

describe("U31: AR aging, 30 to 60 days with 60 never loaded", () => {
  it("shows the skeleton, never the 30-day rows under 60-day headers", async () => {
    mockGet.mockReset();
    mockSearch = "report=ar-aging";
    const user = userEvent.setup();
    const probe = harness({ url: AR_URL, first: arAging(1000), answered: 1 });
    renderWithProviders(<FinanceReportsPage />);
    await rowOf();

    await user.click(screen.getByRole("button", { name: "60 days" }));
    await waitFor(() => expect(probe.reads()).toBe(2));
    expect(hasSkeleton()).toBe(true);
    expect(screen.queryByText("Acme Co")).toBeNull();
    await probe.release(arAging(1000));
    await screen.findByText("Acme Co");
  });
});

describe("U9: the reopened sheet reads again (the stale statement is cleared on close)", () => {
  it("shows Loading, not the figure it held when it closed", async () => {
    mockGet.mockReset();
    mockSearch = "report=ar-aging";
    const user = userEvent.setup();
    let statementReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === "/customers/c1/account-statement") {
        statementReads += 1;
        return statementReads === 1
          ? Promise.resolve({ data: STATEMENT })
          : new Promise(() => undefined);
      }
      if (url === AR_URL) return Promise.resolve({ data: arAging(1000) });
      return Promise.resolve({ data: [] });
    });
    renderWithProviders(<FinanceReportsPage />);
    const figure = figureOf(await rowOf());

    await openAndLoad(user, figure);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(figure);
    const second = await screen.findByRole("dialog", { name: "Statement" });
    expect(statementReads).toBe(2);
    expect(within(second).getByText("Loading…")).toBeInTheDocument();
  });
});
