import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * Row 328: "Create Customer" did nothing on an invalid form. The required errors (Contact Name, Street, City,
 * ZIP) render below the fold of the modal body, so the click looked dead. A failed submit now announces
 * "Fix N field(s)" and moves focus to the first invalid control, like the Business profile form.
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

describe("CustomerFormModal — invalid submit (row 328)", () => {
  it("announces 'Fix N fields' and focuses the first invalid control instead of doing nothing", async () => {
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));

    expect(await screen.findByText(/^Fix \d+ fields?$/)).toBeInTheDocument();
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute("aria-invalid")).toBe("true");
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("the focused control is the FIRST invalid one in the form", async () => {
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await screen.findByText(/^Fix \d+ fields?$/);
    const first = document.querySelector<HTMLElement>('[aria-invalid="true"]');
    expect(first).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(first));
  });
});
