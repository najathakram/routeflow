import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ProductJumpLinks } from "./ProductJumpLinks";
import fs from "fs";
import path from "path";

/** K14 P01: the grid's pinned UNIT cells (z-10) must pass UNDER the jump strip, not over its tabs. */
const gridSource = fs.readFileSync(path.join(__dirname, "../../ProductPricesGrid.tsx"), "utf8");
const UNIT_CELL = gridSource.match(/const UNIT_CELL =\s*"([^"]*)"/)![1];

function z(className: string): number {
  const m = className.match(/(?:^|\s)z-(\d+)(?:\s|$)/);
  return m ? Number(m[1]) : 0;
}

it("draws the jump strip above the grid's pinned Unit cells", () => {
  render(
    <div>
      <ProductJumpLinks />
      <h1 id="h-product">Cola</h1>
      <h2 id="h-units">Units</h2>
    </div>,
  );
  const strip = screen.getByTestId("units-v2-jump");
  expect(z(strip.className)).toBeGreaterThan(z(UNIT_CELL));
});

it("stays under the pinned Saved line and Save bar (z-30)", () => {
  render(
    <div>
      <ProductJumpLinks />
      <h1 id="h-product">Cola</h1>
      <h2 id="h-units">Units</h2>
    </div>,
  );
  expect(z(screen.getByTestId("units-v2-jump").className)).toBeLessThan(30);
});
