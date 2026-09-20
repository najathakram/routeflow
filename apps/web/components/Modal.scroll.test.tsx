import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Modal } from "@routeflow/ui/web";

/**
 * `Modal` is centred with a -translate-y-1/2, so a dialog taller than the viewport spills off both
 * edges and its header X / footer buttons become unreachable. `scroll` is the OPT-IN cap. jsdom has
 * no layout, so this pins the structure that matters: opt-in caps the height and scrolls only the
 * body (X and footer outside the scroller); the DEFAULT is untouched, because a default scroll
 * container would clip absolutely-positioned typeaheads inside existing dialogs.
 */
const tall = (scroll?: boolean) =>
  render(
    <Modal open onClose={() => {}} title="Tall" footer={<button>Save</button>} scroll={scroll}>
      <p>body</p>
    </Modal>,
  );

describe("Modal scroll (opt-in)", () => {
  it("scroll: caps the height and scrolls only the body, never the header X or footer", () => {
    tall(true);
    expect(screen.getByRole("dialog").className).toMatch(/max-h-\[92vh\]/);
    const scroller = screen.getByText("body").parentElement as HTMLElement;
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.contains(screen.getByRole("button", { name: "Close" }))).toBe(false);
    expect(scroller.contains(screen.getByRole("button", { name: "Save" }))).toBe(false);
  });

  it("default: no height cap and no scroll container (nothing that could clip a dropdown)", () => {
    tall();
    expect(screen.getByRole("dialog").className).not.toMatch(/max-h-|overflow-/);
    expect((screen.getByText("body").parentElement as HTMLElement).className).not.toMatch(
      /overflow-/,
    );
  });
});
