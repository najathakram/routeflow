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

  const pressOnList = async (owner: (dialog: HTMLElement) => string) => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} title="T">
        <p>body</p>
      </Modal>,
    );
    const list = document.createElement("div");
    list.setAttribute("data-anchored-list", "");
    list.setAttribute("data-anchored-owner", owner(screen.getByRole("dialog")));
    document.body.appendChild(list);
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.pointerDown(list);
    list.remove();
    return onClose;
  };

  it("a press inside a list anchored in THIS dialog is not an outside interaction", async () => {
    expect(await pressOnList((d) => d.id)).not.toHaveBeenCalled();
  });

  it("a list anchored in a different dialog does not exempt this one", async () => {
    expect(await pressOnList(() => "some-other-dialog")).toHaveBeenCalled();
  });
});
