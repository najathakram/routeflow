import * as React from "react";
import { renderWithProviders } from "@/test-utils/render";
import { LowStockDigestToggle } from "./LowStockDigestToggle";

/**
 * apple-ux U1: Notifications' "Coming soon › Low stock" row links an admin to #low-stock-digest, so the card it
 * points at must carry that id (it had none on master, so the link went nowhere).
 */
jest.mock("@/lib/api/users", () => ({
  usePreferences: () => ({ data: {}, isLoading: false, isError: false, refetch: jest.fn() }),
  useSavePreferences: () => ({ mutate: jest.fn(), isPending: false }),
}));

it("the low-stock digest card is the #low-stock-digest anchor target", () => {
  renderWithProviders(<LowStockDigestToggle />);
  const target = document.getElementById("low-stock-digest");
  expect(target).not.toBeNull();
  expect(target).toHaveTextContent("Email me a low-stock digest");
});
