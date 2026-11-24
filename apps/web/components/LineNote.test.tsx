import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { LineNote } from "./LineNote";

describe("LineNote", () => {
  it("renders a list note as one list item per entry", () => {
    render(<LineNote note="ACME MINT 20 BOX, ACME CHERRY - 14, ACME LEMON DROP 10, ACME ICE 10" />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "ACME MINT 20 BOX",
      "ACME CHERRY - 14",
      "ACME LEMON DROP 10",
      "ACME ICE 10",
    ]);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(4);
  });

  it("renders a sentence note as one paragraph with no list", () => {
    const { container } = render(
      <LineNote note="Leave at the back door, call first" className="text-xs" />,
    );
    expect(screen.queryByRole("list")).toBeNull();
    const paras = container.querySelectorAll("p");
    expect(paras).toHaveLength(1);
    expect(paras[0].textContent).toBe("Leave at the back door, call first");
    expect(paras[0].className).toEqual(expect.stringContaining("whitespace-pre-line"));
  });

  it("passes the caller's className to the list", () => {
    render(<LineNote note="ACME MINT 20, ACME ICE 10" className="text-xs text-navy/60" />);
    expect(screen.getByRole("list").className).toEqual(expect.stringContaining("text-navy/60"));
  });
});
