import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { StaleRevisionNotice, isLadderRevisionStale } from "./StaleRevisionNotice";

describe("StaleRevisionNotice", () => {
  it("renders the exact copy and calls reload", () => {
    const onReload = jest.fn();
    render(<StaleRevisionNotice onReload={onReload} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Prices changed since you opened this; review and save again",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload prices" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("recognises a 409 LADDER_REVISION_STALE and nothing else", () => {
    const err = (status: number, code: string) => ({ response: { status, data: { code } } });
    expect(isLadderRevisionStale(err(409, "LADDER_REVISION_STALE"))).toBe(true);
    expect(isLadderRevisionStale(err(409, "OTHER"))).toBe(false);
    expect(isLadderRevisionStale(err(400, "LADDER_REVISION_STALE"))).toBe(false);
    expect(isLadderRevisionStale(null)).toBe(false);
  });
});
