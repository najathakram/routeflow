import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

// SA-1084 review: the Remove choice on the edit form belongs to one edit of one customer. It must not survive a
// close, a save, a second customer, or a typed replacement; a typed value always wins over Remove.

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

const customer = (id: string, taxIdLast4: string) => ({
  id,
  businessName: `Acme ${id}`,
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  email: `${id}@acme.example`,
  addresses: [{ line1: "1 Main St", city: "Austin", zip: "78701" }],
  taxIdLast4,
});
const A = customer("a1", "6789");
const B = customer("b2", "1122");

const form = (isOpen: boolean, initialData: any) => (
  <CustomerFormModal isOpen={isOpen} onClose={jest.fn()} mode="edit" initialData={initialData} />
);
const remove = () =>
  fireEvent.click(screen.getByRole("button", { name: /remove the tax id on file/i }));
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText(/^Tax ID/), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
const saved = async () => {
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  const payload = mutate.mock.calls[0][0];
  mutate.mockClear();
  return payload;
};

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal edit: the Remove choice is per edit (SA-1084 review)", () => {
  it("Remove, close, reopen, save: the value is kept", async () => {
    const { rerender } = renderWithProviders(form(true, A));
    remove();
    rerender(form(false, A));
    rerender(form(true, A));
    save();
    expect((await saved()).taxId).toBeUndefined();
    expect(screen.getByRole("button", { name: /remove the tax id on file/i })).toBeInTheDocument();
  });

  it("Remove saved, reopen, type a new value: the typed value is sent", async () => {
    const { rerender } = renderWithProviders(form(true, A));
    remove();
    save();
    expect((await saved()).taxId).toBeNull();
    rerender(form(false, A));
    rerender(form(true, A));
    type("55-5555555");
    save();
    expect((await saved()).taxId).toBe("55-5555555");
  });

  it("Remove, then type in the same open: the typed value wins", async () => {
    renderWithProviders(form(true, A));
    remove();
    type(" 55-5555555 ");
    save();
    expect((await saved()).taxId).toBe("55-5555555");
  });

  it("Remove on one customer never reaches the next customer opened", async () => {
    const { rerender } = renderWithProviders(form(true, A));
    remove();
    rerender(form(true, B));
    expect(screen.getByLabelText(/^Tax ID/)).toHaveAttribute(
      "placeholder",
      expect.stringContaining("ending 1122"),
    );
    save();
    expect((await saved()).taxId).toBeUndefined();
  });

  it("typing after Remove shows the replace state again, not 'Keep'", () => {
    renderWithProviders(form(true, A));
    remove();
    type("55-5555555");
    expect(screen.getByRole("button", { name: /remove the tax id on file/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /keep the tax id on file/i })).toBeNull();
  });

  it("Remove alone still sends an explicit null", async () => {
    renderWithProviders(form(true, A));
    remove();
    save();
    expect((await saved()).taxId).toBeNull();
  });
});
