import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import type { ActivationAddonState, ManualActivationAddons } from "@routeflow/types";
import { ActivationAddonChecklist, addonsTurnedOff } from "./ActivationAddonChecklist";

const row = (over: Partial<ActivationAddonState> = {}): ActivationAddonState => ({
  addonKey: "FORECASTING",
  sku: "FORECASTING",
  name: "Forecasting",
  active: true,
  priceSnapshot: 25,
  isComp: false,
  ...over,
});

const result = (
  before: ActivationAddonState[],
  after: ActivationAddonState[],
): ManualActivationAddons => ({ before, after, changed: [] });

describe("ActivationAddonChecklist (SA-788 C-R2)", () => {
  it("shows each add-on after activation with On/Off and its price, Included or Comp", () => {
    const list = [
      row(),
      row({ addonKey: "tobacco_dealer", sku: null, name: "Regulated items", priceSnapshot: 0 }),
      row({ addonKey: "MSRP", sku: "MSRP", name: "MSRP", priceSnapshot: 0, isComp: true }),
      row({ addonKey: "OCR", sku: "OCR_PACK_250", name: "OCR pack", active: false }),
    ];
    render(<ActivationAddonChecklist addons={result(list, list)} />);

    expect(screen.getByRole("heading", { name: "Add-ons after activation" })).toBeInTheDocument();
    const items = within(screen.getByTestId("activation-addons")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "ForecastingOn, $25.00 a month",
      "Regulated itemsOn, Included",
      "MSRPComp",
      "OCR packOff",
    ]);
    expect(screen.queryByTestId("activation-addons-warning")).not.toBeInTheDocument();
  });

  it("an add-on that was on before and is off after gets the amber line naming it", () => {
    const before = [row(), row({ addonKey: "MSRP", sku: "MSRP", name: "MSRP" })];
    const after = [row({ active: false }), row({ addonKey: "MSRP", sku: "MSRP", name: "MSRP" })];
    render(<ActivationAddonChecklist addons={result(before, after)} />);

    const warning = screen.getByTestId("activation-addons-warning");
    expect(warning).toHaveTextContent(
      "Forecasting turned off during activation. Check before you leave this page.",
    );
    expect(warning).toHaveAttribute("role", "alert");
    // the list still shows the truth
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("an add-on that was already off before is not a warning", () => {
    const list = [row({ active: false })];
    render(<ActivationAddonChecklist addons={result(list, list)} />);
    expect(screen.queryByTestId("activation-addons-warning")).not.toBeInTheDocument();
  });

  it("renders nothing without add-ons (a result from an older API, or a tenant with none)", () => {
    const { container, rerender } = render(<ActivationAddonChecklist addons={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ActivationAddonChecklist addons={result([], [])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("addonsTurnedOff names every add-on that went from on to off", () => {
    const before = [row(), row({ addonKey: "B", name: "B" }), row({ addonKey: "C", name: "C" })];
    const after = [
      row({ active: false }),
      row({ addonKey: "B", name: "B" }),
      row({ addonKey: "C", name: "C", active: false }),
    ];
    expect(addonsTurnedOff(result(before, after))).toEqual(["Forecasting", "C"]);
  });
});
