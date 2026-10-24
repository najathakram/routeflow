import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { RouteDefaultsCard } from "./RouteDefaultsCard";

const get = jest.fn();
const patch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const SETTINGS = {
  averageSpeedKmh: 40,
  serviceTimeMinutes: 10,
  defaultStartTime: "08:00",
  depotLat: 33.9,
  depotLng: -118.2,
  depotAddress: "",
};

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: SETTINGS });
  patch.mockResolvedValue({ data: SETTINGS });
});

const field = (name: RegExp) => screen.findByLabelText(name) as Promise<HTMLInputElement>;

describe("RouteDefaultsCard", () => {
  it("shows a loading state", () => {
    get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<RouteDefaultsCard />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the current values", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    expect((await field(/service time/i)).value).toBe("10");
    expect((await field(/start time/i)).value).toBe("08:00");
    expect((await field(/average speed/i)).value).toBe("40");
  });

  it("shows the current depot as context, never prefilled as typed input", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    expect((await field(/depot latitude/i)).value).toBe("");
    expect((await field(/depot longitude/i)).value).toBe("");
    expect(screen.getByText(/currently start from 33\.9, -118\.2/i)).toBeInTheDocument();
  });

  it("shows the SAVED coordinates even when GET also returns the business address", async () => {
    // GET always fills depotAddress from the business address, but routing uses the saved
    // route.defaultDepotLat/Lng first — the card must say where routes really start.
    get.mockResolvedValue({ data: { ...SETTINGS, depotAddress: "1 Main St, Springfield" } });
    renderWithProviders(<RouteDefaultsCard />);
    await field(/depot latitude/i);
    expect(screen.getByText(/currently start from 33\.9, -118\.2/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 main st/i)).not.toBeInTheDocument();
  });

  it("falls back to the business address only when no depot is saved", async () => {
    get.mockResolvedValue({
      data: { ...SETTINGS, depotLat: null, depotLng: null, depotAddress: "1 Main St, Springfield" },
    });
    renderWithProviders(<RouteDefaultsCard />);
    await field(/depot latitude/i);
    expect(screen.getByText(/currently start from 1 main st, springfield/i)).toBeInTheDocument();
  });

  it("says no depot is set when there is none", async () => {
    get.mockResolvedValue({ data: { ...SETTINGS, depotLat: null, depotLng: null } });
    renderWithProviders(<RouteDefaultsCard />);
    await field(/depot latitude/i);
    expect(screen.getByText(/no depot is set yet/i)).toBeInTheDocument();
  });

  it("blocks save on an out-of-range service time", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    fireEvent.change(await field(/service time/i), { target: { value: "121" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/0 and 120/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("blocks save on a bad start time and bad speed", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    fireEvent.change(await field(/start time/i), { target: { value: "25:00" } });
    fireEvent.change(await field(/average speed/i), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/HH:MM/i)).toBeInTheDocument();
    expect(screen.getByText(/1 and 200/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("blocks save when only one of lat/lng is set", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    fireEvent.change(await field(/depot latitude/i), { target: { value: "34.05" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/both latitude and longitude/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("blocks save on out-of-range coordinates", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    fireEvent.change(await field(/depot latitude/i), { target: { value: "91" } });
    fireEvent.change(await field(/depot longitude/i), { target: { value: "-181" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/-90 and 90/i)).toBeInTheDocument();
    expect(screen.getByText(/-180 and 180/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("PATCHes numbers and shows a saved toast", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    fireEvent.change(await field(/service time/i), { target: { value: "15" } });
    fireEvent.change(await field(/depot latitude/i), { target: { value: "34.05" } });
    fireEvent.change(await field(/depot longitude/i), { target: { value: "-118.2" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/route", {
        serviceTimeMinutes: 15,
        defaultStartTime: "08:00",
        averageSpeedKmh: 40,
        depotLat: 34.05,
        depotLng: -118.2,
      }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" })),
    );
  });

  it("keeps an existing depot when both fields are left blank (no depot keys sent)", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    await field(/depot latitude/i);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    // Load flake (row 272): passes alone but timed out on a saturated shared host, so the wait and
    // the test budget are generous. Wait budget only; the assertions are unchanged.
    await waitFor(() => expect(patch).toHaveBeenCalled(), { timeout: 20_000 });
    expect(patch.mock.calls[0][1]).not.toHaveProperty("depotLat");
    expect(patch.mock.calls[0][1]).not.toHaveProperty("depotLng");
  }, 60_000);

  it("toasts an error when the save fails", async () => {
    patch.mockRejectedValue(new Error("nope"));
    renderWithProviders(<RouteDefaultsCard />);
    await field(/service time/i);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error" })),
    );
  });

  it("is read-only with a retry when the GET fails", async () => {
    get.mockRejectedValueOnce(new Error("403"));
    renderWithProviders(<RouteDefaultsCard />);
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect((await field(/service time/i)).value).toBe("10");
  });
});
