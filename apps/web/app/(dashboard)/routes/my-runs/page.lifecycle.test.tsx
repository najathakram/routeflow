import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { RECURRING_ROUTES_ADDON } from "@routeflow/types";
import { STOP_GENERIC_COPY } from "@/lib/driver-stop-copy";
import MyRunsPage, { finishRouteBlocker, finishedRunView } from "./page";
import type { RouteRun, RouteRunStop } from "@/lib/api/routes";
import { fmtCalendarDateWithWeekday } from "@/lib/calendar-date";

const get = jest.fn();
const patch = jest.fn();
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
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

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const stop = (id: string, status: RouteRunStop["status"]): RouteRunStop => ({
  id,
  stopNumber: 1,
  customerId: "c1",
  customer: { id: "c1", businessName: `Shop ${id}`, contactName: "Pat" },
  status,
  orders: [],
});
const run = (over: Partial<RouteRun> = {}): RouteRun => ({
  id: "run-1",
  routeId: "r1",
  route: { id: "r1", name: "North loop" },
  status: "SCHEDULED",
  scheduledDate: `${today()}T00:00:00.000Z`,
  stops: [stop("s1", "PENDING")],
  ...over,
});
/** The list the server answers: `current` is read at call time, so a test can take the run out of the list (it finished) or put it back (Undo). */
const serveList = (current: () => RouteRun[]) =>
  get.mockImplementation((url: string) =>
    url === "/tenants/me/addons"
      ? Promise.resolve({ data: { addons: [RECURRING_ROUTES_ADDON] } })
      : Promise.resolve({
          data: { data: current(), meta: { total: 1, page: 1, limit: 100, totalPages: 1 } },
        }),
  );
const serve = (r: RouteRun) => serveList(() => [r]);

/** SA-1098 PR-2 rows D-3 (Start route), D-17 (Finish route after a skipped last stop), D-18 (a run with no stops), D-19 (money taken in the app). */
describe("finishRouteBlocker (D-17, D-18, D-19)", () => {
  it("D-17: the last stop skipped leaves nothing open, so Finish route is offered", () => {
    const r = run({ status: "IN_PROGRESS" });
    expect(finishRouteBlocker(r, [stop("s1", "COMPLETED"), stop("s2", "SKIPPED")])).toBe("");
  });
  it("D-18: a run with no stops can be finished", () => {
    expect(finishRouteBlocker(run({ status: "IN_PROGRESS" }), [])).toBe("");
  });
  it("a stop still open keeps Finish route off", () => {
    expect(
      finishRouteBlocker(run({ status: "IN_PROGRESS" }), [stop("s1", "IN_PROGRESS")]),
    ).toBeNull();
  });
  it("a run that has not started has no Finish route", () => {
    expect(finishRouteBlocker(run(), [])).toBeNull();
  });
  it("D-19: money collected in the app with no settlement note keeps Finish route off, and says why", () => {
    const r = run({
      status: "IN_PROGRESS",
      collectedPayments: { cashTotal: 40, checkTotal: 0, count: 1 },
    });
    expect(finishRouteBlocker(r, [stop("s1", "COMPLETED")])).toMatch(/Settle it in the driver app/);
  });
  it("D-19b: once the run carries its settlement note, Finish route is offered again", () => {
    const r = run({
      status: "IN_PROGRESS",
      settlementNote: "Settled",
      collectedPayments: { cashTotal: 40, checkTotal: 0, count: 1 },
    });
    expect(finishRouteBlocker(r, [stop("s1", "COMPLETED")])).toBe("");
  });
});

