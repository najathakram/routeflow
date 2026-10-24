import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Modal } from "@routeflow/ui";

/**
 * W-710 / FE1: a dialog eases out on the way in (about 200 ms) and eases in on the way out (about
 * 150 ms), instead of tailwindcss-animate's default (CSS `ease` at 150 ms). jsdom runs no animation, so this pins the
 * classes that the tailwindcss-animate plugin turns into the timing function and duration, and
 * that reduced motion still switches every animation off.
 */
describe("Modal motion", () => {
  function renderOpen() {
    render(
      <Modal open onClose={() => {}} title="Example">
        <p>Body</p>
      </Modal>,
    );
    return screen.getByRole("dialog");
  }

  it("the dialog eases out at 200 ms on enter and eases in at 150 ms on exit", () => {
    const classes = renderOpen().className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "data-[state=open]:ease-out",
        "data-[state=open]:duration-200",
        "data-[state=closed]:ease-in",
        "data-[state=closed]:duration-150",
      ]),
    );
  });

  it("the backdrop uses the same curves", () => {
    renderOpen();
    const overlay = document.querySelector("[data-modal-overlay]") as HTMLElement;
    const classes = overlay.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "data-[state=open]:ease-out",
        "data-[state=open]:duration-200",
        "data-[state=closed]:ease-in",
        "data-[state=closed]:duration-150",
      ]),
    );
  });

  it("reduced motion still switches the animation off", () => {
    expect(renderOpen().className).toContain("motion-reduce:!animate-none");
    const overlay = document.querySelector("[data-modal-overlay]") as HTMLElement;
    expect(overlay.className).toContain("motion-reduce:!animate-none");
  });
});
