import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { NeedsAttention } from "./NeedsAttention";

/** apple-ux U1: the customers-without-a-state list is reachable from the Settings home, for admins and operators. */
let mockUnknown: unknown = { customersTotal: 8, truncated: false };
jest.mock("@/lib/api/unknown-state", () => ({
  useUnknownStateBuckets: () => ({ data: mockUnknown }),
}));
jest.mock("@/lib/api/remittance", () => ({
  useRemittanceConfig: () => ({ data: { payToName: "Acme" } }),
}));
jest.mock("@/lib/api/stripe-connect", () => ({
  useStripeConnectStatus: () => ({ data: { connected: true } }),
}));
let mockRestrictions: unknown = { enabled: true };
let mockRestrictionsError = false;
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => ({
    data: mockRestrictions,
    isLoading: false,
    isError: mockRestrictionsError,
  }),
}));
jest.mock("./BusinessCard", () => ({ useBusinessStatus: () => null }));

beforeEach(() => {
  mockUnknown = { customersTotal: 8, truncated: false };
  mockRestrictions = { enabled: true };
  mockRestrictionsError = false;
});

it.each([true, false])("isAdmin=%s: '8 customers need a state' links to the card", (isAdmin) => {
  renderWithProviders(<NeedsAttention isAdmin={isAdmin} />);
  expect(screen.getByRole("link", { name: /8 customers need a state/ })).toHaveAttribute(
    "href",
    "/settings/restrictions#customers-without-state",
  );
});

it("nothing to fix: no heading at all", () => {
  mockUnknown = { customersTotal: 0, truncated: false };
  renderWithProviders(<NeedsAttention isAdmin={false} />);
  expect(screen.queryByText("Needs attention")).toBeNull();
});

describe("selling restrictions off", () => {
  beforeEach(() => {
    mockRestrictions = { enabled: false };
  });

  it("admin: one link row to /settings/restrictions, next to the other items", () => {
    renderWithProviders(<NeedsAttention isAdmin />);
    expect(screen.getByRole("link", { name: /selling restrictions are off/i })).toHaveAttribute(
      "href",
      "/settings/restrictions",
    );
    expect(screen.getByRole("link", { name: /8 customers need a state/ })).toBeInTheDocument();
  });

  it("operator: a text row with no link and no button, and the state row is unchanged", () => {
    renderWithProviders(<NeedsAttention isAdmin={false} />);
    expect(screen.getByText(/selling restrictions are off/i)).toHaveTextContent(/ask an admin/i);
    expect(screen.queryByRole("link", { name: /selling restrictions are off/i })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: /8 customers need a state/ })).toBeInTheDocument();
  });

  it("switch on and nothing else to fix: no row and no heading", () => {
    mockRestrictions = { enabled: true };
    mockUnknown = { customersTotal: 0, truncated: false };
    renderWithProviders(<NeedsAttention isAdmin />);
    expect(screen.queryByText(/selling restrictions are off/i)).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("switch off alone (nothing else to fix): the heading and the one row", () => {
    mockUnknown = { customersTotal: 0, truncated: false };
    renderWithProviders(<NeedsAttention isAdmin />);
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it.each([true, false])("isAdmin=%s: a failed refetch with old data hides the row", (isAdmin) => {
    mockRestrictionsError = true;
    renderWithProviders(<NeedsAttention isAdmin={isAdmin} />);
    expect(screen.queryByText(/selling restrictions are off/i)).toBeNull();
  });
});
