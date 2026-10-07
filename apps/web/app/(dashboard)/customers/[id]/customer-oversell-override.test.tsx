import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CustomerOversellOverride, OVERRIDE_COPY } from "./customer-oversell-override";
import { customerOversellView } from "@/lib/api/customer-oversell";

/**
 * A customer's own out-of-stock-ordering setting: the CUSTOMER row of `orders.buyerOversell`.
 * No row = inherit (the business setting). A TENANT_ADMIN edits (allow = PUT value "backorder",
 * deny = PUT value "off", inherit = DELETE); an operator reads. A customer setting that differs
 * from the business setting is called out. Fail-closed: no select until the policies have loaded.
 */
const CUSTOMER = "cust-1";
const policiesQuery = jest.fn();
const mutate = jest.fn();
const toast = jest.fn();
let role = "TENANT_ADMIN";

jest.mock("@/lib/api/customer-oversell", () => ({
  ...jest.requireActual("@/lib/api/customer-oversell"),
  usePolicies: () => policiesQuery(),
  useSetCustomerOversell: () => ({ mutate, isPending: false }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const row = (scopeType: string, value: unknown, scopeId: string | null = null) => ({
  id: `${scopeType}-${scopeId}`,
  key: "orders.buyerOversell",
  scopeType,
  scopeId,
  value,
});
const policies = (active: unknown[], dflt: unknown = "off") => ({
  policies: [{ key: "orders.buyerOversell", default: dflt, active }],
});
const loaded = (active: unknown[] = [], dflt: unknown = "off") =>
  policiesQuery.mockReturnValue({
    data: policies(active, dflt),
    isLoading: false,
    isError: false,
  });
const select = () => screen.getByLabelText(OVERRIDE_COPY.title) as HTMLSelectElement;

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
});

describe("customerOversellView (pure)", () => {
  it("no rows = inherit; the business default is deny", () => {
    expect(customerOversellView(policies([]) as never, CUSTOMER)).toEqual({
      tenant: "deny",
      override: "inherit",
      differs: false,
    });
  });

  it('only the exact value "backorder" is allow, for the tenant and for the customer', () => {
    const v = customerOversellView(
      policies([row("TENANT", "backorder"), row("CUSTOMER", "yes", CUSTOMER)]) as never,
      CUSTOMER,
    );
    expect(v).toEqual({ tenant: "allow", override: "deny", differs: true });
  });

  it("another customer's row never applies; an override equal to the business setting does not differ", () => {
    expect(
      customerOversellView(policies([row("CUSTOMER", "backorder", "other")]) as never, CUSTOMER)
        ?.override,
    ).toBe("inherit");
    expect(
      customerOversellView(
        policies([row("TENANT", "backorder"), row("CUSTOMER", "backorder", CUSTOMER)]) as never,
        CUSTOMER,
      )?.differs,
    ).toBe(false);
  });

  it("nothing to read (no policy entry) is null", () => {
    expect(customerOversellView(undefined, CUSTOMER)).toBeNull();
    expect(customerOversellView({ policies: [] } as never, CUSTOMER)).toBeNull();
  });
});

describe("CustomerOversellOverride", () => {
  it("no customer row shows inherit and the business setting", () => {
    loaded();
    renderWithProviders(<CustomerOversellOverride customerId={CUSTOMER} />);
    expect(select().value).toBe("inherit");
    expect(screen.getByText(OVERRIDE_COPY.tenant("deny"))).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("an override that differs from the business setting is called out", () => {
    loaded([row("CUSTOMER", "backorder", CUSTOMER)], "off");
    renderWithProviders(<CustomerOversellOverride customerId={CUSTOMER} />);
    expect(select().value).toBe("allow");
    expect(screen.getByRole("note")).toHaveTextContent(OVERRIDE_COPY.differs("allow", "deny"));
  });

  it.each([
    ["allow", "allow"],
    ["deny", "deny"],
    ["inherit", "inherit"],
  ])("choosing %s sends exactly { customerId, override: %s }", (choice, expected) => {
    loaded(choice === "inherit" ? [row("CUSTOMER", "off", CUSTOMER)] : []);
    renderWithProviders(<CustomerOversellOverride customerId={CUSTOMER} />);
    fireEvent.change(select(), { target: { value: choice } });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toStrictEqual({ customerId: CUSTOMER, override: expected });
  });

  it("a failed save toasts FIXED copy, never the server's text", () => {
    loaded();
    renderWithProviders(<CustomerOversellOverride customerId={CUSTOMER} />);
    fireEvent.change(select(), { target: { value: "allow" } });
    mutate.mock.calls[0][1].onError(new Error("policy value failed schema validation"));
    expect(toast).toHaveBeenLastCalledWith({ variant: "error", title: OVERRIDE_COPY.saveFailed });
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/schema validation/);
  });

  it("an operator reads the setting: text, no select, nothing sent", () => {
    role = "OPERATOR";
    loaded([row("CUSTOMER", "backorder", CUSTOMER)]);
    renderWithProviders(<CustomerOversellOverride customerId={CUSTOMER} />);
    expect(screen.queryByLabelText(OVERRIDE_COPY.title)).not.toBeInTheDocument();
    expect(screen.getByText(OVERRIDE_COPY.allow)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("while loading, or when the load failed, there is NO select (fail-closed)", () => {
    policiesQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { unmount } = renderWithProviders(<CustomerOversellOverride customerId={CUSTOMER} />);
    expect(screen.queryByLabelText(OVERRIDE_COPY.title)).not.toBeInTheDocument();
    unmount();

    policiesQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderWithProviders(<CustomerOversellOverride customerId={CUSTOMER} />);
    expect(screen.queryByLabelText(OVERRIDE_COPY.title)).not.toBeInTheDocument();
    expect(screen.getByText(OVERRIDE_COPY.loadFailed)).toBeInTheDocument();
  });
});
