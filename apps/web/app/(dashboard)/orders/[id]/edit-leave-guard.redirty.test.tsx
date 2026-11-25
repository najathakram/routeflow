import * as React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import { useEditLeaveGuard } from "./edit-leave-guard";

/**
 * A form that goes clean and dirty again in quick succession: a name cleared and typed again with one more letter
 * passes through its saved value on the way. Going clean makes the guard step off its history sentinel, and that step
 * lands later as its own event. It was read as the person pressing Back, so "Discard your changes?" opened by itself
 * in the middle of typing.
 */
const SENTINEL = "__rfEditLeaveSentinel";
const onSentinel = () => Boolean(window.history.state?.[SENTINEL]);

function Harness({ dirty }: { dirty: boolean }) {
  const guard = useEditLeaveGuard(dirty, jest.fn(), jest.fn());
  return <>{guard.dialog}</>;
}

/** Let the guard's own `history.back()` land (jsdom delivers it as a later task, as a browser does). */
const landed = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

beforeEach(() => {
  window.history.replaceState({}, "", "/orders/o1");
});

describe("Edit leave guard: clean for a moment, then dirty again", () => {
  it("does not ask to discard when its own history step lands on a form that is dirty again", async () => {
    const view = render(<Harness dirty />);
    expect(onSentinel()).toBe(true);
    view.rerender(<Harness dirty={false} />); // typed back to the saved value
    view.rerender(<Harness dirty />); // and one letter more, before the step has landed
    await landed();
    expect(screen.queryByText("Discard your changes?")).not.toBeInTheDocument();
  });

  it("is still guarded afterwards: the sentinel is back, and a real Back asks", async () => {
    const view = render(<Harness dirty />);
    view.rerender(<Harness dirty={false} />);
    view.rerender(<Harness dirty />);
    await landed();
    expect(onSentinel()).toBe(true);

    act(() => window.history.back());
    expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
    await waitFor(() => expect(onSentinel()).toBe(true)); // Back kept the person on the page
  });

  it("many quick flips leave one question-free form and one sentinel", async () => {
    const view = render(<Harness dirty />);
    for (let i = 0; i < 4; i++) {
      view.rerender(<Harness dirty={false} />);
      view.rerender(<Harness dirty />);
    }
    await landed();
    expect(screen.queryByText("Discard your changes?")).not.toBeInTheDocument();
    expect(onSentinel()).toBe(true);
  });
});
