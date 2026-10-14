import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { API_ERROR_CODES, type RestrictionWarningError } from "@routeflow/types";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * Row 510 on the order detail page: a staff write the API answers with 409 RESTRICTION_WARNING opens the
 * warning dialog (no toast), and "Sell anyway" re-sends the SAME request plus the reason per line and the hash.
 * The real global MutationCache handler is in play, so a missing HANDLED_CODES entry fails here too.
 */
const toast = jest.fn();
const get = jest.fn();
const patch = jest.fn();
const post = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "o1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders/o1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));

const baseOrder = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "c1",
  customer: { id: "c1", businessName: "Acme Retail" },
  status: "DRAFT",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
};
const warning: RestrictionWarningError = {
  code: API_ERROR_CODES.RESTRICTION_WARNING,
  message: "Some items are restricted.",
  warningHash: "rw1:abc",
  lines: [
    {
      lineKey: "l:item-1",
      productId: "p1",
      displayName: "Acme Gummies",
      outcome: "BLOCK",
      rules: [
        {
          id: "r1",
          states: ["CA"],
          legal: true,
          reasonText: "This product is banned in CA by law.",
        },
      ],
    },
  ],
};
const reject = (mock: jest.Mock, status: number, data: object) =>
  mock.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );
const ack = {
  restrictionOverrides: [{ lineKey: "l:item-1", reason: "Owner approved" }],
  warningHash: "rw1:abc",
};

const renderPage = (order: object) => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order : [] }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
};
const sellAnyway = async () => {
  const user = userEvent.setup();
  expect(await screen.findByText("Acme Gummies")).toBeInTheDocument();
  await user.type(screen.getByLabelText(/reason/i), "Owner approved");
  await user.click(screen.getByRole("button", { name: "Sell anyway" }));
};

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
  patch.mockResolvedValue({ data: baseOrder });
  post.mockResolvedValue({ data: baseOrder });
});

describe("order detail: RESTRICTION_WARNING", () => {
  it("Publish (promote DRAFT to PENDING) warns, then re-sends the same status change with the ack", async () => {
    reject(patch, 409, warning);
    renderPage(baseOrder);
    fireEvent.click(await screen.findByRole("button", { name: /Publish Order/ }));
    await sellAnyway();
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[0]).toEqual(["/orders/o1/status", { status: "PENDING" }]);
    expect(patch.mock.calls[1]).toEqual(["/orders/o1/status", { status: "PENDING", ...ack }]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("Reopen warns, then re-sends the reopen with the ack as its body", async () => {
    reject(post, 409, warning);
    jest.spyOn(window, "confirm").mockReturnValue(true);
    renderPage({ ...baseOrder, status: "CANCELLED" });
    fireEvent.click(await screen.findByRole("button", { name: /Reopen Order/ }));
    await sellAnyway();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[0]).toEqual(["/orders/o1/reopen"]);
    expect(post.mock.calls[1]).toEqual(["/orders/o1/reopen", ack]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("the fulfil-path switch warns, then re-sends the same path with the ack", async () => {
    reject(patch, 409, warning);
    renderPage({ ...baseOrder, status: "PENDING" });
    const select = await screen.findByDisplayValue(/Route|Delivery/i);
    fireEvent.change(select, { target: { value: "SHIP" } });
    await sellAnyway();
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[0]).toEqual(["/orders/o1/fulfill-path", { fulfillPath: "SHIP" }]);
    expect(patch.mock.calls[1]).toEqual([
      "/orders/o1/fulfill-path",
      { fulfillPath: "SHIP", ...ack },
    ]);
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "error" }));
  });

  it("an item edit warns, then re-sends the same PATCH /items body plus the ack", async () => {
    reject(patch, 409, warning);
    renderPage({
      ...baseOrder,
      status: "PENDING",
      lineItems: [
        {
          id: "li-1",
          productId: "p1",
          product: { id: "p1", name: "Widget", unit: "each", unitsPerBox: null },
          qty: 10,
          unitPrice: 2,
          status: "CONFIRMED",
        },
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
    const qty = await screen.findByDisplayValue("10");
    fireEvent.change(qty, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await sellAnyway();
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    const [first, second] = patch.mock.calls;
    expect(first[0]).toBe("/orders/o1/items");
    expect(second[0]).toBe("/orders/o1/items");
    expect(second[1]).toEqual(expect.objectContaining({ items: first[1].items, ...ack }));
    expect(first[1].restrictionOverrides).toBeUndefined();
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "error" }));
  });

  it("a fresh second 409 re-shows the dialog with the new list and keeps the reason", async () => {
    reject(patch, 409, warning);
    reject(patch, 409, {
      ...warning,
      warningHash: "rw1:def",
      lines: [...warning.lines, { ...warning.lines[0], lineKey: "n:1", displayName: "Acme Vape" }],
    });
    renderPage(baseOrder);
    fireEvent.click(await screen.findByRole("button", { name: /Publish Order/ }));
    await sellAnyway();
    expect(await screen.findByText("Acme Vape")).toBeInTheDocument();
    expect(screen.getByLabelText(/reason/i)).toHaveValue("Owner approved");
    fireEvent.click(screen.getByRole("button", { name: "Sell anyway" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(3));
    expect(patch.mock.calls[2][1].warningHash).toBe("rw1:def");
    expect(patch.mock.calls[2][1].restrictionOverrides).toHaveLength(2);
  });

  it("Go back leaves the order untouched: one request, no second send", async () => {
    reject(patch, 409, warning);
    renderPage(baseOrder);
    fireEvent.click(await screen.findByRole("button", { name: /Publish Order/ }));
    expect(await screen.findByText("Acme Gummies")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(screen.queryByText("Acme Gummies")).toBeNull());
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
