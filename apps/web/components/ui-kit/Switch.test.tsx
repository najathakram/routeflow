import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "@routeflow/ui/web";
import { mockReducedMotion } from "./matchMedia";

beforeEach(() => mockReducedMotion(false));

function Harness({ disabled }: { disabled?: boolean }) {
  const [on, setOn] = React.useState(false);
  return <Switch checked={on} onCheckedChange={setOn} label="Urgent" disabled={disabled} />;
}

describe("Switch", () => {
  it("is a switch whose aria-checked flips on click", async () => {
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Urgent" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("Space and Enter toggle it", async () => {
    render(<Harness />);
    const sw = screen.getByRole("switch");
    sw.focus();
    await userEvent.keyboard(" ");
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Enter}");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("clicking the label toggles", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("Urgent"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("disabled is inert, including via its label", async () => {
    render(<Harness disabled />);
    const sw = screen.getByRole("switch");
    expect(sw).toBeDisabled();
    await userEvent.click(sw);
    await userEvent.click(screen.getByText("Urgent"));
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("has a visible focus ring class", () => {
    render(<Harness />);
    expect(screen.getByRole("switch").className).toMatch(/focus-visible:ring-2/);
  });

  it("accepts aria-labelledby instead of a label", () => {
    render(
      <>
        <span id="x">Credit note</span>
        <Switch checked={false} onCheckedChange={() => {}} aria-labelledby="x" />
      </>,
    );
    expect(screen.getByRole("switch", { name: "Credit note" })).toBeInTheDocument();
  });
});
