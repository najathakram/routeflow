import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, waitFor, act } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * SA-1071 C1 + C2: the form opens with the cursor on the first empty field (not the close button), and on a sale's door it
 * shows name, phone and email with the rest behind a closed "More details" that opens by itself when it must. The customers
 * page keeps its full form.
 */
const createMutate = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: () => ({
    mutate: (payload: unknown) => createMutate(payload),
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
  AddressAutocomplete: ({ value, onChange }: any) => (
    <input aria-label="Street" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

beforeEach(() => jest.clearAllMocks());

/** what a person would call the focused control */
const nameOf = (el: Element | null): string => {
  if (!el) return "(nothing)";
  const labelled = (el as HTMLInputElement).labels?.[0]?.textContent;
  return labelled || el.getAttribute("aria-label") || el.textContent?.trim() || el.tagName;
};

const doorForm = (over: Record<string, unknown> = {}) =>
  renderWithProviders(
    <CustomerFormModal
      isOpen
      mode="add"
      onClose={jest.fn()}
      onCreated={jest.fn()}
      addressRequired={false}
      {...over}
    />,
  );

describe("SA-1071 C1: the cursor starts on the first empty field", () => {
  it("C1: opened from the customers page, focus is on the business name, not the close button", async () => {
    renderWithProviders(<CustomerFormModal isOpen mode="add" onClose={jest.fn()} />);
    await waitFor(() => expect(nameOf(document.activeElement)).toBe("Business Name"));
  });

  it("C1: on the till door the typed name is in, so focus lands on the next empty field", async () => {
    doorForm({ initialName: "Acme Cafe" });
    await waitFor(() => expect(nameOf(document.activeElement)).toBe("Phone (optional)"));
  });

  it("C1: editing a customer keeps the dialog's own first focus (nothing is hunted for)", async () => {
    renderWithProviders(
      <CustomerFormModal
        isOpen
        mode="edit"
        onClose={jest.fn()}
        initialData={{ id: "c1", businessName: "Acme", contactName: "Jo" }}
      />,
    );
    await act(async () => {});
    expect(nameOf(document.activeElement)).not.toBe("Mobile (optional)");
    expect(nameOf(document.activeElement)).not.toBe("Phone (optional)");
  });
});

describe("SA-1071 C2: a short form on the sale doors", () => {
  it("C2: from the name, Tab visits phone, email, More details, Cancel, Create", async () => {
    const user = userEvent.setup();
    doorForm({ initialName: "Acme Cafe" });
    (screen.getByLabelText("Business Name") as HTMLElement).focus();
    const stops: string[] = [nameOf(document.activeElement)];
    for (let i = 0; i < 40 && !stops.includes("Create Customer"); i++) {
      await user.tab();
      stops.push(nameOf(document.activeElement));
    }
    expect(stops).toEqual([
      "Business Name",
      "Phone (optional)",
      "Email (optional)",
      "More details",
      "Cancel",
      "Create Customer",
    ]);
  });

  it("C2: More details is closed, says so, and opens to every other field", async () => {
    const user = userEvent.setup();
    doorForm();
    const more = screen.getByRole("button", { name: "More details" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox", { name: "Notes (optional)" })).toBeNull();
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    for (const label of [
      "Contact Name (optional)",
      "Mobile (optional)",
      "Tax ID (optional)",
      "Notes (optional)",
      "City",
      "ZIP Code",
    ]) {
      expect(screen.getByRole("textbox", { name: label })).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "Individual" })).toBeVisible();
  });

  it("C2a: when the sale needs an address, More details is open from the start", () => {
    doorForm({ addressRequired: true });
    expect(screen.getByRole("textbox", { name: "City" })).toBeVisible();
    expect(screen.getByRole("button", { name: "More details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("C2: a field inside that fails opens it by itself (a street with no city, folded away)", async () => {
    const user = userEvent.setup();
    doorForm({ initialName: "Acme" });
    await user.click(screen.getByRole("button", { name: "More details" }));
    await user.type(screen.getByRole("textbox", { name: "Street" }), "1 Main St");
    await user.click(screen.getByRole("button", { name: "More details" })); // fold it away again
    expect(screen.getByRole("button", { name: "More details" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "More details" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    expect(screen.queryAllByText("Required").length).toBeGreaterThan(0);
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("C2: values typed inside More details survive folding it and are sent", async () => {
    const user = userEvent.setup();
    doorForm({ initialName: "Acme" });
    await user.click(screen.getByRole("button", { name: "More details" }));
    await user.type(screen.getByRole("textbox", { name: "Mobile (optional)" }), "5125550100");
    await user.click(screen.getByRole("button", { name: "More details" }));
    await user.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0][0]).toMatchObject({
      businessName: "Acme",
      mobile: "5125550100",
    });
  });

  it("C2: the customers page keeps the full form and has no More details control", () => {
    renderWithProviders(<CustomerFormModal isOpen mode="add" onClose={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "More details" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Contact Name" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "City" })).toBeVisible();
  });

  it("C2: the name still submits with Enter in a short field", async () => {
    doorForm({ initialName: "Acme" });
    fireEvent.submit(document.getElementById("customer-form")!);
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
  });
});
