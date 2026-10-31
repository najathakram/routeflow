import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * Two rules meet in the customer form's fulfilment field (master's SA-655 + the fleet-off capability
 * preselect). A PICKUP customer is shown as PICKUP and saved WITHOUT the field, on EVERY account; a ROUTE /
 * SHIP customer's save goes through the account's capability preselect (a ship-only account never submits
 * ROUTE). Picking either rule alone breaks one half of this file.
 */
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

const save = async (fulfillPath: string) => {
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
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
  return updateMutate.mock.calls[0][0];
};

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal — PICKUP omission AND capability preselect, together", () => {
  it("ship-only account, PICKUP customer: shown as PICKUP (the picker appears for it) and saved without the field", async () => {
    caps = account({});
    const payload = await save("PICKUP");
    expect((screen.getByLabelText("Default fulfillment") as HTMLSelectElement).value).toBe(
      "PICKUP",
    );
    expect(screen.getByRole("option", { name: "Pickup (counter)" })).toBeInTheDocument();
    expect(payload.fulfillPath).toBeUndefined();
  });

  it("ship-only account, legacy ROUTE customer: no picker, and the save sends SHIP (never ROUTE)", async () => {
    caps = account({});
    const payload = await save("ROUTE");
    expect(screen.queryByLabelText("Default fulfillment")).not.toBeInTheDocument();
    expect(payload.fulfillPath).toBe("SHIP");
  });

  it("delivery + ship account: PICKUP is shown and omitted; ROUTE and SHIP round-trip", async () => {
    caps = account({ methods: ["ROUTE", "SHIP"], staffDefault: "ROUTE", fleet: true });
    expect((await save("PICKUP")).fulfillPath).toBeUndefined();
    expect((screen.getByLabelText("Default fulfillment") as HTMLSelectElement).value).toBe(
      "PICKUP",
    );
  });

  it.each(["ROUTE", "SHIP"])("delivery + ship account: a %s customer round-trips", async (path) => {
    caps = account({ methods: ["ROUTE", "SHIP"], staffDefault: "ROUTE", fleet: true });
    expect((await save(path)).fulfillPath).toBe(path);
  });

  it("pickup + ship account: a PICKUP customer is still omitted, a SHIP customer stays SHIP", async () => {
    caps = account({ methods: ["PICKUP", "SHIP"], staffDefault: "PICKUP", counter: "always" });
    expect((await save("PICKUP")).fulfillPath).toBeUndefined();
  });
});

/**
 * SA-1066 M9 (A-1): a pickup, or pickup and ship, business defaults to PICKUP, which the form cannot hold, so every save used to
 * turn it into SHIP, on a new customer and on an edit of a ROUTE one, with no picker to show it. The save now carries no path:
 * a create is stored as ROUTE (no preference), an update keeps what is stored.
 */
describe("CustomerFormModal — a pickup-default account never saves SHIP by accident (M9)", () => {
  const create = async () => {
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create Customer" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    return createMutate.mock.calls[0][0];
  };

  it("R15: a new customer on a pickup and ship business: no fulfillPath in the body", async () => {
    caps = account({ methods: ["PICKUP", "SHIP"], staffDefault: "PICKUP", counter: "always" });
    const payload = await create();
    expect(payload.fulfillPath).toBeUndefined();
  });

  it("R15a: a new customer on a pickup-only business: no fulfillPath in the body", async () => {
    caps = account({ methods: ["PICKUP"], staffDefault: "PICKUP", counter: "always" });
    expect((await create()).fulfillPath).toBeUndefined();
  });

  it("R15b: editing a ROUTE customer on a pickup and ship business: the PATCH carries no fulfillPath", async () => {
    caps = account({ methods: ["PICKUP", "SHIP"], staffDefault: "PICKUP", counter: "always" });
    expect((await save("ROUTE")).fulfillPath).toBeUndefined();
  });

  it("R15c: editing a SHIP customer on a pickup and ship business: no fulfillPath, so SHIP stays", async () => {
    caps = account({ methods: ["PICKUP", "SHIP"], staffDefault: "PICKUP", counter: "always" });
    expect((await save("SHIP")).fulfillPath).toBeUndefined();
  });

  it("R15f: a PICKUP customer's edit is omitted, as before", async () => {
    caps = account({ methods: ["PICKUP", "SHIP"], staffDefault: "PICKUP", counter: "always" });
    expect((await save("PICKUP")).fulfillPath).toBeUndefined();
  });

  it("R15e: a ship-only account is as before (a ROUTE customer saves SHIP)", async () => {
    caps = account({});
    expect((await save("ROUTE")).fulfillPath).toBe("SHIP");
  });

  it("R15e: a delivery + ship account is as before (a ROUTE customer saves ROUTE)", async () => {
    caps = account({ methods: ["ROUTE", "SHIP"], staffDefault: "ROUTE", fleet: true });
    expect((await save("ROUTE")).fulfillPath).toBe("ROUTE");
  });
});
