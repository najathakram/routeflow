import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as Dialog from "@radix-ui/react-dialog";
import { SortableLines, useSortableLine } from "./SortableLines";

/** B1315: Escape that cancels a keyboard line move must not also reach the dialog the lines sit in. */
const LINES = [
  { id: "a", label: "Apple" },
  { id: "b", label: "Banana" },
];

function Row({ id }: { id: string }) {
  const { setNodeRef, style, handle } = useSortableLine(id);
  return (
    <li ref={setNodeRef} style={style}>
      {handle}
    </li>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function Harness({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Content aria-describedby={undefined}>
        <Dialog.Title>Create Order</Dialog.Title>
        <SortableLines lines={LINES} onMove={jest.fn()}>
          <ul>
            {LINES.map((l) => (
              <Row key={l.id} id={l.id} />
            ))}
          </ul>
        </SortableLines>
      </Dialog.Content>
    </Dialog.Root>
  );
}

describe("SortableLines: Escape during a keyboard move", () => {
  beforeEach(() => {
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const li = this.closest("li");
      const i = li ? Array.from(li.parentElement!.children).indexOf(li) : 0;
      const top = li ? i * 50 : 0;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 200,
        bottom: top + 50,
        width: 200,
        height: 50,
        toJSON() {},
      } as DOMRect;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it("cancels the move and leaves the dialog open; a later Escape closes the dialog", async () => {
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    const h = screen.getByRole("button", { name: /^Move Banana,/ });
    h.focus();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await settle();
    expect(h).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      fireEvent.keyDown(h, { key: "Escape", code: "Escape" });
    });
    await settle();
    expect(h).not.toHaveAttribute("aria-pressed", "true");
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(h, { key: "Escape", code: "Escape" });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
