import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * W-1041 (SA-1062 MUSTs 1, 3, 6): the form opens as a "door" inside a sale. `onCreated` hands back the new customer after
 * the toast and before `onClose`, `initialName` prefills the typed search, `addressRequired={false}` lets a name alone
 * save, and one name is enough (the contact name falls back to it). With none of the props the form is exactly as before.
 */
const events: string[] = [];
const createMutate = jest.fn();
const toastFn = jest.fn((..._a: unknown[]) => events.push("toast"));
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

beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
});

const create = () => fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));

describe("CustomerFormModal: the door props (W-1041)", () => {
  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])(
    "a %s business name flags only the business name, not the optional contact name",
    async (_label, value) => {
      renderWithProviders(
        <CustomerFormModal
          isOpen
          mode="add"
          onClose={jest.fn()}
          onCreated={jest.fn()}
          addressRequired={false}
        />,
      );
      fireEvent.change(screen.getByLabelText("Business Name"), { target: { value } });
      create();
      await waitFor(() =>
        expect(screen.getByText("Business name is required")).toBeInTheDocument(),
      );
      expect(screen.queryByText("Contact name is required")).not.toBeInTheDocument();
      expect(createMutate).not.toHaveBeenCalled();
    },
  );

  it("prefills the typed search into the business name", () => {
    renderWithProviders(
      <CustomerFormModal isOpen mode="add" onClose={jest.fn()} initialName="Acme Cafe" />,
    );
    expect((screen.getByLabelText("Business Name") as HTMLInputElement).value).toBe("Acme Cafe");
  });

  it("saves on one name alone when no address is required, contact name falling back to it", async () => {
    renderWithProviders(
      <CustomerFormModal
        isOpen
        mode="add"
        onClose={jest.fn()}
        onCreated={jest.fn()}
        initialName="Acme Cafe"
        addressRequired={false}
      />,
    );
    create();
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const payload = createMutate.mock.calls[0][0];
    expect(payload.businessName).toBe("Acme Cafe");
    expect(payload.contactName).toBe("Acme Cafe");
    expect(payload.addresses).toBeUndefined();
  });

  it("calls onCreated with the new customer after the toast and before onClose", async () => {
    const onCreated = jest.fn((..._a: unknown[]) => events.push("created"));
    const onClose = jest.fn(() => events.push("close"));
    renderWithProviders(
      <CustomerFormModal
        isOpen
        mode="add"
        onClose={onClose}
        onCreated={onCreated}
        initialName="Acme Cafe"
        addressRequired={false}
      />,
    );
    create();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onCreated).toHaveBeenCalledWith(CREATED.customer);
    expect(events).toEqual(["toast", "created", "close"]);
  });

  it("keeps the email visible directly under the name, before the other contact fields", () => {
    renderWithProviders(
      <CustomerFormModal isOpen mode="add" onClose={jest.fn()} onCreated={jest.fn()} />,
    );
    const name = screen.getByLabelText("Business Name");
    const email = screen.getByLabelText(/^Email/);
    const phone = screen.getByLabelText(/^Phone/);
    const after = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(name, email)).toBe(true);
    expect(after(email, phone)).toBe(true);
    expect(screen.getByText("Contact Details").compareDocumentPosition(email)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
  });

  it("asks for the address when addressRequired is left true (a delivery order)", async () => {
    renderWithProviders(
      <CustomerFormModal
        isOpen
        mode="add"
        onClose={jest.fn()}
        onCreated={jest.fn()}
        initialName="Acme"
      />,
    );
    create();
    await waitFor(() => expect(screen.queryAllByText("Required").length).toBeGreaterThan(0));
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("a half-filled address is not silently dropped when none is required", async () => {
    renderWithProviders(
      <CustomerFormModal
        isOpen
        mode="add"
        onClose={jest.fn()}
        onCreated={jest.fn()}
        initialName="Acme"
        addressRequired={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Austin" } });
    create();
    await waitFor(() => expect(screen.queryAllByText("Required").length).toBeGreaterThan(0));
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("guard: with none of the props the form still needs both names and an address", async () => {
    renderWithProviders(<CustomerFormModal isOpen mode="add" onClose={jest.fn()} />);
    expect((screen.getByLabelText("Business Name") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Business Name"), { target: { value: "Acme" } });
    create();
    await waitFor(() => expect(screen.getByText("Contact name is required")).toBeInTheDocument());
    expect(createMutate).not.toHaveBeenCalled();
  });
});
