import * as React from "react";
import { render, screen } from "@testing-library/react";
import { BusinessProfileChoices } from "./BusinessProfileChoices";
import { PROFILES_FIXTURE } from "./__fixtures__/profiles.fixtures";

describe("BusinessProfileChoices", () => {
  it("review nit: a disabled profile shows why, and the radio points at that note", () => {
    render(
      <BusinessProfileChoices
        profiles={PROFILES_FIXTURE}
        value=""
        onChange={jest.fn()}
        name="t"
        legend="Profiles"
      />,
    );
    const radio = screen.getByRole("radio", { name: /In-store retailer/ });
    expect(radio).toBeDisabled();
    expect(radio).toHaveAccessibleDescription("Not available for this tenant.");
    expect(screen.getByRole("radio", { name: /Delivery distributor/ })).not.toHaveAttribute(
      "aria-describedby",
    );
  });
});
