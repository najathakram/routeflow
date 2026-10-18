import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { EffectiveFeature } from "@routeflow/types";
import { SetupSummary } from "./SetupSummary";
import { EFFECTIVE_FIXTURE } from "./__fixtures__/effective.fixtures";

const mockConfigValue = jest.fn();
const mockEffective = jest.fn();

jest.mock("@/lib/platform-admin/business-profiles", () => ({
  fetchTenantConfigValue: (tenantId: string, key: string) => mockConfigValue(tenantId, key),
}));
jest.mock("@/lib/platform-admin/features", () => ({
  fetchTenantFeaturesEffective: (tenantId: string) => mockEffective(tenantId),
}));

const TENANT_ID = "tenant-1";

/** The effective list with the three fleet modules forced to a given serving state. */
function effectiveWithFleet(fleet: {
  recurring_routes?: boolean;
  order_delivery?: boolean;
  driver_payments?: boolean;
}): EffectiveFeature[] {
  const keys = ["recurring_routes", "order_delivery", "driver_payments"] as const;
  const base = EFFECTIVE_FIXTURE.filter((f) => !(keys as readonly string[]).includes(f.key));
  const template = EFFECTIVE_FIXTURE[0];
  return [
    ...base,
    ...keys.map((key) => ({
      ...template,
      key,
      area: "routes",
      serving: fleet[key] ?? false,
      resolver: fleet[key] ?? false,
    })),
  ];
}

function setup(
  values: { fulfilment?: string; counter?: string },
  fleet: Parameters<typeof effectiveWithFleet>[0],
) {
  mockConfigValue.mockImplementation((_tenant: string, key: string) =>
    Promise.resolve(
      key === "fulfilment_model" ? (values.fulfilment ?? "unset") : (values.counter ?? "unset"),
    ),
  );
  mockEffective.mockResolvedValue(effectiveWithFleet(fleet));
}

function row(label: string): HTMLElement {
  return screen.getByText(label).closest("div") as HTMLElement;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("SetupSummary — the tenant's current setup in plain English", () => {
  it("shows a loading state first", () => {
    mockConfigValue.mockReturnValue(new Promise(() => {}));
    mockEffective.mockReturnValue(new Promise(() => {}));
    render(<SetupSummary tenantId={TENANT_ID} />);
    expect(screen.getByText("Loading this tenant's setup...")).toBeInTheDocument();
  });

  it("BO-11: the fulfilment row reads 'Where orders go', the registry's own label", async () => {
    setup({ fulfilment: "ship" }, {});
    render(<SetupSummary tenantId={TENANT_ID} />);
    await screen.findByText("Ship by carrier: orders are shipped, not delivered");
    expect(screen.getByText("Where orders go")).toBeInTheDocument();
    expect(screen.queryByText("Fulfilment model")).not.toBeInTheDocument();
  });

  it("a delivery distributor: own delivery, fleet on, counter off", async () => {
    setup(
      { fulfilment: "delivery" },
      { recurring_routes: true, order_delivery: true, driver_payments: true },
    );
    render(<SetupSummary tenantId={TENANT_ID} />);
    expect(
      await screen.findByText("Own delivery: orders go out on the business's own trucks"),
    ).toBeInTheDocument();
    expect(within(row("Counter sales")).getByText("Off")).toBeInTheDocument();
    const fleet = screen.getByTestId("setup-fleet");
    expect(within(fleet).getByText("Recurring routes").closest("li")).toHaveTextContent("On");
    expect(within(fleet).getByText("Ad hoc order delivery").closest("li")).toHaveTextContent("On");
    expect(within(fleet).getByText("At-door payment collection").closest("li")).toHaveTextContent(
      "On",
    );
    expect(screen.getByText("Delivery fleet: on")).toBeInTheDocument();
    expect(screen.queryByTestId("capability-warning")).not.toBeInTheDocument();
  });

  it("a shipping wholesaler: carrier shipping, no fleet", async () => {
    setup({ fulfilment: "ship" }, {});
    render(<SetupSummary tenantId={TENANT_ID} />);
    expect(
      await screen.findByText("Ship by carrier: orders are shipped, not delivered"),
    ).toBeInTheDocument();
    expect(screen.getByText("Delivery fleet: off")).toBeInTheDocument();
    const fleet = screen.getByTestId("setup-fleet");
    expect(within(fleet).getByText("Recurring routes").closest("li")).toHaveTextContent("Off");
    expect(screen.queryByTestId("capability-warning")).not.toBeInTheDocument();
  });

  it("an untouched tenant reads 'Not set' and says nothing is different from before", async () => {
    setup({}, { recurring_routes: true });
    render(<SetupSummary tenantId={TENANT_ID} />);
    expect(await screen.findByText("Not set (the business works as before)")).toBeInTheDocument();
    expect(within(row("Counter sales")).getByText("Off")).toBeInTheDocument();
  });

  it("counter sales: on when set, always on for an in-store setup", async () => {
    setup({ fulfilment: "ship", counter: "on" }, {});
    const { unmount } = render(<SetupSummary tenantId={TENANT_ID} />);
    expect(
      await screen.findByText("On: this business can also sell over the counter"),
    ).toBeInTheDocument();
    unmount();

    setup({ fulfilment: "pickup" }, {});
    render(<SetupSummary tenantId={TENANT_ID} />);
    expect(
      await screen.findByText("Always on: this setup includes the counter"),
    ).toBeInTheDocument();
  });

  it("warns when orders are set to delivery but no fleet feature is on", async () => {
    setup({ fulfilment: "delivery" }, { driver_payments: true });
    render(<SetupSummary tenantId={TENANT_ID} />);
    const warning = await screen.findByTestId("capability-warning");
    expect(warning).toHaveTextContent(
      "Orders are set to use delivery, but no fleet feature is on. Turn on Recurring routes or Ad hoc order delivery, or change where orders go.",
    );
  });

  it("a stored value this screen does not know is not printed raw", async () => {
    setup({ fulfilment: "teleport" }, {});
    render(<SetupSummary tenantId={TENANT_ID} />);
    expect(await screen.findByText("A setting this screen does not recognise")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("teleport");
  });

  it("shows an alert with Retry when the setup cannot be loaded", async () => {
    mockConfigValue.mockRejectedValueOnce(new Error("down"));
    mockEffective.mockResolvedValue([]);
    render(<SetupSummary tenantId={TENANT_ID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load this tenant's setup. Try again.",
    );
    setup({ fulfilment: "ship" }, {});
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("Ship by carrier: orders are shipped, not delivered"),
    ).toBeInTheDocument();
  });

  it("fleet state the API could not report is said so, not shown as off", async () => {
    mockConfigValue.mockResolvedValue("ship");
    mockEffective.mockResolvedValue([]);
    render(<SetupSummary tenantId={TENANT_ID} />);
    expect(await screen.findByText("Delivery fleet: not available right now")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-fleet")).not.toBeInTheDocument();
  });
});
