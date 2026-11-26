import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import CustomerDetailPage from "./page";

// W-1487 B-7 (page level): the customer's default-terms control offers Net 7 and Net 90, accepts a typed number of days,
// and refuses 0 and 366 inline without sending anything to the api.
const get = jest.fn();
const patch = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/customers/c1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("../_components/CustomerFormModal", () => ({ CustomerFormModal: () => null }));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => false }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" }, isLoading: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: false, loading: false }),
  useRoutesAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

const customer = {
  id: "c1",
  businessName: "Acme Foods",
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ACTIVE",
  pricingTier: 3,
  user: { status: "ACTIVE" },
  addresses: [],
  defaultPaymentTerms: "",
};

const open = async () => {
  get.mockImplementation((url: string) => {
    if (url === "/customers/c1") return Promise.resolve({ data: customer });
    if (url === "/customers/c1/statement")
      return Promise.resolve({ data: { transactions: [], creditExposure: 0 } });
    if (url === "/policies") return Promise.resolve({ data: { policies: [] } });
    return Promise.resolve({ data: [] });
  });
  patch.mockResolvedValue({ data: customer });
  render(
    <Providers>
      <CustomerDetailPage />
    </Providers>,
  );
  await screen.findAllByText("Acme Foods");
  await userEvent.setup().click(await screen.findByRole("tab", { name: /special prices/i }));
  return screen.findByLabelText("Default payment terms");
};

beforeEach(() => {
  Element.prototype.scrollIntoView = jest.fn();
  get.mockReset();
  patch.mockReset();
});

describe("W-1487 B-7: the customer's default payment terms", () => {
  it("offers Net 7 and Net 90, and saving Net 7 sends that label", async () => {
    const select = await open();
    const labels = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Net 7", "Net 90", "Custom (Net N)…"]));
    await userEvent.selectOptions(select, "Net 7");
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/customers/c1", { defaultPaymentTerms: "Net 7" }),
    );
  });

  it("a typed 21 days saves Net 21; 0 and 366 are refused inline and save nothing", async () => {
    const select = await open();
    await userEvent.selectOptions(select, "Custom (Net N)…");
    const days = await screen.findByLabelText("Number of days");
    await userEvent.click(days);
    await userEvent.paste("0");
    expect(await screen.findByRole("alert")).toHaveTextContent("1 to 365");
    await userEvent.clear(days);
    await userEvent.paste("366");
    expect(screen.getByRole("alert")).toHaveTextContent("1 to 365");
    expect(patch).not.toHaveBeenCalled();
    await userEvent.clear(days);
    await userEvent.paste("21");
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/customers/c1", { defaultPaymentTerms: "Net 21" }),
    );
  });
});
