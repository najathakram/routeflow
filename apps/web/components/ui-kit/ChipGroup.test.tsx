import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChipGroup } from "@routeflow/ui/web";
import { mockReducedMotion } from "./matchMedia";

beforeEach(() => mockReducedMotion(false));

const opts = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
];

function Single({ initial = "a" as string | null }) {
  const [v, setV] = React.useState<string | null>(initial);
  return <ChipGroup ariaLabel="Pick" options={opts} value={v} onChange={setV} />;
}

describe("ChipGroup", () => {
  it("single: radiogroup + radios with aria-checked", async () => {
    render(<Single />);
    expect(screen.getByRole("radiogroup", { name: "Pick" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Gamma" }));
    expect(screen.getByRole("radio", { name: "Gamma" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("aria-checked", "false");
  });

  it("roving tabindex: only the selected chip is a tab stop; nothing selected → first enabled", () => {
    const a = render(<Single />);
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Gamma" })).toHaveAttribute("tabindex", "-1");
    a.unmount();
    render(<Single initial={null} />);
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("tabindex", "0");
    expect(
      screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false"),
    ).toBe(true);
  });

  it("arrow keys move and select, skipping disabled", async () => {
    render(<Single />);
    screen.getByRole("radio", { name: "Alpha" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Gamma" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Gamma" })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Gamma" })).toHaveFocus();
  });

  it("a disabled chip cannot be chosen", async () => {
    const onChange = jest.fn();
    render(<ChipGroup ariaLabel="Pick" options={opts} value="a" onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Beta" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("multiple: group + aria-pressed toggles", async () => {
    const onChange = jest.fn();
    render(
      <ChipGroup multiple ariaLabel="Many" options={opts} value={["a"]} onChange={onChange} />,
    );
    expect(screen.getByRole("group", { name: "Many" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Gamma" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Gamma" }));
    expect(onChange).toHaveBeenCalledWith(["a", "c"]);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole("button", { name: "Beta" })).toBeDisabled();
  });
});
