import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { navFor } from "@/test-utils/nav";
import { CommandPalette } from "./CommandPalette";

/**
 * POS-7a: "New counter sale" is offered exactly when the menu holds the Counter entry (the layout builds the menu
 * from useCounterSaleGate, the same gate as the dashboard button; pinned in layout.counter-gate-roles.test.tsx).
 */
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: mockRole } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
jest.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

beforeEach(() => {
  mockPush.mockClear();
  mockRole = "OPERATOR";
});
afterEach(cleanup);

describe("CommandPalette counter action", () => {
  it("is absent when the menu has no Counter", () => {
    render(<CommandPalette open onClose={() => {}} nav={navFor({ counterEnabled: false })} />);
    expect(screen.queryByText("New counter sale")).toBeNull();
    expect(screen.getByText("New Order")).toBeInTheDocument();
  });

  it("is present when the menu has Counter and goes to /orders/counter-sale", () => {
    render(<CommandPalette open onClose={() => {}} nav={navFor({ counterEnabled: true })} />);
    fireEvent.click(screen.getByText("New counter sale"));
    expect(mockPush).toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("is not offered to a customer even when the shop has a counter", () => {
    mockRole = "CUSTOMER";
    render(
      <CommandPalette
        open
        onClose={() => {}}
        nav={navFor({ role: "CUSTOMER", counterEnabled: true })}
      />,
    );
    expect(screen.queryByText("New counter sale")).toBeNull();
  });
});
