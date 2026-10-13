import * as React from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { friendlySettingsError } from "@/lib/api/restrictions-settings";
import RestrictionsSettingsPage from "./page";

const mutate = jest.fn();
let role = "TENANT_ADMIN";
let settings: any;

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/restrictions-settings", () => ({
  ...jest.requireActual("@/lib/api/restrictions-settings"),
  useRestrictionsSettings: () => ({ data: settings }),
  useUpdateRestrictionsSettings: () => ({ mutate, isPending: false }),
}));
jest.mock("./_components/CustomersWithoutState", () => ({
  CustomersWithoutState: ({ canFix }: { canFix: boolean }) => (
    <div data-testid="customers-without-state-card">{canFix ? "can-fix" : "view-only"}</div>
  ),
}));

const api = (status: number, data: object) => ({ response: { status, data } });
const render = () => renderWithProviders(<RestrictionsSettingsPage />);
const SWITCH = /also block restricted products on staff orders and invoices/i;

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
  settings = { enabled: false, governingAddress: "BILLING_FIRST" };
});

describe("Selling restrictions settings page", () => {
  it("switch and address choice save through the API", () => {
    render();
    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    expect(mutate).toHaveBeenCalledWith({ enabled: true }, expect.any(Object));
    fireEvent.click(screen.getByLabelText(/shipping address first/i));
    expect(mutate).toHaveBeenLastCalledWith(
      { governingAddress: "SHIPPING_FIRST" },
      expect.any(Object),
    );
  });

  it("the switch copy says portal limits always apply (spec §3.4)", () => {
    render();
    expect(
      screen.getByText(
        "Portal limits always apply. Turn this on for legal bans your staff must not sell.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/enforce selling restrictions/i)).toBeNull();
  });

  it("(C g) turning the switch on has no refusal path: a not-ready 409 is no longer a guided state", () => {
    render();
    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    // the page registers only the two-step handler; there is no readiness refusal to render
    expect(mutate).toHaveBeenCalledTimes(1);
    mutate.mock.calls[0][1].onError(
      api(409, { code: "SELLING_RESTRICTIONS_NOT_READY", readiness: { ready: false } }),
    );
    expect(screen.queryByText(/see what to fix/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /check readiness/i })).toBeNull();
  });

  it("'enable + change the address policy' is shown as a clear two-step instruction, not a raw 400", async () => {
    render();
    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    mutate.mock.calls[0][1].onError(
      api(400, {
        code: "SELLING_RESTRICTIONS_ENABLE_AND_POLICY_TOGETHER",
        message: "raw server text",
      }),
    );
    expect(
      await screen.findByText(
        /in two steps: first change which address decides the state, then turn enforcement on/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw server text/)).toBeNull();
  });

  it("shows the customers-without-a-state card and links to Portal limits & rules", () => {
    render();
    expect(screen.getByTestId("customers-without-state-card")).toHaveTextContent("can-fix");
    expect(screen.getByRole("link", { name: /portal limits & rules/i })).toHaveAttribute(
      "href",
      "/settings/restrictions/rules",
    );
  });

  it("an operator cannot change the settings but can fix customer data (owner ruling 10-07)", () => {
    role = "OPERATOR";
    render();
    expect(screen.getByText(/only a workspace admin/i)).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByLabelText(/billing address first/i)).toBeDisabled();
    expect(screen.getByTestId("customers-without-state-card")).toHaveTextContent("can-fix");
  });
});

describe("friendlySettingsError", () => {
  it("maps the known code to copy and leaves unknown errors to the generic path", () => {
    expect(
      friendlySettingsError(api(400, { code: "SELLING_RESTRICTIONS_ENABLE_AND_POLICY_TOGETHER" })),
    ).toMatch(/two steps/i);
    expect(friendlySettingsError(api(400, { code: "SOMETHING_ELSE" }))).toBeNull();
    expect(friendlySettingsError(new Error("network"))).toBeNull();
  });
});
