import { render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { PiecesPerBoxValue } from "./PiecesPerBoxValue";

describe("PiecesPerBoxValue", () => {
  it("shows the short piece word for a boxed product", () => {
    render(<PiecesPerBoxValue unitsPerBox={12} />);
    expect(screen.getByText("12 pcs")).toBeInTheDocument();
  });
  it("accepts the API's string decimal", () => {
    render(<PiecesPerBoxValue unitsPerBox="12" />);
    expect(screen.getByText("12 pcs")).toBeInTheDocument();
  });
  it("reads 'Sold individually' at 1 piece", () => {
    render(<PiecesPerBoxValue unitsPerBox={1} />);
    expect(screen.getByText("Sold individually")).toBeInTheDocument();
  });
  it("reads 'Set per variant' on a family, whatever its own value", () => {
    render(<PiecesPerBoxValue unitsPerBox={1} isFamily />);
    expect(screen.getByText("Set per variant")).toBeInTheDocument();
    expect(screen.queryByText("Sold individually")).not.toBeInTheDocument();
  });
  it("the boxed product page renders the value through this component", () => {
    const src = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
    expect(src).toContain(
      "<PiecesPerBoxValue unitsPerBox={product.unitsPerBox} isFamily={isFamily} />",
    );
    expect(src).not.toContain("} units`");
  });
});
