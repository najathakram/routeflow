import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * B956: a refused formula-led name (400 `TEXT_CELL_FORMULA_LEAD`) shows FIXED copy with a human field
 * label in the form's error banner, on both create and update. Never the raw axios "Request failed
 * with status code 400" and never the camelCase field key or the server message.
 */
let createError: unknown = null;
let updateError: unknown = null;
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
const createOpts = jest.fn();
const updateOpts = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCreateCustomer: (o: unknown) => ({
    ...(createOpts(o), {}),
    mutate: jest.fn(),
    isPending: false,
    error: createError,
    reset: jest.fn(),
  }),
  useUpdateCustomer: (o: unknown) => ({
    ...(updateOpts(o), {}),
    mutate: jest.fn(),
    isPending: false,
    error: updateError,
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

const axiosRefusal = (field: string) =>
  Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: {
        statusCode: 400,
        code: "TEXT_CELL_FORMULA_LEAD",
        field,
        message: `${field} must not start with = + - @ or a tab/line break`,
      },
    },
  });

beforeEach(() => {
  createError = null;
  updateError = null;
});

describe("CustomerFormModal — refused name (B956)", () => {
  it("create: shows the Business name copy, not the raw axios text", () => {
    createError = axiosRefusal("businessName");
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    expect(
      screen.getByText("Business name can't start with =, +, -, @ or a tab/line break."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Request failed with status code 400/)).not.toBeInTheDocument();
    expect(screen.queryByText(/businessName/)).not.toBeInTheDocument();
  });

  it("update: shows the Contact name copy", () => {
    updateError = axiosRefusal("contactName");
    renderWithProviders(
      <CustomerFormModal
        isOpen
        onClose={jest.fn()}
        mode="edit"
        initialData={{ id: "c1", businessName: "Acme", contactName: "Jo" } as never}
      />,
    );
    expect(
      screen.getByText("Contact name can't start with =, +, -, @ or a tab/line break."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Request failed with status code 400/)).not.toBeInTheDocument();
  });

  it("the form's mutations opt out of the app-wide error toast (the banner is the one place it shows)", () => {
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    expect(createOpts).toHaveBeenCalledWith({ localErrorToast: true });
    expect(updateOpts).toHaveBeenCalledWith({ localErrorToast: true });
  });

  it("B964: a refused ADDRESS field shows its human label (City), not the raw key or server text", () => {
    createError = axiosRefusal("city");
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    expect(
      screen.getByText("City can't start with =, +, -, @ or a tab/line break."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Request failed with status code 400/)).not.toBeInTheDocument();
  });

  it("any other error keeps the existing banner text", () => {
    createError = new Error("Email or username already taken");
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    expect(screen.getByText("Email or username already taken")).toBeInTheDocument();
  });
});
