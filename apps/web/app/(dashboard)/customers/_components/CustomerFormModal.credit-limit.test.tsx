import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/** B1018: blanking the credit-limit box on an edit really clears the limit (PATCH creditLimit: null); a create still omits it. */
const createMutate = jest.fn();
const updateMutate = jest.fn();
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
  AddressAutocomplete: ({ value, onChange }: any) => (
    <input aria-label="Street" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const existing = (creditLimit: unknown) => ({
  id: "cust-1",
  businessName: "Acme Foods",
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  currency: "USD",
  creditLimit,
  addresses: [{ line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" }],
});

const box = () => screen.getByLabelText(/Credit Limit/i) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
const edit = (creditLimit: unknown) =>
  renderWithProviders(
    <CustomerFormModal
      isOpen
      onClose={jest.fn()}
      mode="edit"
      initialData={existing(creditLimit) as never}
    />,
  );

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal credit limit (B1018)", () => {
  it("edit: blanking a stored limit sends creditLimit null", async () => {
    edit(500);
    expect(box().value).toBe("500");
    fireEvent.change(box(), { target: { value: "" } });
    save();
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0]).toHaveProperty("creditLimit", null);
  });

  it("edit: a stored $0 limit shows as 0 (not blank), so saving untouched keeps 0 and never clears it", async () => {
    edit(0);
    expect(box().value).toBe("0");
    save();
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0].creditLimit).toBe(0);
  });

  it("edit: untouched box keeps the number; a changed box sends the new number", async () => {
    edit("750.00");
    save();
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0].creditLimit).toBe(750);
  });

  it("edit: a customer with no limit and a blank box sends no creditLimit key value (nothing to clear)", async () => {
    edit(null);
    expect(box().value).toBe("");
    save();
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0].creditLimit).toBeUndefined();
  });

  it("edit: a non-numeric value is refused by the form and nothing is sent", async () => {
    edit(500);
    fireEvent.change(box(), { target: { value: "12.345" } });
    save();
    await waitFor(() =>
      expect(screen.getByText(/amount like 500 or 500\.50/i)).toBeInTheDocument(),
    );
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("create: a blank box omits creditLimit (never null)", async () => {
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    fireEvent.change(screen.getByLabelText(/^Business Name/), { target: { value: "Acme Foods" } });
    fireEvent.change(screen.getByLabelText(/^Contact Name/), { target: { value: "Pat Lee" } });
    fireEvent.change(screen.getByLabelText("Street"), { target: { value: "1 Main St" } });
    fireEvent.change(screen.getByPlaceholderText("Austin"), { target: { value: "Austin" } });
    fireEvent.change(screen.getByPlaceholderText("78701"), { target: { value: "78701" } });
    fireEvent.click(screen.getByRole("button", { name: /create customer/i }));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0][0].creditLimit).toBeUndefined();
  });
});
