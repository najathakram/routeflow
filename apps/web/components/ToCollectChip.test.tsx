import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ToCollectChip } from "./ToCollectChip";

/**
 * SA-1026 A: the "To collect" chip. The server derives the state (clients never compute it) and sends it to staff only.
 * TO_COLLECT and UNKNOWN both SHOW (fail closed: shown, never hidden); NONE and an absent field show nothing.
 */
describe("ToCollectChip", () => {
  it.each(["TO_COLLECT", "UNKNOWN"] as const)("%s shows the word", (state) => {
    render(<ToCollectChip state={state} />);
    expect(screen.getByText("To collect")).toBeInTheDocument();
  });

  it.each([["NONE"], [undefined], [null]] as const)("%s shows nothing", (state) => {
    const { container } = render(<ToCollectChip state={state} />);
    expect(container).toBeEmptyDOMElement();
  });
});
