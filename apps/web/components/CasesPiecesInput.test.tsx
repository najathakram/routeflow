import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { unitWords } from "@routeflow/pricing";
import { CasesPiecesInput } from "./CasesPiecesInput";

/** O1: the shared cases + loose-pieces control (Create's LineItemRow and Edit Items render it). */
const base = {
  unitsPerBox: 12,
  words: unitWords(),
  onSetBoxes: jest.fn(),
  onSetPieces: jest.fn(),
};

describe("CasesPiecesInput", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows cases, and loose pieces are opt-in behind '+ units'", () => {
    render(<CasesPiecesInput {...base} boxes={2} pieces={0} />);
    expect((screen.getByTitle(/number of whole/i) as HTMLInputElement).value).toBe("2");
    expect(screen.queryByLabelText(/^extra /i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /add extra/i }));
    expect(screen.getByLabelText(/^extra /i)).toBeInTheDocument();
  });

  it("shows the loose input whenever pieces > 0, and reports raw typed values", () => {
    render(<CasesPiecesInput {...base} boxes={1} pieces={5} />);
    fireEvent.change(screen.getByLabelText(/^extra /i), { target: { value: "7" } });
    expect(base.onSetPieces).toHaveBeenCalledWith(7);
    fireEvent.change(screen.getByTitle(/number of whole/i), { target: { value: "3" } });
    expect(base.onSetBoxes).toHaveBeenCalledWith(3);
  });

  it("SA-563: the remove-extra x is hidden at 0 cases", () => {
    const { rerender } = render(<CasesPiecesInput {...base} boxes={1} pieces={5} />);
    expect(screen.getByRole("button", { name: /remove extra/i })).toBeInTheDocument();
    rerender(<CasesPiecesInput {...base} boxes={0} pieces={5} />);
    expect(screen.queryByRole("button", { name: /remove extra/i })).toBeNull();
  });

  it("disabled locks every input and button", () => {
    render(<CasesPiecesInput {...base} boxes={1} pieces={0} disabled />);
    expect(screen.getByTitle(/number of whole/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /add extra/i })).toBeDisabled();
  });
});
