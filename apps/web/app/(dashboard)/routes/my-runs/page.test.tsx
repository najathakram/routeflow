import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { RECURRING_ROUTES_ADDON } from "@routeflow/types";
import MyRunsPage from "./page";

const get = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a), patch: jest.fn() },
}));

let authUser: { role: string; canActAsDriver?: boolean } = { role: "OPERATOR" };
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: authUser }),
}));

let driveModeOn = false;
const setDriveMode = jest.fn((on: boolean) => {
  driveModeOn = on;
});
jest.mock("@/lib/drive-mode", () => ({
  useDriveMode: () => ({ driveMode: driveModeOn, setDriveMode, toggle: jest.fn() }),
}));

jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));

const EMPTY_RUNS = { data: [], meta: { total: 0, page: 1, limit: 100, totalPages: 0 } };

/** GET router: the tenant-addons read answers `addons()`; everything else answers `runs()`. */
function routeGets(
  addons: () => Promise<unknown>,
  runs: () => Promise<unknown> = () => Promise.resolve(EMPTY_RUNS),
) {
  get.mockImplementation((url: string) =>
    url === "/tenants/me/addons" ? addons().then((a) => ({ data: a })) : runs(),
  );
}
const forbidden = () => Promise.reject({ response: { status: 403 } });

/**
 * PHASE 1a — red-first pins:
 *  1. A DRIVER (no canActAsDriver) reaches the field-layout my-runs view via
 *     GET /route-runs/my-runs, not the pre-existing gate message.
 *  2. The pre-existing canActAsDriver (dual-role operator) path is unchanged:
 *     still GET /route-runs?assignedToMe=true, still has an Exit-drive-mode
 *     button once in field layout.
 *  3. A plain OPERATOR (neither DRIVER nor canActAsDriver) still sees the
 *     "ask your admin" gate message, byte-identical to before.
 */
describe("MyRunsPage — PHASE 1a (driver-mode 1a) role gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    driveModeOn = false;
    get.mockResolvedValue(EMPTY_RUNS);
    routeGets(() => Promise.resolve({ addons: [RECURRING_ROUTES_ADDON] }));
  });

  it("REG-1a: a DRIVER role reaches the field-layout view via GET /route-runs/my-runs", async () => {
    authUser = { role: "DRIVER" };
    renderWithProviders(<MyRunsPage />);

    await waitFor(() => {
      expect(get).toHaveBeenCalledWith("/route-runs/my-runs");
    });
    expect(
      screen.queryByText(/only available to operators who can also act as drivers/i),
    ).not.toBeInTheDocument();
    // No "Exit drive mode" — a pure driver has no operator view to return to.
    expect(screen.queryByText("Exit drive mode")).not.toBeInTheDocument();
  });

  it("REG-1a: a DRIVER never calls the operator's /route-runs?assignedToMe endpoint", async () => {
    authUser = { role: "DRIVER" };
    renderWithProviders(<MyRunsPage />);

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get).not.toHaveBeenCalledWith("/route-runs", expect.anything());
  });

  it("REG-1a: canActAsDriver (dual-role operator) keeps the pre-existing assignedToMe query", async () => {
    authUser = { role: "OPERATOR", canActAsDriver: true };
    driveModeOn = true; // field layout, so the exit button is present to assert on
    renderWithProviders(<MyRunsPage />);

    await waitFor(() => {
      expect(get).toHaveBeenCalledWith(
        "/route-runs",
        expect.objectContaining({ params: { assignedToMe: true, limit: 100 } }),
      );
    });
    expect(get).not.toHaveBeenCalledWith("/route-runs/my-runs");
    // The pre-existing dual-role toggle is untouched.
    expect(await screen.findByText("Exit drive mode")).toBeInTheDocument();
  });

  it("REG-1a: a plain OPERATOR (neither DRIVER nor canActAsDriver) still sees the gate message", async () => {
    authUser = { role: "OPERATOR" };
    renderWithProviders(<MyRunsPage />);

    expect(
      await screen.findByText(/only available to operators who can also act as drivers/i),
    ).toBeInTheDocument();
    // No runs read at all. The only GET is the shared tenant-add-ons read (#2145),
    // which the dashboard layout already makes for every user; react-query dedupes it.
    expect(get.mock.calls.map((c) => c[0])).toEqual(["/tenants/me/addons"]);
  });
});

