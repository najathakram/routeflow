import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * SA-1066 A-4 (M9 honoured): on an account whose default is PICKUP the save sends no path unless the clerk changed it. A stored
 * PICKUP customer still gets the picker (Ship via carrier, Pickup (counter)); picking Ship is a choice and goes out, and the
 * picker stays on screen through the pick, so the way back to Pickup (which omits the field, the server keeps PICKUP) is one
 * change away. A new customer never opens on PICKUP, so a create is unchanged.
 */
let caps: Record<string, unknown> | undefined;
const account = (over: Record<string, unknown>) => ({
  methods: ["PICKUP", "SHIP"],
  staffDefault: "PICKUP",
  staffOpensAs: "counter",
  portalMethods: [],
  portalDefault: null,
  counter: "always",
  fleet: false,
  consistent: true,
  ...over,
});
const PICKUP_SHIP = account({});
const PICKUP_ONLY = account({ methods: ["PICKUP"] });
const BOTH = account({
  methods: ["ROUTE", "SHIP"],
  staffDefault: "ROUTE",
  staffOpensAs: "order",
  counter: "off",
  fleet: true,
});
const updateMutate = jest.fn();
const createMutate = jest.fn();
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ data: caps ? { capabilities: { fulfilment: caps } } : undefined }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({
    mutate: createMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useUpdateCustomer: () => ({
    mutate: updateMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: () => <input aria-label="Street" />,
}));

const openEdit = (fulfillPath: string) =>
  renderWithProviders(
    <CustomerFormModal
      isOpen
      onClose={jest.fn()}
      mode="edit"
      initialData={{
        id: "cust-1",
        businessName: "Acme Foods",
        contactName: "Pat Lee",
        customerType: "BUSINESS",
        fulfillPath,
      }}
    />,
  );
const picker = () => screen.getByLabelText("Default fulfillment") as HTMLSelectElement;
const pick = (value: string) => fireEvent.change(picker(), { target: { value } });
const optionValues = () => Array.from(picker().options).map((o) => o.value);
const saveEdit = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
  return updateMutate.mock.calls[0][0];
};

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal: a clerk's pick on the fulfilment picker is honoured (A-4)", () => {
  it("R-A4a: pickup and ship, stored PICKUP: pick Ship, save sends SHIP", async () => {
    caps = PICKUP_SHIP;
    openEdit("PICKUP");
    pick("SHIP");
    expect((await saveEdit()).fulfillPath).toBe("SHIP");
  });

  it("R-A4b: the picker stays on screen after the pick, Ship selected, with its line", () => {
    caps = PICKUP_SHIP;
    openEdit("PICKUP");
    pick("SHIP");
    expect(picker().value).toBe("SHIP");
    expect(screen.getByText("Ships via carrier.")).toBeInTheDocument();
    expect(optionValues()).toEqual(["SHIP", "PICKUP"]);
  });

  it("R-A4c: pick Ship, then Pickup again: the way back exists and the save omits the field", async () => {
    caps = PICKUP_SHIP;
    openEdit("PICKUP");
    pick("SHIP");
    pick("PICKUP");
    expect(picker().value).toBe("PICKUP");
    expect((await saveEdit()).fulfillPath).toBeUndefined();
  });

  it("R-A4d: stored PICKUP, edit the name only: the save omits the field", async () => {
    caps = PICKUP_SHIP;
    openEdit("PICKUP");
    fireEvent.change(screen.getByLabelText(/Business name/i), { target: { value: "Acme Cafe" } });
    expect((await saveEdit()).fulfillPath).toBeUndefined();
  });

  it("R-A4e: stored ROUTE on pickup and ship: no picker, the save omits the field", async () => {
    caps = PICKUP_SHIP;
    openEdit("ROUTE");
    expect(screen.queryByLabelText("Default fulfillment")).not.toBeInTheDocument();
    expect((await saveEdit()).fulfillPath).toBeUndefined();
  });

  it("R-A4f: a new customer on pickup and ship: no picker, the create omits the field", async () => {
    caps = PICKUP_SHIP;
    renderWithProviders(
      <CustomerFormModal
        isOpen
        onClose={jest.fn()}
        mode="add"
        onCreated={jest.fn()}
        initialName="Acme Cafe"
        addressRequired={false}
      />,
    );
    expect(screen.queryByLabelText("Default fulfillment")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create Customer" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0][0].fulfillPath).toBeUndefined();
  });

  it("R-A4g: pickup-only, stored PICKUP: one option, the save omits the field", async () => {
    caps = PICKUP_ONLY;
    openEdit("PICKUP");
    expect(optionValues()).toEqual(["PICKUP"]);
    expect((await saveEdit()).fulfillPath).toBeUndefined();
  });

  it("R-A4h: delivery and ship, stored PICKUP: pick Ship, the Pickup option is still offered; back to it omits the field", async () => {
    caps = BOTH;
    openEdit("PICKUP");
    pick("SHIP");
    expect(optionValues()).toEqual(["ROUTE", "SHIP", "PICKUP"]);
    pick("PICKUP");
    expect((await saveEdit()).fulfillPath).toBeUndefined();
  });

  it("R-A4i: delivery and ship, stored ROUTE: pick Ship, the save sends SHIP", async () => {
    caps = BOTH;
    openEdit("ROUTE");
    pick("SHIP");
    expect((await saveEdit()).fulfillPath).toBe("SHIP");
  });
});
