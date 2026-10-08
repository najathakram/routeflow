import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

// SHIP fulfilment mode: no "Default fulfillment" picker and a NEW customer is created as SHIP. Every other
// account, including one with no fleet modules, keeps the picker and the ROUTE default exactly as before.
const mutate = jest.fn();
// `caps` = the account's capabilities.fulfilment (undefined = UNSET: loading, an older API, no mode set).
let caps: Record<string, unknown> | undefined;
const account = (over: Record<string, unknown>) => ({
  methods: ["SHIP"],
  staffDefault: "SHIP",
  staffOpensAs: "order",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: false,
  consistent: true,
  ...over,
});
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ data: caps ? { capabilities: { fulfilment: caps } } : undefined }),
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

describe("CustomerFormModal — default fulfillment", () => {
  it("ship mode: no Default fulfillment select, and the customer is created as SHIP", async () => {
    caps = account({});
    const payload = await createCustomer();
    expect(screen.queryByLabelText("Default fulfillment")).not.toBeInTheDocument();
    expect(payload.fulfillPath).toBe("SHIP");
  });

  it("not set (today's UI, unchanged): the select is there and the default is ROUTE", async () => {
    caps = undefined;
    const payload = await createCustomer();
    expect(screen.getByLabelText("Default fulfillment")).toBeInTheDocument();
    expect(payload.fulfillPath).toBe("ROUTE");
  });

  it("F-c: pickup mode (PICKUP is not a form value yet) falls back to SHIP and never submits PICKUP", async () => {
    caps = account({ methods: ["PICKUP"], staffDefault: "PICKUP", counter: "always" });
    const payload = await createCustomer();
    expect(screen.queryByLabelText("Default fulfillment")).not.toBeInTheDocument();
    expect(payload.fulfillPath).toBe("SHIP");
  });

  it("F-c: pickup_ship offers only the methods it has (no 'Delivery route'), default SHIP", async () => {
    caps = account({ methods: ["PICKUP", "SHIP"], staffDefault: "PICKUP", counter: "always" });
    const payload = await createCustomer();
    expect(payload.fulfillPath).toBe("SHIP");
    expect(screen.queryByRole("option", { name: "Delivery route" })).not.toBeInTheDocument();
  });

  it("a delivery + ship account (both) offers both choices", async () => {
    caps = account({
      methods: ["ROUTE", "SHIP"],
      staffDefault: "ROUTE",
      portalMethods: ["ROUTE", "SHIP"],
      fleet: true,
    });
    await createCustomer();
    expect(screen.getByRole("option", { name: "Delivery route" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ship via carrier" })).toBeInTheDocument();
  });

  it("F-a: consistent=false (delivery mode whose fleet is gone) keeps today's ROUTE/SHIP picker and ROUTE", async () => {
    caps = account({ methods: ["ROUTE"], staffDefault: "ROUTE", fleet: false, consistent: false });
    const payload = await createCustomer();
    expect(screen.getByLabelText("Default fulfillment")).toBeInTheDocument();
    expect(payload.fulfillPath).toBe("ROUTE");
  });
});
