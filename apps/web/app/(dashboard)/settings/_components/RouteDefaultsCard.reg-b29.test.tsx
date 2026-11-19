// REG-B29: "Route settings exist but can't be edited". The route defaults (service time, start time, average speed, depot) are
// returned by GET /settings/route; the card must let the user change them and PATCH them back (useUpdateRouteSettings). The wrong
// value is a read-only form: inputs that cannot be changed, or a save that sends nothing / the stale values.
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
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const SETTINGS = {
  averageSpeedKmh: 40,
  serviceTimeMinutes: 10,
  defaultStartTime: "08:00",
  depotLat: null,
  depotLng: null,
  depotAddress: "",
};

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: SETTINGS });
  patch.mockResolvedValue({ data: SETTINGS });
});

const field = (name: RegExp) => screen.findByLabelText(name) as Promise<HTMLInputElement>;

describe("REG-B29: route settings can be edited", () => {
  it("REG-B29: the three defaults are editable inputs, not read-only text", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    for (const name of [/service time/i, /start time/i, /average speed/i]) {
      const input = await field(name);
      expect(input).not.toBeDisabled();
      expect(input).not.toHaveAttribute("readonly");
    }
  });

  it("REG-B29: changing a value and saving PATCHes /settings/route with the NEW value, not the stored one", async () => {
    renderWithProviders(<RouteDefaultsCard />);
    fireEvent.change(await field(/service time/i), { target: { value: "25" } });
    fireEvent.change(await field(/start time/i), { target: { value: "06:30" } });
    fireEvent.change(await field(/average speed/i), { target: { value: "55" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [url, body] = patch.mock.calls[0];
    expect(url).toBe("/settings/route");
    expect(body).toMatchObject({
      serviceTimeMinutes: 25,
      defaultStartTime: "06:30",
      averageSpeedKmh: 55,
    });
    expect(body.serviceTimeMinutes).not.toBe(SETTINGS.serviceTimeMinutes);
  });
});
