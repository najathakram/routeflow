import { render, screen } from "@testing-library/react";
import { SkipToContentLink } from "./SkipToContentLink";

describe("SkipToContentLink", () => {
  it("cancels the hash navigation, focuses #main-content, leaves the hash empty", () => {
    render(
      <div>
        <SkipToContentLink />
        <main id="main-content" tabIndex={-1} />
      </div>,
    );
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByText("Skip to content").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("main-content"));
    expect(window.location.hash).toBe("");
  });

  it("does not throw when the main region is absent", () => {
    render(<SkipToContentLink />);
    expect(() => screen.getByText("Skip to content").click()).not.toThrow();
  });
});