describe("MyRunsPage: Start route / Finish route (SA-1098 PR-2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, "confirm").mockReturnValue(true);
    patch.mockResolvedValue({ data: {} });
  });

  it("D-3: a scheduled run shows Start route, which PATCHes the run to IN_PROGRESS", async () => {
    serve(run());
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);

    await user.click(await screen.findByRole("button", { name: "Start route" }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/route-runs/run-1/status", { status: "IN_PROGRESS" }),
    );
    expect(screen.queryByRole("button", { name: "Finish route" })).not.toBeInTheDocument();
  });

  it("Finish route confirms, then PATCHes the run to COMPLETED", async () => {
    serve(run({ status: "IN_PROGRESS", stops: [stop("s1", "COMPLETED")] }));
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);

    await user.click(await screen.findByRole("button", { name: "Finish route" }));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/route-runs/run-1/status", { status: "COMPLETED" }),
    );
  });

  it("a refusal on Finish route shows fixed words, never the server's, and changes nothing else", async () => {
    serve(run({ status: "IN_PROGRESS", stops: [stop("s1", "SKIPPED")] }));
    patch.mockRejectedValueOnce({
      response: { status: 409, data: { message: "Settle the cash first." } },
    });
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);

    await user.click(await screen.findByRole("button", { name: "Finish route" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(STOP_GENERIC_COPY);
  });

  it("F5: Finish route tells the driver what happens to skipped stops, and says nothing of them when none were skipped", async () => {
    const user = userEvent.setup();
    serve(run({ status: "IN_PROGRESS", stops: [stop("s1", "SKIPPED"), stop("s2", "COMPLETED")] }));
    const { unmount } = renderWithProviders(<MyRunsPage />);
    await user.click(await screen.findByRole("button", { name: "Finish route" }));
    expect(window.confirm).toHaveBeenLastCalledWith(
      "Finish this route? Orders at skipped stops come off the route.",
    );
    unmount();

    serve(run({ status: "IN_PROGRESS", stops: [stop("s1", "COMPLETED")] }));
    renderWithProviders(<MyRunsPage />);
    await user.click(await screen.findByRole("button", { name: "Finish route" }));
    expect(window.confirm).toHaveBeenLastCalledWith("Finish this route?");
  });

  it("D-15 pin: the web app no longer carries the driver-app link", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const root = path.resolve(__dirname, "../../../..");
    expect(fs.existsSync(path.join(root, "lib/driver-app-link.ts"))).toBe(false);
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return /node_modules|\.next/.test(e.name) ? [] : walk(p);
        return /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
      });
    const hits = ["app", "components", "lib"]
      .flatMap((d) => walk(path.join(root, d)))
      .filter((f) =>
        /DRIVER_APP_LOGIN_URL|NEXT_PUBLIC_MOBILE_WEB_URL|DriverAppBanner|Finish in the app/.test(
          fs.readFileSync(f, "utf8"),
        ),
      );
    expect(hits).toEqual([]);
    // D-20: the sheet builds its request through the shared package and sends no payment.
    const sheet = fs.readFileSync(path.join(__dirname, "StopSheet.tsx"), "utf8");
    const hook = fs.readFileSync(path.join(root, "lib/api/routes.ts"), "utf8");
    expect(sheet).toContain("buildStopDeliveries,");
    expect(sheet).toContain('from "@routeflow/pricing"');
    expect(sheet).not.toMatch(/function buildStopDeliveries/);
    const completeHook = hook.slice(
      hook.indexOf("export function useCompleteStop"),
      hook.indexOf("export function useReopenStop"),
    );
    expect(completeHook).not.toMatch(/\bpayment\s*[:,}]|driver_payments/);
  });
});

