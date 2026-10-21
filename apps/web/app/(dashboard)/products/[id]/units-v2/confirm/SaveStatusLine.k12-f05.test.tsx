import * as React from "react";
import { render, screen } from "@testing-library/react";
import { PriceSaveStatusLine, savedDetail } from "./SaveStatusLine";
import type { LastSave } from "./types";

const undo = jest.fn();
const save = (patches: number, follows?: number): LastSave => ({
  auditId: "audit-1",
  revision: 7,
  undo: { patches: Array.from({ length: patches }, () => ({})), customerMoves: [] },
  follows,
});

describe("K12 F05: the saved line names the Auto prices that followed", () => {
  it("says 'Saved 1 price; 2 Auto prices followed.' beside Undo", () => {
    render(<PriceSaveStatusLine lastSave={save(1, 2)} undo={undo} />);
    const live = screen.getByRole("status");
    expect(live.textContent).toMatch(/Saved 1 price; 2 Auto prices followed\./);
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("uses the singular for one follower and says nothing extra for none", () => {
    expect(savedDetail({ patches: [{}], customerMoves: [] }, 1)).toBe(
      "1 price; 1 Auto price followed",
    );
    expect(savedDetail({ patches: [{}, {}], customerMoves: [] }, 0)).toBe("2 prices");
    expect(savedDetail({ patches: [{}, {}], customerMoves: [] })).toBe("2 prices");
  });
});
