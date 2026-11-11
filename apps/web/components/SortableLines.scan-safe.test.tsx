import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

let now = 1000;
function Harness({
  onMove,
  onCode,
}: {
  onMove: (m: LineMove) => void;
  onCode: (c: string) => void;
}) {
  const scanRef = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={scanRef}
        aria-label="Scan"
        onKeyDown={(e) => {
          if (e.key === "Enter") onCode((e.target as HTMLInputElement).value);
        }}
      />
      <SortableLines lines={LINES} onMove={onMove} scanTarget={() => scanRef.current}>
        <ul>
          {LINES.map((l) => (
            <Row key={l.id} id={l.id} />
          ))}
        </ul>
      </SortableLines>
    </>
  );
}

/** dnd-kit attaches its key listener one macrotask after the pick-up. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const handle = (name: string) => screen.getByRole("button", { name: new RegExp(`^Move ${name},`) });
/** A human's key rhythm: 120 ms between keys. */
const human = () => {
  now += 120;
};

beforeEach(() => {
  now += 10_000; // the clock only moves forward, as the guard remembers the last key across tests
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
  jest.spyOn(performance, "now").mockImplementation(() => now);
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
    human();
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
    human();
    await act(async () => {
      fireEvent.keyDown(document, { key: "5", code: "Digit5" });
    });
    human();
    fireEvent.keyDown(document, { key: "Enter", code: "Enter" });
    expect(onMove).not.toHaveBeenCalled();
    expect(handle("Banana")).not.toHaveAttribute("aria-pressed", "true");
  });

  it("a burst of arrow keys + Enter mid-move moves and drops nothing", async () => {
    const onMove = jest.fn();
    render(<Harness onMove={onMove} onCode={jest.fn()} />);
    const h = handle("Banana");
    h.focus();
    fireEvent.keyDown(h, { key: " ", code: "Space" });
    await settle();
    // machine speed: no human pause between these
    for (const code of ["ArrowDown", "ArrowDown", "ArrowUp", "ArrowDown"]) {
      fireEvent.keyDown(document, { key: code, code });
      now += 2;
    }
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
    human();
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
    });
    human();
    await act(async () => {
      fireEvent.keyDown(document, { key: " ", code: "Space" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0]).toMatchObject({ movedId: "b", toIndex: 2 });
  });

  it("Alt+ArrowDown on the handle moves one place, but not at scanner speed", async () => {
    const onMove = jest.fn();
    render(<Harness onMove={onMove} onCode={jest.fn()} />);
    const h = handle("Banana");
    h.focus();
    human();
    fireEvent.keyDown(h, { key: "ArrowDown", code: "ArrowDown", altKey: true });
    expect(onMove).toHaveBeenCalledTimes(1);
    now += 2; // the next one is at machine speed after the last key
    fireEvent.keyDown(h, { key: "ArrowDown", code: "ArrowDown", altKey: true });
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});
