import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Input, Select, Textarea } from "@routeflow/ui/web";

/** V12: the shared controls draw their default border from the --field token, and keep the error colour. */
describe("shared form controls use the field border (V12)", () => {
  it("Input", () => {
    render(<Input label="Name" />);
    const el = screen.getByLabelText("Name");
    expect(el).toHaveClass("border-field");
    expect(el).not.toHaveClass("border-surface-border");
  });

  it("Select", () => {
    render(<Select label="Kind" options={[{ value: "a", label: "A" }]} />);
    const el = screen.getByLabelText("Kind");
    expect(el).toHaveClass("border-field");
    expect(el).not.toHaveClass("border-surface-border");
  });

  it("Textarea", () => {
    render(<Textarea label="Notes" />);
    const el = screen.getByLabelText("Notes");
    expect(el).toHaveClass("border-field");
    expect(el).not.toHaveClass("border-surface-border");
  });

  it("an error still wins over the field border", () => {
    render(<Input label="Name" error="Required" />);
    const el = screen.getByLabelText("Name");
    expect(el).toHaveClass("border-danger");
    expect(el).not.toHaveClass("border-field");
  });

  it("the focus state keeps its own border handling", () => {
    render(<Input label="Name" />);
    expect(screen.getByLabelText("Name")).toHaveClass("focus:border-transparent");
  });
});
