import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "@routeflow/ui/web";

describe("Modal onInteractOutside (opt-in)", () => {
  it("default: an outside pointer-down closes the dialog", async () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} title="T">
        <p>body</p>
      </Modal>,
    );
    // Radix arms its outside listener on a timer after mount.
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("a handler that prevents default keeps it open", async () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} title="T" onInteractOutside={(e) => e.preventDefault()}>
        <p>body</p>
      </Modal>,
    );
    // Radix arms its outside listener on a timer after mount.
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });
});
