import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { DriverAppBanner } from "./DriverAppBanner";

// Owner ruling (mobile-web-proxy-redesign): the DRIVER-role nudge on the web
// dashboard toward the installed driver app.
describe("DriverAppBanner", () => {
  it("is not rendered when not visible", () => {
    render(<DriverAppBanner visible={false} onDismiss={jest.fn()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("links to the driver app's own login screen when visible", () => {
    render(<DriverAppBanner visible onDismiss={jest.fn()} />);

    const link = screen.getByRole("link", { name: /open the driver app/i });
    expect(link).toHaveAttribute("href", "https://routeflowmobile-production.up.railway.app/login");
  });

  it("calls onDismiss when the dismiss button is clicked", async () => {
    const onDismiss = jest.fn();
    const user = userEvent.setup();
    render(<DriverAppBanner visible onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