/** SA-1098 A-2: the last stop's way back. The server ends the run when its last stop lands and `my-runs` stops listing it. */
describe("MyRunsPage: a run that finished itself stays for Undo (A-2, D-32, D-33)", () => {
  const openStop = (): RouteRunStop => ({
    ...stop("s1", "IN_PROGRESS"),
    orders: [
      {
        id: "o1",
        orderNumber: "SO-1",
        status: "OUT_FOR_DELIVERY",
        lineItems: [
          {
            id: "l1",
            productId: "p1",
            product: { id: "p1", name: "Napkins" },
            qty: 10,
            remaining: 10,
            status: "CONFIRMED",
            subtotal: 20,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitLabel: null,
          },
        ],
      },
    ],
  });
  const live = () => run({ status: "IN_PROGRESS", stops: [openStop()] });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, "confirm").mockReturnValue(true);
    patch.mockResolvedValue({ data: {} });
    post.mockResolvedValue({ data: {} });
  });

  it("finishedRunView marks the run COMPLETED and the stop COMPLETED, nothing else", () => {
    const view = finishedRunView(live(), "s1");
    expect(view.status).toBe("COMPLETED");
    expect(view.stops?.[0].status).toBe("COMPLETED");
    expect(view.stops?.[0].orders).toEqual(openStop().orders);
  });

  it("D-32: the last stop's completion keeps the run on the page, finished; Undo reopens it and the run returns to the list", async () => {
    let listed = true;
    serveList(() => (listed ? [live()] : []));
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);

    await user.click(await screen.findByRole("button", { name: /Shop s1/ }));
    // the server finishes the run when this lands, and the list stops carrying it
    post.mockImplementationOnce(() => {
      listed = false;
      return Promise.resolve({ data: {} });
    });
    await user.click(await screen.findByRole("button", { name: "Delivered" }));

    expect(
      await screen.findByText("Route finished. To undo a delivered or refused stop, tap it."),
    ).toBeInTheDocument();
    expect(screen.getByText("North loop")).toBeInTheDocument();
    expect(screen.queryByText("No runs scheduled for you today.")).not.toBeInTheDocument();

    // Undo from the held run: the same reopen, then the run is back in the list and the hold ends
    await user.click(await screen.findByRole("button", { name: /Shop s1/ }));
    post.mockImplementationOnce(() => {
      listed = true;
      return Promise.resolve({ data: {} });
    });
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(post).toHaveBeenLastCalledWith("/route-runs/run-1/stops/s1/reopen"));
    await waitFor(() =>
      expect(
        screen.queryByText("Route finished. To undo a delivered or refused stop, tap it."),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("North loop")).toBeInTheDocument();
  });

  it("a completion that leaves the run in the list holds nothing", async () => {
    serveList(() => [
      run({
        status: "IN_PROGRESS",
        stops: [openStop(), { ...stop("s2", "PENDING"), stopNumber: 2 }],
      }),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);

    await user.click(await screen.findByRole("button", { name: /Shop s1/ }));
    await user.click(await screen.findByRole("button", { name: "Delivered" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(2));
    expect(
      screen.queryByText("Route finished. To undo a delivered or refused stop, tap it."),
    ).not.toBeInTheDocument();
  });

  it("D-33: Finish route does not hold the run", async () => {
    let listed = true;
    serveList(() =>
      listed ? [run({ status: "IN_PROGRESS", stops: [stop("s1", "COMPLETED")] })] : [],
    );
    patch.mockImplementationOnce(() => {
      listed = false;
      return Promise.resolve({ data: {} });
    });
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);

    await user.click(await screen.findByRole("button", { name: "Finish route" }));

    expect(await screen.findByText("No runs scheduled for you today.")).toBeInTheDocument();
    expect(
      screen.queryByText("Route finished. To undo a delivered or refused stop, tap it."),
    ).not.toBeInTheDocument();
  });

  it("D-33b: a reload after a held run shows no run (the hold is in memory only)", async () => {
    let listed = true;
    serveList(() => (listed ? [live()] : []));
    const user = userEvent.setup();
    const first = renderWithProviders(<MyRunsPage />);
    await user.click(await screen.findByRole("button", { name: /Shop s1/ }));
    post.mockImplementationOnce(() => {
      listed = false;
      return Promise.resolve({ data: {} });
    });
    await user.click(await screen.findByRole("button", { name: "Delivered" }));
    await screen.findByText("Route finished. To undo a delivered or refused stop, tap it.");

    first.unmount();
    renderWithProviders(<MyRunsPage />);

    expect(await screen.findByText("No runs scheduled for you today.")).toBeInTheDocument();
    expect(
      screen.queryByText("Route finished. To undo a delivered or refused stop, tap it."),
    ).not.toBeInTheDocument();
  });
});

