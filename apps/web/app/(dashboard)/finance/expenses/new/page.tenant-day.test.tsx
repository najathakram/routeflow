import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewExpensePage from "./page";

/**
 * SA-964 §4: the expense date defaults to the TENANT's day. The fields start empty (nothing is shown or saved on the
 * browser's day while the zone loads) and are seeded when it resolves. The browser clock here is a different day (the
 * 24th local) from the tenant's (the 26th, Pacific/Auckland).
 */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
let settle: (v: { data: { timezone?: string } }) => void = () => undefined;
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) =>
      url === "/settings"
        ? new Promise((resolve) => {
            settle = resolve;
          })
        : Promise.resolve({ data: [] }),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/api/finance", () => ({
  useCreateExpense: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useExpenseCategories: () => ({ data: [] }),
  useMileageRates: () => ({ data: [] }),
  useBulkCreateExpenses: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/suppliers", () => ({ useSuppliers: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api/customers", () => ({ useCustomers: () => ({ data: { data: [] } }) }));
jest.mock("@/components/SupplierSelect", () => ({ SupplierSelect: () => null }));

const dates = () =>
  Array.from(document.querySelectorAll('input[type="date"]')).map(
    (i) => (i as HTMLInputElement).value,
  );

describe("expenses/new: the date is the tenant's day (SA-964 §4)", () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date("2026-10-25T20:00:00Z"),
      doNotFake: ["setTimeout", "setInterval", "setImmediate", "nextTick", "queueMicrotask"],
    });
  });
  afterEach(() => jest.useRealTimers());

  it.each([
    ["Record expense", 1],
    ["Record mileage", 1],
    ["Bulk add expenses", 5],
  ])(
    "%s: empty until the zone resolves, then the tenant's day (not the browser's)",
    async (tab, n) => {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      renderWithProviders(<NewExpensePage />);
      if (tab !== "Record expense") await user.click(screen.getByRole("button", { name: tab }));
      expect(dates().filter((d) => d !== "")).toEqual([]); // no browser-day default while loading
      settle({ data: { timezone: "Pacific/Auckland" } });
      await waitFor(() => expect(dates().filter((d) => d === "2026-10-26")).toHaveLength(n));
    },
  );
});
