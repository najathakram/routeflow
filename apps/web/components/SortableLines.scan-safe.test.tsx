import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createFieldScanRun } from "@/lib/scan-run";
import { SortableLines, useSortableLine, type LineMove } from "./SortableLines";

/**
 * W-1187 PR-2b scan safety (the class that failed #4288 and #4293): a wedge scanner types a code and Enter at machine speed
 * into whatever has focus. A drag handle that holds focus (or a keyboard move in progress) must not pick up, move or drop a
 * line for those keys, and the code must still reach the scan field.
 */
const LINES = [
  { id: "a", label: "Apple" },
  { id: "b", label: "Banana" },
  { id: "c", label: "Cherry" },
];

function Row({ id }: { id: string }) {
  const { setNodeRef, style, handle } = useSortableLine(id);
  return (
    <li ref={setNodeRef} style={style}>
      {handle}
      <span>{id}</span>
    </li>
  );
}

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: "l" + i, label: "Item " + (i + 1) }));
function Harness({
  onMove,
  onCode,
  count,
}: {
  onMove: (m: LineMove) => void;
  onCode: (c: string) => void;
  count?: number;
}) {
  const lines = count ? rows(count) : LINES;
  const scanRef = React.useRef<HTMLInputElement>(null);
  // the screen owns the scan destination (SA-1138): its capture hands a scan key to the scan field, like the order builder
  const run = React.useMemo(() => createFieldScanRun(), []);
  return (
    <div onKeyDownCapture={(e) => run.onKeyDown(e.nativeEvent, scanRef.current)}>
      <input
        ref={scanRef}
        aria-label="Scan"
        onKeyDown={(e) => {
          if (e.key === "Enter") onCode((e.target as HTMLInputElement).value);
        }}
      />
      <SortableLines lines={lines} onMove={onMove}>
        <ul>
          {lines.map((l) => (
            <Row key={l.id} id={l.id} />
          ))}
        </ul>
      </SortableLines>
    </div>
  );
}

/** dnd-kit attaches its key listener one macrotask after the pick-up. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const handle = (name: string) => screen.getByRole("button", { name: new RegExp(`^Move ${name},`) });
beforeEach(() => {
  // jsdom has no layout: give each row a 50 px box by its place so dnd-kit can tell which row a key press lands on
  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const li = this.closest("li");
    const i = li ? Array.from(li.parentElement!.children).indexOf(li) : 0;
    const top = this.tagName === "LI" || li ? i * 50 : 0;
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

describe("SortableLines: scan safety", () => {
  it("Enter on a focused handle does not pick the line up (Space does)", async () => {
    const onMove = jest.fn();
    render(<Harness onMove={onMove} onCode={jest.fn()} />);
    const h = handle("Banana");
    h.focus();
    fireEvent.keyDown(h, { key: "Enter", code: "Enter" });
    expect(h).not.toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    expect(h).toHaveAttribute("aria-pressed", "true");
  });

  it("a digit burst + Enter while a handle holds focus lands in the scan field and moves nothing", async () => {
    const onMove = jest.fn();
    const onCode = jest.fn();
    render(<Harness onMove={onMove} onCode={onCode} />);
    handle("Banana").focus();
    await userEvent.keyboard("0123456789{Enter}", { delay: null });
    expect(screen.getByLabelText("Scan")).toHaveFocus();
    expect(onCode).toHaveBeenCalledWith("0123456789");
    expect(onMove).not.toHaveBeenCalled();
    expect(handle("Banana")).not.toHaveAttribute("aria-pressed", "true");
  });

  it("a digit while a keyboard move is in progress cancels it and the line is not dropped elsewhere", async () => {
    const onMove = jest.fn();
    render(<Harness onMove={onMove} onCode={jest.fn()} />);
    const h = handle("Banana");
    h.focus();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { key: "5", code: "Digit5" });
    });
    fireEvent.keyDown(document, { key: "Enter", code: "Enter" });
    expect(onMove).not.toHaveBeenCalled();
    expect(handle("Banana")).not.toHaveAttribute("aria-pressed", "true");
  });

  it("control: a person's Space, ArrowDown, Space still moves the line one place", async () => {
    const onMove = jest.fn();
    render(<Harness onMove={onMove} onCode={jest.fn()} />);
    const h = handle("Banana");
    h.focus();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(document, { key: " ", code: "Space" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0]).toMatchObject({ movedId: "b", toIndex: 2 });
  });

  it("Alt+ArrowDown on the handle moves one place each press, however fast", async () => {
    const onMove = jest.fn();
    render(<Harness onMove={onMove} onCode={jest.fn()} />);
    const h = handle("Banana");
    h.focus();
    fireEvent.keyDown(h, { key: "ArrowDown", code: "ArrowDown", altKey: true });
    fireEvent.keyDown(h, { key: "ArrowDown", code: "ArrowDown", altKey: true });
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it.each([5, 33])(
    "a held arrow (10 repeats, %i ms apart) moves the line 10 places and the move stays active",
    async (gap) => {
      const onMove = jest.fn();
      render(<Harness onMove={onMove} onCode={jest.fn()} count={12} />);
      const h = screen.getByRole("button", { name: /^Move Item 2,/ });
      h.focus();
      fireEvent.keyDown(h, { key: " ", code: "Space" });
      await settle();
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown", repeat: i > 0 });
          await new Promise((r) => setTimeout(r, gap));
        });
      }
      expect(h).toHaveAttribute("aria-pressed", "true");
      await act(async () => {
        fireEvent.keyDown(document, { key: " ", code: "Space" });
      });
      await settle();
      expect(onMove).toHaveBeenCalledTimes(1);
      expect(onMove.mock.calls[0][0]).toMatchObject({ movedId: "l1", toIndex: 11 });
    },
  );

  it("a modifier key alone mid-move does nothing; a printable key still cancels", async () => {
    const onMove = jest.fn();
    render(<Harness onMove={onMove} onCode={jest.fn()} />);
    const h = handle("Banana");
    h.focus();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await settle();
    for (const key of ["Shift", "Control", "Alt", "Meta"]) {
      await act(async () => {
        fireEvent.keyDown(document, { key, code: key + "Left" });
      });
    }
    expect(h).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      fireEvent.keyDown(document, { key: "5", code: "Digit5" });
    });
    expect(h).not.toHaveAttribute("aria-pressed", "true");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("a scan key typed on the handle mid-move cancels it and focus is not pulled back to the handle", async () => {
    render(<Harness onMove={jest.fn()} onCode={jest.fn()} />);
    const h = handle("Banana");
    h.focus();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await settle();
    await act(async () => {
      fireEvent.keyDown(h, { key: "5", code: "Digit5" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(h).not.toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Scan")).toHaveFocus();
  });
});
