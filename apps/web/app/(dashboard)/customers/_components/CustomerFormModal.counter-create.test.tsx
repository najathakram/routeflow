import * as React from "react";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * Row 240: the counter opens this form to create the sale's buyer. Add mode starts from `prefillName` (the typed search) and
 * hands the created customer back through `onCreated`; without those props nothing changes for every other host.
 */
const create = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({ mutate: create, isPending: false, error: null, reset: jest.fn() }),
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

beforeEach(() => jest.clearAllMocks());

describe("CustomerFormModal — created from the counter (row 240)", () => {
  it("add mode starts from the typed name", () => {
    renderWithProviders(
      <CustomerFormModal isOpen onClose={jest.fn()} mode="add" prefillName="  Zed Cafe " />,
    );
    expect((screen.getByLabelText(/business name/i) as HTMLInputElement).value).toBe("Zed Cafe");
  });

  it("a successful create hands the new customer to onCreated, then closes", async () => {
    const onCreated = jest.fn();
    const onClose = jest.fn();
    renderWithProviders(
      <CustomerFormModal
        isOpen
        onClose={onClose}
        mode="add"
        prefillName="Zed Cafe"
        onCreated={onCreated}
      />,
    );
    fireEvent.change(screen.getByLabelText(/contact name/i), { target: { value: "Zed" } });
    fireEvent.change(screen.getByLabelText("Street"), { target: { value: "1 Main St" } });
    fireEvent.change(screen.getByLabelText(/^city/i), { target: { value: "Austin" } });
    fireEvent.change(screen.getByLabelText(/zip/i), { target: { value: "78701" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ businessName: "Zed Cafe" });
    act(() =>
      create.mock.calls[0][1].onSuccess({
        customer: { id: "c-new", businessName: "Zed Cafe" },
        user: { id: "u" },
      }),
    );
    expect(onCreated).toHaveBeenCalledWith({ id: "c-new", businessName: "Zed Cafe" });
    expect(onClose).toHaveBeenCalled();
  });
});
