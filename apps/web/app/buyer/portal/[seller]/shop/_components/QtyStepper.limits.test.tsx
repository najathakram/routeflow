import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { BUYER_LINE_QTY_MAX } from "@routeflow/types";
import { QtyStepper } from "./QtyStepper";

/**
 * B1382 (SA-1281 part 3): the box stops at the server's own line limit, from one shared constant, and a
 * negative entry never removes. Only 0, an empty box or the trash removes (always with Undo).
 */
const LIMIT_LINE = "The most you can order at once is 100,000.";
const NEGATIVE_LINE = "Enter 1 or more. Enter 0 to remove.";

function Harness({ initial = 5 }: { initial?: number }) {
  const [line, setLine] = React.useState<number | null>(initial);
  if (line === null) return <p>Add</p>;
  return (
    <QtyStepper
      qty={line}
      name="Widget"
      onUpdate={setLine}
      onRemove={() => setLine(null)}
      onRestore={() => setLine(1)}
    />
  );
}

const setup = (initial = 5) =>
  render(
    <ToastProvider>
      <Harness initial={initial} />
    </ToastProvider>,
  );

const type = (value: string) => {
  const field = screen.getByRole("textbox", { name: "Quantity" });
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
  return field;
};

describe("QtyStepper limits (B1382)", () => {
  it("the shared limit is the server's 100,000", () => {
    expect(BUYER_LINE_QTY_MAX).toBe(100_000);
  });

  it("clamps 99999999 to the limit and shows the limit line", async () => {
    setup();
    const field = type("99999999");
    expect(field).toHaveValue("100000");
    expect(await screen.findByText(LIMIT_LINE)).toBeInTheDocument();
  });

  it("accepts exactly 100000 with no line", () => {
    setup();
    const field = type("100000");
    expect(field).toHaveValue("100000");
    expect(screen.queryByText(LIMIT_LINE)).toBeNull();
  });

  it("clamps 100001 to the limit with the line", async () => {
    setup();
    const field = type("100001");
    expect(field).toHaveValue("100000");
    expect(await screen.findByText(LIMIT_LINE)).toBeInTheDocument();
  });

  it("a huge pasted number clamps too", async () => {
    setup();
    const field = type("99999999999999999999999");
    expect(field).toHaveValue("100000");
    expect(await screen.findByText(LIMIT_LINE)).toBeInTheDocument();
  });

  it("the + button never goes past the limit", async () => {
    setup(100000);
    fireEvent.click(screen.getByRole("button", { name: "Increase Widget" }));
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveValue("100000");
    expect(await screen.findByText(LIMIT_LINE)).toBeInTheDocument();
  });

  it("-5 reverts to the current quantity, keeps the item, and shows the line", async () => {
    setup(5);
    const field = type("-5");
    expect(field).toHaveValue("5");
    expect(screen.queryByText("Removed Widget.")).toBeNull();
    expect(await screen.findByText(NEGATIVE_LINE)).toBeInTheDocument();
    expect(screen.queryByText("Add")).toBeNull();
  });

  it.each(["1e9", "12.5", "abc"])("a pasted %s reverts, never removes", async (value) => {
    setup(5);
    const field = type(value);
    expect(field).toHaveValue("5");
    expect(screen.queryByText("Removed Widget.")).toBeNull();
    expect(await screen.findByText(NEGATIVE_LINE)).toBeInTheDocument();
  });

  it("spaces around a whole number are fine", () => {
    setup(5);
    expect(type("  12 ")).toHaveValue("12");
  });

  it("0 removes with Undo (guard)", async () => {
    setup(5);
    type("0");
    expect(await screen.findByText("Removed Widget.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("an empty box removes with Undo (guard)", async () => {
    setup(5);
    type("");
    expect(await screen.findByText("Removed Widget.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("the stepper reads the shared constant, with no literal limit", () => {
    const src = readFileSync(join(__dirname, "QtyStepper.tsx"), "utf8");
    expect(src).toContain("BUYER_LINE_QTY_MAX");
    expect(src).not.toMatch(/100_?000/);
  });
});
