import * as React from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { friendlySettingsError } from "@/lib/api/restrictions-settings";
import RestrictionsSettingsPage from "./page";

const mutate = jest.fn();
const refetch = jest.fn();
let role = "TENANT_ADMIN";
let settings: any;
let check: any;

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/restrictions-settings", () => ({
  ...jest.requireActual("@/lib/api/restrictions-settings"),
  useRestrictionsSettings: () => ({ data: settings }),
  useRestrictionsReadiness: () => ({
    refetch,
    isFetching: false,
    isError: false,
    data: undefined,
    ...check,
  }),
  useUpdateRestrictionsSettings: () => ({ mutate, isPending: false }),
}));

const READY = {
  ready: true,
  truncated: false,
  customerCount: 3,
  customersWithoutAddress: 0,
  customersAmbiguousNoDefault: 0,
  addressesMissingStateCode: 0,
  addressesNeedingReview: 0,
  indeterminateCustomerCount: 0,
  businessStateMissing: false,
};
const api = (status: number, data: object) => ({ response: { status, data } });
const render = () => renderWithProviders(<RestrictionsSettingsPage />);

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
  settings = { enabled: false, governingAddress: "BILLING_FIRST" };
  check = {};
});

describe("Selling restrictions settings page", () => {
  it("switch and address choice save through the API", () => {
    render();
    fireEvent.click(screen.getByRole("switch", { name: /enforce selling restrictions/i }));
    expect(mutate).toHaveBeenCalledWith({ enabled: true }, expect.any(Object));
    fireEvent.click(screen.getByLabelText(/shipping address first/i));
    expect(mutate).toHaveBeenLastCalledWith(
      { governingAddress: "SHIPPING_FIRST" },
      expect.any(Object),
    );
  });

  it("a 409 not-ready refusal lists exactly what to fix, in plain language", () => {
    render();
    fireEvent.click(screen.getByRole("switch"));
    mutate.mock.calls[0][1].onError(
      api(409, {
        code: "SELLING_RESTRICTIONS_NOT_READY",
        readiness: {
          ...READY,
          ready: false,
          customersWithoutAddress: 2,
          addressesMissingStateCode: 5,
        },
      }),
    );
    return screen.findByText(/2 customer\(s\) have no address/).then(() => {
      expect(screen.getByText(/5 address\(es\) have no usable state/)).toBeInTheDocument();
      expect(screen.queryByText(/need a state review/)).toBeNull();
    });
  });

  it("a missing business state is the one actionable line, and says where to add it (CQ-04)", async () => {
    render();
    fireEvent.click(screen.getByRole("switch"));
    mutate.mock.calls[0][1].onError(
      api(409, {
        code: "SELLING_RESTRICTIONS_NOT_READY",
        readiness: { ...READY, ready: false, businessStateMissing: true },
      }),
    );
    expect(
      await screen.findByText(
        "Add your business address in Settings \u203a Business so counter sales can check state rules.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/have no address/)).toBeNull();
  });

  it("'enable + change the address policy' is shown as a clear two-step instruction, not a raw 400", async () => {
    render();
    fireEvent.click(screen.getByRole("switch"));
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

  it("'Check readiness' runs the sweep on demand and shows the ready state", () => {
    check = { data: READY };
    render();
    expect(refetch).not.toHaveBeenCalled(); // never automatic
    fireEvent.click(screen.getByRole("button", { name: /check readiness/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(/ready/i);
  });

  it("a throttled check (429) says to wait, in plain language", () => {
    check = { isError: true, error: api(429, {}) };
    render();
    expect(screen.getByRole("alert")).toHaveTextContent(/wait a minute and try again/i);
  });

  it("is read-only for a non-admin", () => {
    role = "OPERATOR";
    render();
    expect(screen.getByText(/only a workspace admin/i)).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByLabelText(/billing address first/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /check readiness/i })).toBeNull();
  });
});

describe("friendlySettingsError", () => {
  it("maps known codes/statuses to copy and leaves unknown errors to the generic path", () => {
    expect(
      friendlySettingsError(api(400, { code: "SELLING_RESTRICTIONS_ENABLE_AND_POLICY_TOGETHER" })),
    ).toMatch(/two steps/i);
    expect(friendlySettingsError(api(429, {}))).toMatch(/too many/i);
    expect(friendlySettingsError(api(400, { code: "SOMETHING_ELSE" }))).toBeNull();
    expect(friendlySettingsError(new Error("network"))).toBeNull();
  });
});
