import * as React from "react";
import { act, fireEvent, renderHook } from "@testing-library/react";
import { useCartLineOrder } from "./use-cart-line-order";

/**
 * W-1187 PR-2b: the cart's line move (order builder + counter). A local list, no request: a move reorders the array,
 * says "Moved X to line N" once with Undo, and Ctrl/Cmd+Z takes it back when focus is not in a text field.
 */
type Toast = { title: string; action?: { label: string; onClick: () => void } };
let toastSeq = 0;
const mockToast = jest.fn((o: Toast): string => {
  void o;
  return `t${++toastSeq}`;
});
const mockDismiss = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast, dismiss: mockDismiss }),
}));

type L = { id: string; name: string };
const L3: L[] = [
  { id: "a", name: "Apple" },
  { id: "b", name: "Banana" },
  { id: "c", name: "Cherry" },
];

function setup(
  opts: { enabled?: boolean; afterMove?: () => void; initial?: L[]; keyboardUndo?: boolean } = {},
) {
  return renderHook(() => {
    const [lines, setLines] = React.useState<L[]>(opts.initial ?? L3);
    const order = useCartLineOrder<L>({
      lines,
      setLines,
      idOf: (l) => l.id,
      labelOf: (l) => l.name,
      enabled: opts.enabled ?? true,
      afterMove: opts.afterMove,
      keyboardUndo: opts.keyboardUndo,
    });
    return { lines, setLines, order };
  });
}
const ids = (r: { current: { lines: L[] } }) => r.current.lines.map((l) => l.id).join("");
const lastToast = (): Toast => mockToast.mock.calls[mockToast.mock.calls.length - 1][0];
const move = (list: string[], movedId: string, toIndex: number) => ({
  ids: list,
  movedId,
  toIndex,
});

beforeEach(() => jest.clearAllMocks());

describe("useCartLineOrder", () => {
  it("a move reorders the array and says 'Moved X to line N' with Undo", () => {
    const { result } = setup();
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    expect(ids(result)).toBe("cab");
    expect(lastToast().title).toBe("Moved Cherry to line 1");
    expect(lastToast().action?.label).toBe("Undo");
  });

  it("Undo puts the previous order back, and a line added since stays at the end", () => {
    const { result } = setup();
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    act(() => result.current.setLines((l) => [...l, { id: "d", name: "Date" }]));
    act(() => lastToast().action!.onClick());
    expect(ids(result)).toBe("abcd");
  });

  it("one toast at a time: a second move closes the first toast, and the old Undo no longer works", () => {
    const { result } = setup();
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    const firstUndo = lastToast().action!.onClick;
    act(() => result.current.order.onMove(move(["a", "c", "b"], "c", 1)));
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    act(() => firstUndo());
    expect(ids(result)).toBe("acb"); // the first toast's Undo is void
  });

  it("Ctrl+Z and Cmd+Z undo the last move when focus is not in a text field", () => {
    const { result } = setup();
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    });
    expect(ids(result)).toBe("abc");
    act(() => result.current.order.onMove(move(["b", "a", "c"], "b", 0)));
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    });
    expect(ids(result)).toBe("abc");
  });

  it("keyboardUndo: false registers NO key listener and Ctrl+Z does nothing (the till keeps its one scan listener)", () => {
    const add = jest.spyOn(document, "addEventListener");
    const addWin = jest.spyOn(window, "addEventListener");
    const { result } = setup({ keyboardUndo: false });
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    });
    expect(ids(result)).toBe("cab");
    expect([...add.mock.calls, ...addWin.mock.calls].filter((c) => c[0] === "keydown")).toEqual([]);
    act(() => mockToast.mock.calls[mockToast.mock.calls.length - 1][0].action!.onClick());
    expect(ids(result)).toBe("abc"); // the toast's Undo button is still the way back
    add.mockRestore();
    addWin.mockRestore();
  });

  it("Ctrl+Z inside a text field is left to the field", () => {
    const { result } = setup();
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    });
    expect(ids(result)).toBe("cab");
    input.remove();
  });

  it("Undo works once: a second Ctrl+Z does nothing", () => {
    const { result } = setup();
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    });
    act(() => result.current.order.onMove(move(["b", "a", "c"], "b", 0)));
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    });
    expect(ids(result)).toBe("abc");
  });

  it("calls afterMove after a move AND after an Undo", () => {
    const afterMove = jest.fn();
    const { result } = setup({ afterMove });
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    expect(afterMove).toHaveBeenCalledTimes(1);
    expect(afterMove).toHaveBeenLastCalledWith("c");
    act(() => lastToast().action!.onClick());
    expect(afterMove).toHaveBeenCalledTimes(2);
    expect(afterMove).toHaveBeenLastCalledWith("c");
  });

  it("is off with fewer than two lines or when not enabled: no handles, no move", () => {
    expect(setup({ initial: [L3[0]] }).result.current.order.enabled).toBe(false);
    const off = setup({ enabled: false });
    expect(off.result.current.order.enabled).toBe(false);
    act(() => off.result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    expect(ids(off.result)).toBe("abc");
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("hands the sortable list (id + product name) to the drag wrapper", () => {
    const { result } = setup();
    expect(result.current.order.sortable).toEqual([
      { id: "a", label: "Apple" },
      { id: "b", label: "Banana" },
      { id: "c", label: "Cherry" },
    ]);
  });

  it("the Undo window ends: after 6 s Ctrl+Z does nothing", () => {
    jest.useFakeTimers();
    const { result } = setup();
    act(() => result.current.order.onMove(move(["c", "a", "b"], "c", 0)));
    act(() => {
      jest.advanceTimersByTime(6100);
    });
    act(() => {
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    });
    expect(ids(result)).toBe("cab");
    jest.useRealTimers();
  });
});
