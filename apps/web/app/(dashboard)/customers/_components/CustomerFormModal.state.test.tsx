import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * The add-customer form must send the state exactly as entered. A blank state used to be replaced
 * by "TX", so the selling-restrictions engine judged the customer in the wrong jurisdiction.
 */
const mutate = jest.fn();
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

const submit = async (state?: string) => {
  renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
  fireEvent.change(screen.getByLabelText(/^Business Name/), {
    target: { value: "Acme Foods" },
  });
  fireEvent.change(screen.getByLabelText(/^Contact Name/), { target: { value: "Pat Lee" } });
  fireEvent.change(screen.getByLabelText("Street"), { target: { value: "1 Main St" } });
  fireEvent.change(screen.getByPlaceholderText("Austin"), { target: { value: "Austin" } });
  fireEvent.change(screen.getByPlaceholderText("78701"), { target: { value: "78701" } });
  if (state !== undefined) {
    fireEvent.change(screen.getByPlaceholderText("TX"), { target: { value: state } });
  }
  fireEvent.click(screen.getByRole("button", { name: /create customer/i }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  return mutate.mock.calls[0][0].addresses[0];
};

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal — address state", () => {
  it("a blank state is sent blank, never defaulted to TX", async () => {
    expect((await submit()).state).toBe("");
  });

  it("a whitespace-only state is sent blank too", async () => {
    expect((await submit("   ")).state).toBe("");
  });

  it("a typed state is sent as entered (trimmed)", async () => {
    expect((await submit(" CA ")).state).toBe("CA");
  });
});
