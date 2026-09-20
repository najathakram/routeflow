import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Modal } from "@routeflow/ui/web";

/**
 * The shared Modal is centred with a -translate-y-1/2, so a dialog taller than the viewport spills
 * off both edges and its header X / footer buttons become unreachable (body scroll is locked).
 * jsdom has no layout, so this pins the STRUCTURE that keeps them reachable: the content is
 * height-capped, and the close button and footer sit OUTSIDE the one scrolling region.
 */
describe("Modal scroll structure", () => {
  it("caps the height and scrolls only the body, never the header X or footer", () => {
    render(
      <Modal open onClose={() => {}} title="Tall" footer={<button>Save</button>}>
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toMatch(/max-h-\[92vh\]/);
    const scroller = screen.getByText("body").parentElement as HTMLElement;
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.contains(screen.getByRole("button", { name: "Close" }))).toBe(false);
    expect(scroller.contains(screen.getByRole("button", { name: "Save" }))).toBe(false);
  });
});
