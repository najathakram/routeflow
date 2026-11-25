import * as React from "react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CreateRouteLeftPanel } from "./CreateRouteLeftPanel";

/**
 * UX audit 2026-11-24, findings F44 and F46 on Create route.
 * F44: the Create route button stayed faded and nothing on the page said why (the reason was a hover tooltip). The
 * panel now says the missing step in words and a button opens the section that fixes it.
 * F46: a stop with no map position showed a bare triangle whose meaning was a hover tooltip. It carries words now.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/components/RoutePlanningControls", () => ({
  RoutePlanningControls: () => <div>planning controls</div>,
}));

const onTogglePlanning = jest.fn();
type Props = React.ComponentProps<typeof CreateRouteLeftPanel>;

function Harness(over: Partial<Props>) {
  const form = useForm<{ name: string; defaultDriverId?: string }>({
    defaultValues: { name: "Acme loop" },
  });
  return (
    <CreateRouteLeftPanel
      form={form}
      driverOptions={[]}
      stops={[]}
      customers={[]}
      assignments={{}}
      onAddStop={jest.fn()}
      onRemoveStop={jest.fn()}
      onOptimize={jest.fn()}
      onSubmit={jest.fn()}
      isSubmitting={false}
      planningValue={{} as Props["planningValue"]}
      onPlanningChange={jest.fn()}
      planningDrivers={[]}
      planningOpen={false}
      onTogglePlanning={onTogglePlanning}
      originReady
      settingsChanged={false}
      {...over}
    />
  );
}

// jsdom has no layout, so no scrollIntoView.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});
beforeEach(() => onTogglePlanning.mockReset());

describe("Create route: the missing step is said in words", () => {
  it("no start point: the reason is on the page and Create route is off", () => {
    renderWithProviders(<Harness originReady={false} />);
    expect(screen.getByText(/Choose where the route starts\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create route" })).toBeDisabled();
  });

  it("Set start point opens Route options when it is closed", async () => {
    renderWithProviders(<Harness originReady={false} planningOpen={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Set start point" }));
    expect(onTogglePlanning).toHaveBeenCalledTimes(1);
  });

  it("Set start point does not close Route options when it is already open", async () => {
    renderWithProviders(<Harness originReady={false} planningOpen />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Set start point" }));
    expect(onTogglePlanning).not.toHaveBeenCalled();
  });

  it("start point set: no reason line, Create route is on", () => {
    renderWithProviders(<Harness originReady />);
    expect(screen.queryByText(/Choose where the route starts\./)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set start point" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create route" })).toBeEnabled();
  });
});

describe("Create route: a stop with no map position says so in words", () => {
  const stopRow = (over: Partial<Props["stops"][number]>) => ({
    id: "s1",
    customerId: "c1",
    customerName: "Acme Cafe",
    address: "1 Main St",
    ...over,
  });

  it("no coordinates: the row reads No map pin", () => {
    renderWithProviders(<Harness stops={[stopRow({})]} />);
    expect(screen.getByText("No map pin")).toBeInTheDocument();
  });

  it("coordinates present: no warning words", () => {
    renderWithProviders(<Harness stops={[stopRow({ lat: 29.4, lng: -98.5 })]} />);
    expect(screen.queryByText("No map pin")).not.toBeInTheDocument();
  });
});
