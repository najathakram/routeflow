import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * #3206 follow-up: the edit form can CLEAR salutation / first name / last name. `|| undefined` made an
 * emptied field a silent no-op, so the old value stayed. A value the form loaded and the admin emptied
 * is sent as an explicit null (the API stores null); a field that was already empty is left out.
 */
const update = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useUpdateCustomer: () => ({ mutate: update, isPending: false, error: null, reset: jest.fn() }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: ({ value, onChange }: any) => (
    <input aria-label="Street" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const individual = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  businessName: "Jane Doe",
  contactName: "Jane Doe",
  customerType: "INDIVIDUAL",
  salutation: "Dr.",
  firstName: "Jane",
  lastName: "Doe",
  ...over,
});

const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: /save|update/i }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  return update.mock.calls[0][0];
};

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal — clearing name fields on edit (#3206 follow-up)", () => {
  it("an emptied salutation is sent as null, so the stored one is removed", async () => {
    renderWithProviders(
      <CustomerFormModal isOpen onClose={jest.fn()} mode="edit" initialData={individual()} />,
    );
    fireEvent.change(screen.getByLabelText("Salutation"), { target: { value: "" } });
    const payload = await save();
    expect(payload.salutation).toBeNull();
    expect(payload.firstName).toBe("Jane");
    expect(payload.lastName).toBe("Doe");
  });

  it("a salutation that was already empty is left out (an edit never writes a field it never saw)", async () => {
    renderWithProviders(
      <CustomerFormModal
        isOpen
        onClose={jest.fn()}
        mode="edit"
        initialData={individual({ salutation: undefined })}
      />,
    );
    const payload = await save();
    expect(payload.salutation).toBeUndefined();
  });
});
