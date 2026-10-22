import * as React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { useEditLeaveGuard } from "./edit-leave-guard";

/** Row 604 review S2: the guard's extra history entry is popped once the page goes clean on it. */
const SENTINEL = "__rfEditLeaveSentinel";
const onSentinel = () => Boolean(window.history.state?.[SENTINEL]);

let api: ReturnType<typeof useEditLeaveGuard>;
function Harness({ dirty, onDiscard }: { dirty: boolean; onDiscard: () => void }) {
  api = useEditLeaveGuard(dirty, onDiscard, jest.fn());
  return <>{api.dialog}</>;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/orders/o1");
});

describe("Edit leave guard history sentinel (S2)", () => {
  it("pops the sentinel when the page goes clean (Save) while still on it", async () => {
    const view = render(<Harness dirty={false} onDiscard={jest.fn()} />);
    view.rerender(<Harness dirty onDiscard={jest.fn()} />);
    expect(onSentinel()).toBe(true);
    view.rerender(<Harness dirty={false} onDiscard={jest.fn()} />);
    await waitFor(() => expect(onSentinel()).toBe(false));
  });

  it("Discard via an in-page link pops the sentinel BEFORE the link navigates", async () => {
    const seen: boolean[] = [];
    const proceed = jest.fn(() => void seen.push(onSentinel()));
    const discard = jest.fn();
    const view = render(<Harness dirty onDiscard={discard} />);
    expect(onSentinel()).toBe(true);
    act(() => void api.requestLeave(proceed));
    fireEvent.click(await screen.findByRole("button", { name: /^discard$/i }));
    view.rerender(<Harness dirty={false} onDiscard={discard} />);
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(seen).toEqual([false]);
    expect(onSentinel()).toBe(false);
  });
});
