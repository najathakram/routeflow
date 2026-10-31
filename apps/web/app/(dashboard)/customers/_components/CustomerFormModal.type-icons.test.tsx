import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * SA-1066 F8: the Customer Type control draws line icons (lucide), not emoji, on every option, and the button's name is
 * just the word. The icons are decoration (aria-hidden).
 */
const createMutate = jest.fn();
const toastFn = jest.fn();
const CREATED = {
  customer: { id: "c-new", businessName: "Acme Cafe" },
  user: {},
  tempPassword: "x",
};
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: (...a: unknown[]) => toastFn(...a) }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({
    mutate: (payload: unknown, opts?: { onSuccess?: (d: unknown) => void }) => {
      createMutate(payload);
      opts?.onSuccess?.(CREATED);
    },
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

const open = () => renderWithProviders(<CustomerFormModal isOpen mode="add" onClose={jest.fn()} />);

describe("CustomerFormModal: Customer Type icons (F8)", () => {
  it.each(["Business", "Individual"])("%s is a line icon and the word, no emoji", (word) => {
    open();
    const btn = screen.getByRole("button", { name: word });
    expect(btn.textContent).toBe(word);
    const icon = btn.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});
