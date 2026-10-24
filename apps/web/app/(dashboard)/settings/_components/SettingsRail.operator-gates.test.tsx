import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { closedOperatorGetRoutes } from "@/test-utils/closed-operator-routes";
import { SettingsRail } from "./SettingsRail";

/**
 * SA #3412 M-INT1 + M-INT2 (rail): the rail reads the same index as the hub, so an operator's rail neither finds an
 * admin-only screen nor asks for a route Perms PR1 closed to operators.
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
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams("tab=invoicing"),
}));

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: undefined });
});

describe("SettingsRail: operator (SA #3412 M-INT1/M-INT2)", () => {
  it.each(["smtp", "claude", "numbering", "migration"])("searching %s finds nothing", async (q) => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsRail isAdmin={false} />);
    await user.type(screen.getByLabelText("Search settings"), q);
    expect(screen.getByText(`No settings match “${q}”.`)).toBeInTheDocument();
  });

  it("requests no route closed to operators", async () => {
    renderWithProviders(<SettingsRail isAdmin={false} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const closed = closedOperatorGetRoutes();
    const hits = get.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => closed.some((c) => c.re.test(u)));
    expect(hits).toEqual([]);
  });
});