/** SA-1098 A-3: findings 4 and 7 (which run leads the page) and the skipped-stop Undo rows (D-49..D-51). */
describe("MyRunsPage: A-3 live run on top, earlier open runs, no Undo on a released skipped stop", () => {
  const yesterday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T00:00:00.000Z`;
  };
  const withOrder = (id: string, status: RouteRunStop["status"], n = 1): RouteRunStop => ({
    ...stop(id, status),
    stopNumber: n,
    orders: [
      {
        id: `o-${id}`,
        orderNumber: `SO-${id}`,
        status: "OUT_FOR_DELIVERY",
        lineItems: [
          {
            id: `l-${id}`,
            productId: "p1",
            product: { id: "p1", name: "Napkins" },
            qty: 10,
            remaining: 10,
            status: "CONFIRMED",
            subtotal: 20,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitLabel: null,
          },
        ],
      },
    ],
  });
  const FINISHED = "Route finished. To undo a delivered or refused stop, tap it.";
  const SKIPPED_LINE = "Skipped. Anything not delivered went back to your office.";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, "confirm").mockReturnValue(true);
    patch.mockResolvedValue({ data: {} });
    post.mockResolvedValue({ data: {} });
  });

  it("D-46: a run held for Undo does not push a run scheduled today off the top; the held run stays below with its Undo", async () => {
    let listed = true;
    const next = run({
      id: "run-2",
      route: { id: "r2", name: "South loop" },
      status: "SCHEDULED",
      stops: [stop("t1", "PENDING")],
    });
    serveList(() =>
      listed
        ? [run({ status: "IN_PROGRESS", stops: [withOrder("s1", "IN_PROGRESS")] }), next]
        : [next],
    );
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);
    await user.click(await screen.findByRole("button", { name: /Shop s1/ }));
    post.mockImplementationOnce(() => {
      listed = false;
      return Promise.resolve({ data: {} });
    });
    await user.click(await screen.findByRole("button", { name: "Delivered" }));

    const held = await screen.findByText(/Just finished: North loop/);
    // the live run leads: its Start route button is on the page and comes before the held card
    const start = await screen.findByRole("button", { name: "Start route" });
    expect(start.compareDocumentPosition(held) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the held run's stop is still one tap from Undo
    await user.click(screen.getByRole("button", { name: /Shop s1/ }));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("D-47: an IN_PROGRESS run dated yesterday leads the page with its date, and Finish route works", async () => {
    serveList(() => [
      run({ status: "IN_PROGRESS", scheduledDate: yesterday(), stops: [stop("s1", "COMPLETED")] }),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);

    expect(await screen.findByText("North loop")).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${fmtCalendarDateWithWeekday(yesterday(), "short")} · `)),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Finish route" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/route-runs/run-1/status", expect.anything()),
    );
  });

  it("D-48 (guard): a SCHEDULED run from yesterday is listed with its date; a finished run from yesterday is not shown", async () => {
    serveList(() => [
      run({
        id: "old-sched",
        route: { id: "r3", name: "Old scheduled" },
        scheduledDate: yesterday(),
      }),
      run({
        id: "old-done",
        route: { id: "r4", name: "Old finished" },
        status: "COMPLETED",
        scheduledDate: yesterday(),
      }),
    ]);
    renderWithProviders(<MyRunsPage />);

    expect(await screen.findByText("Old scheduled")).toBeInTheDocument();
    expect(screen.getByText("Earlier, still open")).toBeInTheDocument();
    expect(screen.queryByText("Old finished")).not.toBeInTheDocument();
  });

  /** A run with stop A skipped (its orders still on it) and stop B open; B's delivery finishes the run. */
  const skipAThenDeliverB = async (user: ReturnType<typeof userEvent.setup>) => {
    let listed = true;
    serveList(() =>
      listed
        ? [
            run({
              status: "IN_PROGRESS",
              stops: [withOrder("a", "SKIPPED", 1), withOrder("b", "IN_PROGRESS", 2)],
            }),
          ]
        : [],
    );
    renderWithProviders(<MyRunsPage />);
    await user.click(await screen.findByRole("button", { name: /Shop b/ }));
    post.mockImplementationOnce(() => {
      listed = false;
      return Promise.resolve({ data: {} });
    });
    await user.click(await screen.findByRole("button", { name: "Delivered" }));
    await screen.findByText(FINISHED);
  };

  it("D-49: skip A, deliver B, the run finishes: A on the held run has no Undo, says why, and no reopen can be sent", async () => {
    const user = userEvent.setup();
    await skipAThenDeliverB(user);
    post.mockClear();

    await user.click(screen.getByRole("button", { name: /Shop a/ }));

    expect(await screen.findByText(SKIPPED_LINE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("D-50: Undo B puts the run back in progress; A, with its orders released, still has no Undo", async () => {
    const user = userEvent.setup();
    await skipAThenDeliverB(user);
    // Undo B from the held run; the server answers with the run back in progress and A's orders released
    serveList(() => [
      run({
        status: "IN_PROGRESS",
        stops: [{ ...stop("a", "SKIPPED"), orders: [] }, withOrder("b", "PENDING", 2)],
      }),
    ]);
    await user.click(screen.getByRole("button", { name: /Shop b/ }));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith("/route-runs/run-1/stops/b/reopen"));
    await waitFor(() => expect(screen.queryByText(FINISHED)).not.toBeInTheDocument());

    await user.click(await screen.findByRole("button", { name: /Shop a/ }));

    expect(await screen.findByText(SKIPPED_LINE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("D-51 (guard): a delivered stop on the held run keeps Undo, and the held line reads as ruled", async () => {
    const user = userEvent.setup();
    await skipAThenDeliverB(user);
    expect(screen.getByText(FINISHED)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Shop b/ }));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("D-51b (guard): a skipped stop with its orders on a run still in progress keeps Undo", async () => {
    serveList(() => [
      run({
        status: "IN_PROGRESS",
        stops: [withOrder("a", "SKIPPED", 1), withOrder("b", "PENDING", 2)],
      }),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);
    await user.click(await screen.findByRole("button", { name: /Shop a/ }));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeEnabled();
  });
});
