import * as React from "react";
import { render, fireEvent } from "@testing-library/react";
import { useNoShellScroll } from "./use-no-shell-scroll";

// K11-16: the dashboard's right column is `overflow-hidden`, which still lets a programmatic scroll (scrollIntoView,
// focus, a native click that scrolls its target into view) move it. At 1440 a mouse Save scrolled it by the header's
// 64 px, so the header left the screen and the saved line pinned 64 px short. The wrapper must never keep a scroll.
function Shell() {
  const ref = React.useRef<HTMLDivElement>(null);
  useNoShellScroll(ref);
  return <div ref={ref} data-testid="shell" />;
}

describe("useNoShellScroll", () => {
  it("puts the wrapper back at 0,0 when something scrolls it", () => {
    const { getByTestId } = render(<Shell />);
    const shell = getByTestId("shell");
    shell.scrollTop = 64;
    shell.scrollLeft = 12;
    fireEvent.scroll(shell);
    expect(shell.scrollTop).toBe(0);
    expect(shell.scrollLeft).toBe(0);
  });

  it("stops listening after unmount", () => {
    const { getByTestId, unmount } = render(<Shell />);
    const shell = getByTestId("shell");
    unmount();
    shell.scrollTop = 64;
    fireEvent.scroll(shell);
    expect(shell.scrollTop).toBe(64);
  });
});
