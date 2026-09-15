// F1 (#711 review): the create-modal issue-date default used
// `new Date().toISOString().slice(0, 10)` — the UTC calendar date. An
// operator working in the evening west of UTC (e.g. 23:30 local at UTC-5,
// which is already 04:30Z the next day) got TOMORROW prefilled.
//
// Spies Date.prototype's LOCAL getters directly (getFullYear/getMonth/
// getDate) rather than reassigning process.env.TZ: Node/V8 can cache the
// process's local-timezone offset from the first Date use, so a later TZ
// reassignment (even at module top, inside a worker already spawned with
// its own inherited TZ) does not reliably change what `new Date()` reports
// as local — confirmed by reproducing the failure with that approach first.
// Spying the getters is deterministic regardless of the real machine/CI
// timezone: it proves the default is built from LOCAL date components, not
// that any particular real-world offset is honored.
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import EstimatesPage, { defaultExpiryDate } from "./page";

// #711 delta review: defaultExpiryDate() still computed via `.toISOString()`
// (UTC) after defaultIssueDate() was fixed to local — west of UTC in the
// evening the two defaults could disagree by a day. Unit-tested directly
// with REAL (unmocked) Date arithmetic, not through the component-level
// getter spies below: those spy Date.prototype's local getters globally, so
// the Date object defaultExpiryDate constructs internally for "issue + 30
// days" would ALSO read the spied (frozen) values instead of its own real
// computed date, defeating an arithmetic assertion.
describe("defaultExpiryDate", () => {
  it("adds 30 local-calendar days to the given issue date", () => {
    expect(defaultExpiryDate("2026-09-13")).toBe("2026-10-13");
  });

  it("rolls over a month/year boundary correctly", () => {
    expect(defaultExpiryDate("2026-12-15")).toBe("2027-01-14");
  });
});

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/estimates",
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimates: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useCreateEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [] }, isLoading: false, isError: false }),
  useCustomerPrices: () => ({ data: [], isLoading: false, isError: false }),
}));

jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] }, isLoading: false, isError: false }),
}));

jest.mock("@/lib/api/tier-labels", () => ({
  ...jest.requireActual("@/lib/api/tier-labels"),
  useTierLabels: () => ({ data: {}, isLoading: false, isError: false }),
}));

describe("EstimatesPage — F1 create-modal issue-date default is the LOCAL calendar date", () => {
  let getFullYearSpy: jest.SpyInstance;
  let getMonthSpy: jest.SpyInstance;
  let getDateSpy: jest.SpyInstance;

  beforeAll(() => {
    // Simulates 23:30 local on Sep 13 while the same instant, read via the
    // UTC/ISO path, would already be Sep 14 — the exact scenario the review
    // described (an operator working in the evening west of UTC).
    getFullYearSpy = jest.spyOn(Date.prototype, "getFullYear").mockReturnValue(2026);
    getMonthSpy = jest.spyOn(Date.prototype, "getMonth").mockReturnValue(8); // September (0-indexed)
    getDateSpy = jest.spyOn(Date.prototype, "getDate").mockReturnValue(13);
  });

  afterAll(() => {
    getFullYearSpy.mockRestore();
    getMonthSpy.mockRestore();
    getDateSpy.mockRestore();
  });

  it("reads the LOCAL date components (2026-09-13), not toISOString()'s UTC one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimatesPage />);

    await user.click(screen.getByRole("button", { name: "New Estimate" }));
    const dialog = await screen.findByRole("dialog");

    const dateInputs = dialog.querySelectorAll('input[type="date"]');
    const issueDateInput = dateInputs[0] as HTMLInputElement;

    expect(issueDateInput.value).toBe("2026-09-13");
  });
});
