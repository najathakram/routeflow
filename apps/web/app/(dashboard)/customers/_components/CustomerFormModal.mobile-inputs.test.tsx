import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * SA-1066 F13: inputs read 16 px below md in the customer window, so iOS does not zoom in on focus. The class sits on the
 * dialog's root only: no global rule, and the shared Input is unchanged.
 */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({
    mutate: jest.fn(),
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useUpdateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: () => <input aria-label="Street" />,
}));

describe("CustomerFormModal inputs below md (F13)", () => {
  it("the dialog root sets inputs, selects and textareas to 16 px below md", () => {
    renderWithProviders(<CustomerFormModal isOpen mode="add" onClose={jest.fn()} />);
    const root = screen.getByRole("dialog");
    for (const el of ["input", "select", "textarea"])
      expect(root.className).toContain(`max-md:[&_${el}]:text-base`);
  });
});
