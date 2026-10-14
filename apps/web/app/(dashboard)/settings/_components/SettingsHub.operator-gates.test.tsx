import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { closedOperatorGetRoutes } from "@/test-utils/closed-operator-routes";
import { SettingsHub } from "./SettingsHub";

/**
 * SA #3412 M-INT1 + M-INT2 (hub): an operator's hub neither lists nor finds an admin-only screen, and rendering it
 * never asks for a route Perms PR1 closed to operators (those answer 403; the numbering read was one).
 */
const get = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("./RouteDefaultsCard", () => ({
  RouteDefaultsCard: () => <div>route-defaults-card</div>,
}));
jest.mock("./BuyerOversellCard", () => ({ BuyerOversellCard: () => <div>oversell-card</div> }));

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: undefined });
});

describe("SettingsHub: operator (SA #3412 M-INT1/M-INT2)", () => {
  it.each(["smtp", "claude", "numbering", "migration"])("searching %s finds nothing", async (q) => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsHub isAdmin={false} />);
    await user.type(screen.getByLabelText("Search settings"), q);
    expect(screen.getByText(`No settings match “${q}”.`)).toBeInTheDocument();
  });

  it("requests no route closed to operators", async () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const closed = closedOperatorGetRoutes();
    const urls = get.mock.calls.map((c) => String(c[0]));
    const hits = urls.filter((u) => closed.some((c) => c.re.test(u)));
    expect(hits).toEqual([]);
  });
});
