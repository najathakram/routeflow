import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { RECURRING_ROUTES_ADDON } from "@routeflow/types";
import MyRunsPage from "./page";

/**
 * SA-1098 A-1 (PR-S): the driver's footer on Today's route. Once no stop is left, a run that holds cash or checks
 * with no settlement on record offers ONE primary, "Settle your run" (rows SE-1, SE-5, SE-12). The gate reads the
 * money figure on the run, never the `driver_payments` add-on, and nothing is offered while a stop is left.
 */

const get = jest.fn();
const post = jest.fn();
const patch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "DRIVER" } }),
}));
jest.mock("@/lib/drive-mode", () => ({
  useDriveMode: () => ({ driveMode: false, setDriveMode: jest.fn(), toggle: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));

const todayISO = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const META = { total: 1, page: 1, limit: 100, totalPages: 1 };
const stop = (id: string, status: string) => ({
  id,
  status,
  sequence: 1,
  customer: { businessName: `Stop ${id}` },
  orders: [],
});
const CASH = { cashTotal: 60, checkTotal: 0, count: 1 };

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    scheduledDate: todayISO(),
    status: "IN_PROGRESS",
    route: { name: "North loop" },
    stops: [stop("a", "COMPLETED"), stop("b", "SKIPPED")],
    collectedPayments: CASH,
    settlementNote: null,
    ...over,
  };
}

function serve(r: Record<string, unknown>, addons: unknown[] = [RECURRING_ROUTES_ADDON]) {
  get.mockImplementation((url: string) =>
    url === "/tenants/me/addons"
      ? Promise.resolve({ data: { addons } })
      : Promise.resolve({ data: { data: [r], meta: META } }),
  );
}

describe("MyRunsPage — driver footer: Settle your run (PR-S)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    post.mockResolvedValue({ data: {} });
    patch.mockResolvedValue({ data: {} });
  });

  it("SE-1: cash held, nothing settled, no stop left: Settle your run", async () => {
    serve(run());
    renderWithProviders(<MyRunsPage />);
    expect(await screen.findByRole("button", { name: "Settle your run" })).toBeInTheDocument();
  });

  it("SE-1: Settle your run and Finish route never show together", async () => {
    serve(run());
    renderWithProviders(<MyRunsPage />);
    await screen.findByRole("button", { name: "Settle your run" });
    expect(screen.queryByRole("button", { name: "Finish route" })).toBeNull();
  });

  it("SE-5b: no money held, no stop left: Finish route and no Settle", async () => {
    serve(run({ collectedPayments: { cashTotal: 0, checkTotal: 0, count: 0 } }));
    renderWithProviders(<MyRunsPage />);
    expect(await screen.findByRole("button", { name: "Finish route" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settle your run" })).toBeNull();
  });

  it("SE-12: only checks held counts as money; the driver_payments add-on is never read", async () => {
    serve(run({ collectedPayments: { cashTotal: 0, checkTotal: 25, count: 1 } }), [
      RECURRING_ROUTES_ADDON,
    ]);
    renderWithProviders(<MyRunsPage />);
    expect(await screen.findByRole("button", { name: "Settle your run" })).toBeInTheDocument();
  });

  it("nothing is offered while a stop is left", async () => {
    serve(run({ stops: [stop("a", "COMPLETED"), stop("b", "PENDING")] }));
    renderWithProviders(<MyRunsPage />);
    await screen.findByText("Open full run");
    expect(screen.queryByRole("button", { name: "Settle your run" })).toBeNull();
  });

  it("SE-5: already settled (a note on record): never Settle again", async () => {
    serve(run({ settlementNote: "Settlement recorded" }));
    renderWithProviders(<MyRunsPage />);
    await screen.findByText("Open full run");
    expect(screen.queryByRole("button", { name: "Settle your run" })).toBeNull();
  });

  it("SE-12: no physical money, never Settle", async () => {
    serve(run({ collectedPayments: { cashTotal: 0, checkTotal: 0, count: 0 } }));
    renderWithProviders(<MyRunsPage />);
    await screen.findByText("Open full run");
    expect(screen.queryByRole("button", { name: "Settle your run" })).toBeNull();
  });

  it("SE-1: the sheet shows the server's figure, takes a count, settles then finishes", async () => {
    serve(run());
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);
    await user.click(await screen.findByRole("button", { name: "Settle your run" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByTestId("settlement-expected")).toHaveTextContent("$60.00");
    await user.type(within(sheet).getByLabelText("Cash and checks counted"), "60");
    await user.click(within(sheet).getByRole("button", { name: "Settle and finish route" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/route-runs/run-1/settlement", {
      countedCash: 60,
      varianceReason: undefined,
    });
    expect(patch).toHaveBeenCalledWith("/route-runs/run-1/status", { status: "COMPLETED" });
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]);
  });
});
