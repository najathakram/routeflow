import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@routeflow/ui/web";
import { QtyStepper } from "./QtyStepper";

/**
 * Buyer-tile stepper: ONE segmented 44px control [ − / trash | qty | + ]; no separate remove button. Class-level
 * checks (RTL); the rendered pixel sizes are proven by Playwright. Removal at any qty offers an Undo toast.
 */
function Harness({ initial = 2, size }: { initial?: number; size?: "sm" | "md" }) {
  const [line, setLine] = React.useState<number | null>(initial);
  if (line === null) return <p>Add</p>;
  return (
    <QtyStepper
      qty={line}
      name="Widget"
      size={size}
      onUpdate={setLine}
      onRemove={() => setLine(null)}
      onRestore={() => setLine(1)}
    />
  );
}

const setup = (initial = 2, size?: "sm" | "md") =>
  render(
    <ToastProvider>
      <Harness initial={initial} size={size} />
    </ToastProvider>,
  );

describe("QtyStepper", () => {
  it("shows − (not the trash) at qty 2", () => {
    setup(2);
    expect(screen.getByRole("button", { name: "Decrease Widget" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Widget from cart" })).toBeNull();
  });

  it("shows the trash (not −) at qty 1", () => {
    setup(1);
    expect(screen.getByRole("button", { name: "Remove Widget from cart" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decrease Widget" })).toBeNull();
  });

  it("has no separate remove button: exactly two buttons and one field", () => {
    setup(2);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("trash removes the line, shows Removed + Undo, and Undo restores qty 1", async () => {
    setup(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove Widget from cart" }));
    expect(await screen.findByText("Removed Widget.")).toBeInTheDocument();
    expect(screen.getByText("Add")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("textbox", { name: "Quantity" })).toHaveValue("1");
  });

  it("typing 0 removes with the same Undo", async () => {
    setup(5);
    const field = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(await screen.findByText("Removed Widget.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("clearing the field removes too", async () => {
    setup(3);
    const field = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(await screen.findByText("Removed Widget.")).toBeInTheDocument();
  });

  it("Enter commits a typed quantity", () => {
    setup(2);
    const field = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
    expect(field).toHaveValue("7");
  });

  it("Tab order is −/trash, qty, +", async () => {
    const user = userEvent.setup();
    setup(2);
    await user.tab();
    expect(screen.getByRole("button", { name: "Decrease Widget" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Increase Widget" })).toHaveFocus();
  });

  it.each([2, 1])("each button has a 44px hit area at qty %s", (qty) => {
    setup(qty);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn.className).toMatch(/\bmin-h-11\b/);
      expect(btn.className).toMatch(/\bmin-w-11\b/);
    }
  });

  it("uses the 44 / flex / 44 grid, a numeric tabular field with no spinners", () => {
    const { container } = setup(2);
    const root = container.querySelector("[data-qty-stepper]") as HTMLElement;
    expect(root.className).toContain("grid-cols-[44px_minmax(36px,1fr)_44px]");
    expect(root.className).toMatch(/\bgap-0\b/);
    expect(root.className).toMatch(/\bh-11\b/);
    const field = screen.getByRole("textbox", { name: "Quantity" });
    expect(field).toHaveAttribute("inputmode", "numeric");
    expect(field.className).toMatch(/\bmin-w-\[36px\]/);
    expect(field.className).toMatch(/\btabular-nums\b/);
    expect(field.className).toMatch(/\btext-center\b/);
    expect(field.className).toContain("[&::-webkit-inner-spin-button]:appearance-none");
    expect(field.className).toContain("[appearance:textfield]");
  });
});
