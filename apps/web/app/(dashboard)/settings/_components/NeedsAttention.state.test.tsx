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
jest.mock("./BusinessCard", () => ({ useBusinessStatus: () => null }));

beforeEach(() => {
  mockUnknown = { customersTotal: 8, truncated: false };
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
