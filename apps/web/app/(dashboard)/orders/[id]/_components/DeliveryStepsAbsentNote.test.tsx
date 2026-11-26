import * as React from "react";
import { render, screen } from "@testing-library/react";
import { DELIVERY_STEPS_ABSENT_COPY } from "@routeflow/types";
import { DeliveryStepsAbsentNote } from "./DeliveryStepsAbsentNote";

describe("DeliveryStepsAbsentNote (W-1306)", () => {
  it("says nothing when the delivery steps are shown", () => {
    const { container } = render(<DeliveryStepsAbsentNote reason={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["PICKUP_MODEL", "POS_MODE", "NO_FLEET", "CUSTOMER_PICKUP"] as const)(
    "%s shows its one sentence",
    (reason) => {
      render(<DeliveryStepsAbsentNote reason={reason} />);
      expect(screen.getByText(DELIVERY_STEPS_ABSENT_COPY[reason])).toBeInTheDocument();
    },
  );
});