/**
 * #2145 — a DRIVER whose tenant has neither the routes nor the delivery add-on is
 * bounced to /dashboard by RouteGuard once the add-ons read resolves. Until then,
 * and during that bounce, the page must never fire the 403-ing my-runs read or
 * render its "Failed to load" error. It fails open on an add-ons error, like RouteGuard.
 */
describe("MyRunsPage — #2145 no 403 flash for a driver without the routes add-on", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    driveModeOn = false;
    authUser = { role: "DRIVER" };
  });

  it("add-ons resolved without routes or delivery: no my-runs read, no error render", async () => {
    routeGets(() => Promise.resolve({ addons: [] }), forbidden);
    renderWithProviders(<MyRunsPage />);

    await new Promise((r) => setTimeout(r, 50));
    expect(get).not.toHaveBeenCalledWith("/route-runs/my-runs");
    expect(screen.queryByText(/failed to load data/i)).not.toBeInTheDocument();
  });

  it("add-ons still loading: holds the loading state, no my-runs read", async () => {
    routeGets(() => new Promise(() => {}), forbidden);
    renderWithProviders(<MyRunsPage />);

    await new Promise((r) => setTimeout(r, 50));
    expect(get).not.toHaveBeenCalledWith("/route-runs/my-runs");
    expect(screen.queryByText(/failed to load data/i)).not.toBeInTheDocument();
  });

  it("add-ons read failed: fails open and loads the driver's runs", async () => {
    routeGets(() => Promise.reject(new Error("addons 500")));
    renderWithProviders(<MyRunsPage />);

    await waitFor(() => expect(get).toHaveBeenCalledWith("/route-runs/my-runs"));
  });
});

/**
 * B966: a pure DRIVER cannot reach /orders (RouteGuard DRIVER_ALLOWED has no /orders, so it
 * bounces them to /dashboard), so the hero card's "Scan to add order" link is a dead end for
 * them. It is hidden for a pure DRIVER only; staff (and a dual-role operator in drive mode) keep it.
 */
describe("MyRunsPage — B966 'Scan to add order' is hidden for a pure DRIVER", () => {
  const todayISO = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const TODAY_RUN = {
    id: "run-1",
    scheduledDate: todayISO(),
    status: "SCHEDULED",
    route: { name: "North loop" },
    stops: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    driveModeOn = false;
    routeGets(
      () => Promise.resolve({ addons: [RECURRING_ROUTES_ADDON] }),
      () => Promise.resolve({ data: { data: [TODAY_RUN], meta: EMPTY_RUNS.meta } }),
    );
  });

  it("a DRIVER sees the run card and 'Open full run' but NOT 'Scan to add order'", async () => {
    authUser = { role: "DRIVER" };
    renderWithProviders(<MyRunsPage />);

    expect(await screen.findByText("Open full run")).toBeInTheDocument();
    expect(screen.queryByText("Scan to add order")).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/orders?action=new"]')).toBeNull();
  });

  it("a dual-role OPERATOR (canActAsDriver) in drive mode keeps 'Scan to add order'", async () => {
    authUser = { role: "OPERATOR", canActAsDriver: true };
    driveModeOn = true;
    renderWithProviders(<MyRunsPage />);

    expect(await screen.findByText("Scan to add order")).toBeInTheDocument();
    expect(screen.getByText("Open full run")).toBeInTheDocument();
  });

  it("a TENANT_ADMIN who can act as a driver, in drive mode, keeps 'Scan to add order'", async () => {
    authUser = { role: "TENANT_ADMIN", canActAsDriver: true };
    driveModeOn = true;
    renderWithProviders(<MyRunsPage />);

    expect(await screen.findByText("Scan to add order")).toBeInTheDocument();
  });
});
