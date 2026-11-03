import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { RECURRING_ROUTES_ADDON } from "@routeflow/types";
import MyRunsPage, { finishRouteBlocker } from "./page";
import type { RouteRun, RouteRunStop } from "@/lib/api/routes";

const get = jest.fn();
const patch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a), patch: (...a: unknown[]) => patch(...a) },
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
const serve = (r: RouteRun) =>
  get.mockImplementation((url: string) =>
    url === "/tenants/me/addons"
      ? Promise.resolve({ data: { addons: [RECURRING_ROUTES_ADDON] } })
      : Promise.resolve({
          data: { data: [r], meta: { total: 1, page: 1, limit: 100, totalPages: 1 } },
        }),
  );

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

  it("a refusal on Finish route shows the server's words and changes nothing else", async () => {
    serve(run({ status: "IN_PROGRESS", stops: [stop("s1", "SKIPPED")] }));
    patch.mockRejectedValueOnce({
      response: { status: 409, data: { message: "Settle the cash first." } },
    });
    const user = userEvent.setup();
    renderWithProviders(<MyRunsPage />);

    await user.click(await screen.findByRole("button", { name: "Finish route" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Settle the cash first.");
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
