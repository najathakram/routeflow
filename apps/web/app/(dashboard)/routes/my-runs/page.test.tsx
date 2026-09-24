import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
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
    expect(get).not.toHaveBeenCalled();
  });
});
