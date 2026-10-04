import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CapabilityWarning } from "./CapabilityWarning";

const cap = (over = {}) => ({
  fleet: false,
  fulfilment: "delivery",
  consistent: false,
  inconsistentModes: ["fulfilment_model"],
  ...over,
});

describe("CapabilityWarning (SA-649 R1)", () => {
  it("consistent:false shows the fixed warning", () => {
    render(<CapabilityWarning capability={cap()} />);
    expect(screen.getByTestId("capability-warning")).toHaveTextContent(
      "Orders are set to use delivery, but no fleet feature is on.",
    );
  });
  it("consistent:true, null (older API) and unset render nothing", () => {
    const a = render(<CapabilityWarning capability={cap({ consistent: true, fleet: true })} />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const b = render(<CapabilityWarning capability={null} />);
    expect(b.container).toBeEmptyDOMElement();
  });
});
