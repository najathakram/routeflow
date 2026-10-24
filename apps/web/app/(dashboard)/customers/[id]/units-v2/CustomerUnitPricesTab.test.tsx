import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { render, screen } from "@testing-library/react";
import { UnitPricesTabContent, UnitPricesTabTrigger } from "./CustomerUnitPricesTab";

let mockFlag = false;
let mockRole = "OPERATOR";
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => mockFlag }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: mockRole } }) }));
jest.mock("../../../products/[id]/units-v2/customer/CustomerPriceView", () => ({
  CustomerPriceView: ({ customerId }: { customerId: string }) => (
    <div data-testid="view">view for {customerId}</div>
  ),
}));

const mount = () =>
  render(
    <Tabs.Root value="unit-prices">
      <Tabs.List>
        <UnitPricesTabTrigger />
      </Tabs.List>
      <UnitPricesTabContent customerId="c1" />
    </Tabs.Root>,
  );

describe("customer page Unit prices tab (units v2)", () => {
  beforeEach(() => {
    mockFlag = false;
    mockRole = "OPERATOR";
  });

  it("flag off renders nothing at all", () => {
    const { container } = mount();
    expect(container.innerHTML).not.toContain("Unit prices");
    expect(screen.queryByTestId("view")).toBeNull();
  });

  it("flag on shows the tab and the view for this customer", () => {
    mockFlag = true;
    mount();
    expect(screen.getByRole("tab", { name: "Unit prices" })).toBeInTheDocument();
    expect(screen.getByTestId("view")).toHaveTextContent("view for c1");
  });

  it("flag on but not staff renders nothing", () => {
    mockFlag = true;
    mockRole = "CUSTOMER";
    mount();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByTestId("view")).toBeNull();
  });
});
