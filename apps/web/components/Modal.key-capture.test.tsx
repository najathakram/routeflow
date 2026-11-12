import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "@routeflow/ui/web";

/** W-1188 r4: Modal.onKeyDownCapture sees a key pressed anywhere in the dialog, the header X included, before the control. */
describe("Modal onKeyDownCapture", () => {
  it("is called for a key on a body control and on the header X, before the control's own handler", async () => {
    const order: string[] = [];
    const onKeyDownCapture = jest.fn((e: React.KeyboardEvent) => order.push(`capture:${e.key}`));
    render(
      <Modal open onClose={jest.fn()} title="T" onKeyDownCapture={onKeyDownCapture}>
        <button type="button" onKeyDown={() => order.push("button")}>
          inside
        </button>
      </Modal>,
    );
    const user = userEvent.setup({ delay: null });
    screen.getByRole("button", { name: "inside" }).focus();
    await user.keyboard("a");
    screen.getByRole("button", { name: "Close" }).focus();
    await user.keyboard("b");
    expect(order).toEqual(["capture:a", "button", "capture:b"]);
  });

  it("changes nothing for a dialog that does not pass it", async () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} title="T">
        <button type="button">inside</button>
      </Modal>,
    );
    await userEvent.setup({ delay: null }).keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
