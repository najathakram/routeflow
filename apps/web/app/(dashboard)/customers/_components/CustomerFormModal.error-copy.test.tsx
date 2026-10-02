import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CustomerFormModal } from "./CustomerFormModal";

/**
 * B979: every NON-refusal failure shows FIXED copy in the form's banner: never axios's "Request failed
 * with status code …" / "Network Error", never an unlisted server message, never a camelCase key.
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

const axiosErr = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

const RAW = /Request failed with status code|Network Error|businessName should|raw server/;

beforeEach(() => {
  createError = null;
  updateError = null;
});

describe("CustomerFormModal — banner copy for ordinary failures (B979)", () => {
  it("create 400 'Email or username already taken' → the fixed email copy", () => {
    createError = axiosErr(400, { message: "Email or username already taken" });
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That email is already in use. Use a different email.",
    );
    expect(screen.queryByText(RAW)).not.toBeInTheDocument();
  });

  it("create 400 with a class-validator array → 'Some details aren't valid', no raw text", () => {
    createError = axiosErr(400, { message: ["businessName should not be empty"] });
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some details aren't valid. Check the form and try again.",
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(RAW);
  });

  it("create with no response (network) → the connection copy, never 'Network Error'", () => {
    createError = new Error("Network Error");
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't reach the server. Check your connection and try again.",
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(RAW);
  });

  it("update 500 → the server-side copy, never the axios text or the raw server message", () => {
    updateError = axiosErr(500, { message: "raw server text" });
    renderWithProviders(
      <CustomerFormModal
        isOpen
        onClose={jest.fn()}
        mode="edit"
        initialData={{ id: "c1", businessName: "Acme", contactName: "Jo" } as never}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong on our side. Please try again.",
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(RAW);
  });

  it("the customer plan cap says so", () => {
    createError = axiosErr(403, { code: "PLAN_GATE", flag: "meter.customers", message: "x" });
    renderWithProviders(<CustomerFormModal isOpen onClose={jest.fn()} mode="add" />);
    expect(screen.getByRole("alert")).toHaveTextContent("customer limit has been reached");
  });
});
