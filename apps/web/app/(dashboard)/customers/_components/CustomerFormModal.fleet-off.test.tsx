import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

// SHIP fulfilment mode: no "Default fulfillment" picker and a NEW customer is created as SHIP. Every other
// account, including one with no fleet modules, keeps the picker and the ROUTE default exactly as before.
const mutate = jest.fn();
let ship = false;
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: ship
      ? {
          capabilities: {
            fulfilment: {
              methods: ["SHIP"],
              staffDefault: "SHIP",
              portalMethods: [],
              portalDefault: null,
              counter: "off",
              fleet: false,
            },
          },
        }
      : undefined,
  }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({ mutate, isPending: false, error: null, reset: jest.fn() }),
  useUpdateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: ({ value, onChange }: any) => (
    <input aria-label="Street" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const createCustomer = async () => {
  renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
  fireEvent.change(screen.getByLabelText(/^Business Name/), { target: { value: "Acme Foods" } });
  fireEvent.change(screen.getByLabelText(/^Contact Name/), { target: { value: "Pat Lee" } });
  fireEvent.change(screen.getByLabelText("Street"), { target: { value: "1 Main St" } });
  fireEvent.change(screen.getByPlaceholderText("Austin"), { target: { value: "Austin" } });
  fireEvent.change(screen.getByPlaceholderText("78701"), { target: { value: "78701" } });
  fireEvent.click(screen.getByRole("button", { name: /create customer/i }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  return mutate.mock.calls[0][0];
};

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal — default fulfillment (SHIP mode)", () => {
  it("ship mode: no Default fulfillment select, and the customer is created as SHIP", async () => {
    ship = true;
    const payload = await createCustomer();
    expect(screen.queryByLabelText("Default fulfillment")).not.toBeInTheDocument();
    expect(payload.fulfillPath).toBe("SHIP");
  });

  it("not ship mode (today's UI, unchanged): the select is there and the default is ROUTE", async () => {
    ship = false;
    const payload = await createCustomer();
    expect(screen.getByLabelText("Default fulfillment")).toBeInTheDocument();
    expect(payload.fulfillPath).toBe("ROUTE");
  });
});
