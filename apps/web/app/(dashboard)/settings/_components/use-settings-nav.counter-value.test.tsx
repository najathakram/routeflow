import { renderHook } from "@testing-library/react";
import { useSettingsNav } from "./use-settings-nav";

/**
 * W58 (SA-940 note, #4034): the Counter sales row says what the BUSINESS has set, so it reads the capability, not the
 * viewer's till. A raw SUPER_ADMIN and an operator denied the till have no till, and the business's counter is still on.
 * The REAL `useCounterSaleGate` runs over a mocked capability.
 */
let mockRole = "SUPER_ADMIN";
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
let mockCounter = "optional";
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", role: mockRole } }),
  useOptionalAuth: () => ({ user: { id: "u1", role: mockRole } }),
}));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: {
      capabilities: {
        fulfilment: { counter: mockCounter, methods: ["ROUTE"], staffOpensAs: "order" },
      },
    },
  }),
}));
jest.mock("@/lib/api/my-permissions", () => ({
  ...jest.requireActual("@/lib/api/my-permissions"),
  useMyPermissions: () => ({ isLoading: false, data: { groups: mockGroups } }),
}));
const empty = () => ({ data: undefined });
jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQuery: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/addons", () => ({ useFleetAccess: () => ({ fleet: false }) }));
jest.mock("@/lib/api/fulfilment-settings", () => ({ useFulfilmentSettings: () => empty() }));
jest.mock("@/lib/api/inventory-settings", () => ({ useInventorySettings: () => empty() }));
jest.mock("@/lib/api/invoices", () => ({ useInvoiceSettings: () => empty() }));
jest.mock("@/lib/api/numbering", () => ({ useNumberingSettings: () => empty() }));
jest.mock("@/lib/api/routes", () => ({ useRouteSettings: () => empty() }));
jest.mock("@/lib/api/stripe-connect", () => ({ useStripeConnectStatus: () => empty() }));
jest.mock("@/lib/api/users", () => ({ useUsers: () => empty() }));
jest.mock("@/lib/api/product-units", () => ({ useUnitsSettingsEnabled: () => false }));

const counterRow = () =>
  renderHook(() => useSettingsNav({ isAdmin: true })).result.current.trailing["counter-sales"];

beforeEach(() => {
  mockRole = "SUPER_ADMIN";
  mockGroups = ["PRICING", "ORDERS", "FINANCE"];
  mockCounter = "optional";
});

describe("W58: the Counter sales row reads the business's setting", () => {
  it("a raw SUPER_ADMIN reads On where the counter is on", () => {
    expect(counterRow()).toBe("On");
  });

  it("an operator denied the till reads On where the counter is on", () => {
    mockRole = "OPERATOR";
    mockGroups = ["PRICING", "FINANCE"];
    expect(counterRow()).toBe("On");
  });

  it("guard: a tenant admin reads On, and Off where the counter is off", () => {
    mockRole = "TENANT_ADMIN";
    expect(counterRow()).toBe("On");
    mockCounter = "off";
    expect(counterRow()).toBe("Off");
  });

  it("guard: the row's own gate still follows the till", () => {
    expect(renderHook(() => useSettingsNav({ isAdmin: true })).result.current.counter).toBe(false);
  });
});
