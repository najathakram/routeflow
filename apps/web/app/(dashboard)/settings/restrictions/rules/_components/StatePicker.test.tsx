import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { StatePicker } from "./StatePicker";

function Host({ initial = [] as string[], error }: { initial?: string[]; error?: string }) {
  const [v, setV] = React.useState(initial);
  return <StatePicker value={v} onChange={setV} error={error} />;
}
const box = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });

describe("StatePicker", () => {
  it("ticks and unticks states, keeping selection order, and shows them as chips", () => {
    render(<Host />);
    fireEvent.click(box("Texas"));
    fireEvent.click(box("Florida"));
    const chips = screen.getByRole("list", { name: "Selected states" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((l) => l.textContent),
    ).toEqual(["TX ×", "FL ×"]);
    fireEvent.click(box("Texas"));
    expect(
      within(screen.getByRole("list", { name: "Selected states" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(box("Texas")).not.toBeChecked();
  });

  it("a chip removes its state", () => {
    render(<Host initial={["TX", "FL"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove TX" }));
    expect(box("Texas")).not.toBeChecked();
    expect(box("Florida")).toBeChecked();
  });

  it("search filters by name (any case) or exact code, and says when nothing matches", () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText("Search states"), { target: { value: "new" } });
    expect(screen.getByRole("checkbox", { name: /^New York/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /^Texas/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search states"), { target: { value: "tx" } });
    expect(screen.getByRole("checkbox", { name: /^Texas/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search states"), { target: { value: "zzzz" } });
    expect(screen.getByText("No matching states")).toBeInTheDocument();
  });

  it("a selection made under a search survives clearing it, and shows the error text", () => {
    render(<Host error="Pick at least one state" />);
    expect(screen.getByText("Pick at least one state")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search states"), { target: { value: "ohio" } });
    fireEvent.click(box("Ohio"));
    fireEvent.change(screen.getByLabelText("Search states"), { target: { value: "" } });
    expect(box("Ohio")).toBeChecked();
  });
});
