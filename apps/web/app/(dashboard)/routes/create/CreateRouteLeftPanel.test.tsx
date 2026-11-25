import * as React from "react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { renderWithProviders, screen } from "@/test-utils/render";
import { startPointHint } from "./start-point-hint";
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
      startPointHint={null}
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
    renderWithProviders(<Harness originReady={false} startPointHint="choose" />);
    expect(screen.getByText(/Choose where the route starts\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create route" })).toBeDisabled();
  });

  it("Set start point opens Route options when it is closed", async () => {
    renderWithProviders(
      <Harness originReady={false} startPointHint="choose" planningOpen={false} />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Set start point" }));
    expect(onTogglePlanning).toHaveBeenCalledTimes(1);
  });

  it("Set start point does not close Route options when it is already open", async () => {
    renderWithProviders(<Harness originReady={false} startPointHint="choose" planningOpen />);
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

// Review R-138, M2: the page told a dispatcher who HAS a depot to "choose where the route starts" for as long as the
// route settings took to load, and for ever when they failed to load.
describe("Create route: nothing false is said while the route settings load", () => {
  it("settings still loading: Create route is off and the page does not ask for a start point", () => {
    renderWithProviders(<Harness originReady={false} startPointHint={null} />);
    expect(screen.getByRole("button", { name: "Create route" })).toBeDisabled();
    expect(screen.queryByText(/Choose where the route starts/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set start point" })).not.toBeInTheDocument();
  });

  it("settings failed to load: the page says so, and still offers another start", async () => {
    renderWithProviders(<Harness originReady={false} startPointHint="settings-failed" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your business address did not load. Reload the page, or pick another start.",
    );
    expect(screen.queryByText(/Choose where the route starts/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Set start point" }));
    expect(onTogglePlanning).toHaveBeenCalledTimes(1);
  });
});

describe("startPointHint: what the page hands the panel", () => {
  const hint = (over: Partial<Parameters<typeof startPointHint>[0]>) =>
    startPointHint({ originReady: false, originKind: "TENANT", settings: "ready", ...over });

  it("a start is ready: nothing, whatever the settings are doing", () => {
    expect(hint({ originReady: true, settings: "loading" })).toBeNull();
    expect(hint({ originReady: true, settings: "error" })).toBeNull();
  });
  it("business address, settings still loading: nothing yet", () => {
    expect(hint({ settings: "loading" })).toBeNull();
  });
  it("business address, settings failed: say they did not load", () => {
    expect(hint({ settings: "error" })).toBe("settings-failed");
  });
  it("business address, settings loaded and no depot set: choose", () => {
    expect(hint({ settings: "ready" })).toBe("choose");
  });
  it("driver or typed address not usable yet: choose, the settings do not matter", () => {
    expect(hint({ originKind: "DRIVER", settings: "loading" })).toBe("choose");
    expect(hint({ originKind: "ADDRESS", settings: "error" })).toBe("choose");
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
