import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import ReturnsPage from "./page";

/**
 * SA-1060 PR-1 (MUST 2): the returns list gets a "Waiting for approval" filter. It asks the API for the INLINE returns that are
 * RECEIVED and held, by the shared list of holds staff can approve (never a hand-typed copy), and it does not touch the default
 * list: without it the query is the one the page has always made.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/returns",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/hooks/useUrlSearch", () => ({ useUrlSearch: () => ["", jest.fn(), ""] }));
jest.mock("@/lib/hooks/useUrlPage", () => ({
  useUrlPage: () => [1, jest.fn()],
  useClampPage: () => undefined,
}));
const mockUseReturns = jest.fn();
jest.mock("@/lib/api/returns", () => ({
  useReturns: (p: unknown) => mockUseReturns(p),
  useCreateReturn: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({ useCustomers: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => true })); // holds exist only with inline returns on

beforeEach(() => {
  mockUseReturns.mockReset();
  mockUseReturns.mockReturnValue({
    data: { data: [], meta: { total: 0, totalPages: 1 } },
    isLoading: false,
  });
});

const lastListCall = () =>
  mockUseReturns.mock.calls.map((c) => c[0]).filter((p) => p && p.limit === 20)[
    mockUseReturns.mock.calls.filter((c) => c[0]?.limit === 20).length - 1
  ];

describe("Returns list: Waiting for approval", () => {
  it("off: the list asks what it always asked", () => {
    renderWithProviders(<ReturnsPage />);
    const p = lastListCall();
    expect(p.kind).toBeUndefined();
    expect(p.holdReason).toBeUndefined();
  });

  it("on: INLINE, RECEIVED, and the two holds staff can approve", () => {
    renderWithProviders(<ReturnsPage />);
    fireEvent.click(screen.getByRole("button", { name: /waiting for approval/i }));
    const p = lastListCall();
    expect(p).toMatchObject({
      kind: "INLINE",
      status: "RECEIVED",
      holdReason: "DRIVER_CAP,ALREADY_RETURNED",
    });
  });

  it("Clear filters puts the default query back", () => {
    renderWithProviders(<ReturnsPage />);
    fireEvent.click(screen.getByRole("button", { name: /waiting for approval/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /clear filters/i })[0]); // the filter bar's, and the empty list's
    const p = lastListCall();
    expect(p.kind).toBeUndefined();
    expect(p.holdReason).toBeUndefined();
  });
});
