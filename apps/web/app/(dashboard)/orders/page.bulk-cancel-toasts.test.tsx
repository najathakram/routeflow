import * as React from "react";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { handleMutationError } from "@/lib/mutation-error-toast";
import OrdersPage from "./page";

// REG-B1006 (review round): when the bulk cancel fails, the app-wide MutationCache error handler
// toasted once PER ORDER ("Something went wrong ..." x2) on top of the page's own summary toast, and
// those covered it. The bulk cancel owns its error UI (the one summary toast), so it opts out of the
// global toast with the existing `meta.localErrorToast` pattern. The real handler is wired here, as in
// app/providers.tsx; only the HTTP client is mocked.

const mockToast = jest.fn();
const mockPatch = jest.fn();

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: jest.fn(),
  },
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
}));

const orderRow = (id: string, n: number) => ({
  id,
  orderNumber: `ORD-${n}`,
  status: "PENDING",
  urgent: false,
  total: 100,
  createdAt: "2026-10-01T00:00:00.000Z",
  requestedDeliveryDate: null,
  customer: { businessName: `Acme ${n}` },
  lineItems: [],
});

// Only the list hook is faked: the REAL useUpdateOrderStatus (and its mutation meta) is under test.
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: {
      data: [orderRow("o1", 1), orderRow("o2", 2)],
      meta: { total: 2, page: 1, limit: 20, totalPages: 1 },
    },
    isLoading: false,
    isError: false,
  }),
}));

jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));

const clientLikeProviders = () =>
  new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _v, _c, mutation) =>
        handleMutationError(error, mutation, mockToast, { push: jest.fn() }),
    }),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

async function failBulkCancel(status: number) {
  mockPatch.mockRejectedValue({ response: { status, data: { message: "RAW server text" } } });
  renderWithProviders(<OrdersPage />, { queryClient: clientLikeProviders() });
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel 2 orders" }));
  await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mockToast).toHaveBeenCalled());
  // let the second rejection settle so a per-order global toast would have fired by now
  await new Promise((r) => setTimeout(r, 50));
}

describe("OrdersPage — bulk cancel failure shows ONE summary toast (REG-B1006)", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([500, 409])(
    "a %s on the cancel requests toasts exactly once: the summary",
    async (status) => {
      await failBulkCancel(status);

      // Before the fix: the global handler fired once per order (2x "Something went wrong ...")
      // in addition to the summary.
      expect(mockToast.mock.calls.map((c) => c[0].title)).toEqual(["Failed to cancel some orders"]);
    },
  );
});
