import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

// REG-B1033: the customer EDIT form could not clear phone, mobile, tax id (or the credit limit): a blank
// value was sent as `undefined`, which the API ignores, so the old value silently stayed. A field the
// operator really emptied is now an explicit `null` (the API stores null for these nullable columns);
// a field that was already empty, or that the form never saw a value for, is left out so an edit from a
// list row that omits a column can never wipe data. A required name still cannot be cleared.

const mutate = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useUpdateCustomer: () => ({ mutate, isPending: false, error: null, reset: jest.fn() }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: ({ value, onChange }: any) => (
    <input aria-label="Street" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const base = {
  id: "c1",
  businessName: "Acme Foods",
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  email: "pat@acme.example",
  addresses: [{ line1: "1 Main St", city: "Austin", zip: "78701" }],
};
const full = {
  ...base,
  phone: "5125550100",
  mobile: "5125550200",
  taxId: "12-3456789",
  creditLimit: 500,
};

const open = (initialData: any) =>
  renderWithProviders(
    <CustomerFormModal isOpen onClose={jest.fn()} mode="edit" initialData={initialData} />,
  );
const clear = (label: RegExp) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
const save = () => fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal edit — clearing optional fields (REG-B1033)", () => {
  it("emptied phone, mobile, tax id and credit limit are sent as explicit nulls", async () => {
    open(full);
    clear(/^Phone/);
    clear(/^Mobile/);
    clear(/^Tax ID/);
    clear(/^Credit Limit/);
    save();

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    // Before the fix each of these was `undefined`, which the API ignores — the old value stayed.
    expect(mutate.mock.calls[0][0]).toMatchObject({
      phone: null,
      mobile: null,
      taxId: null,
      creditLimit: null,
    });
  });

  it("a field left as it was is sent unchanged", async () => {
    open(full);
    save();

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toMatchObject({
      phone: "5125550100",
      mobile: "5125550200",
      taxId: "12-3456789",
      creditLimit: 500,
    });
  });

  it("a field that was already empty (or never loaded) is left out, never nulled", async () => {
    open(base);
    save();

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const payload = mutate.mock.calls[0][0];
    for (const k of ["phone", "mobile", "taxId", "creditLimit"]) expect(payload[k]).toBeUndefined();
  });

  it("a real $0 credit limit shows as 0 in the field and is saved as 0, not cleared", async () => {
    open({ ...base, creditLimit: 0 });
    expect(screen.getByLabelText(/^Credit Limit/)).toHaveValue(0);
    save();

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0].creditLimit).toBe(0);
  });

  it("the name stays required: clearing it is refused with fixed copy and nothing is saved", async () => {
    open(full);
    clear(/^Business Name/);
    save();

    expect(await screen.findByText("Business name is required")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });
});
