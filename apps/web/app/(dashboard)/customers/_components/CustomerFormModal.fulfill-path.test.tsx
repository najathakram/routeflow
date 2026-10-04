import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * SA-655: the form's fulfilment field is typed from the shared FulfillPath (ROUTE | SHIP | PICKUP) and no
 * longer coerces a PICKUP customer to ROUTE on save. The write API still refuses PICKUP as a
 * customer default, so a PICKUP customer's save OMITS the field (the server keeps it) instead of
 * sending ROUTE (a silent rewrite) or PICKUP (a 400).
 */
const updateMutate = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
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
  const select = screen.getByLabelText("Default fulfillment") as HTMLSelectElement;
  const shown = select.value;
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
  return { shown, payload: updateMutate.mock.calls[0][0] };
};

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal — default fulfillment round-trip", () => {
  it("a PICKUP customer is shown as PICKUP and saved WITHOUT rewriting it to ROUTE", async () => {
    const { shown, payload } = await save("PICKUP");
    expect(shown).toBe("PICKUP");
    expect(payload.fulfillPath).toBeUndefined();
  });

  it.each(["SHIP", "ROUTE"])("a %s customer round-trips unchanged", async (path) => {
    const { shown, payload } = await save(path);
    expect(shown).toBe(path);
    expect(payload.fulfillPath).toBe(path);
  });
});
