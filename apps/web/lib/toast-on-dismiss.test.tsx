import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast } from "@routeflow/ui/web";

/** The Undo toasts commit their delete when the toast closes, so the toast must report its close exactly once. */
function Harness({ onDismiss }: { onDismiss: () => void }) {
  const { toast, dismiss } = useToast();
  const id = React.useRef<string>("");
  return (
    <>
      <button
        onClick={() => (id.current = toast({ title: "Discarded", duration: 60_000, onDismiss }))}
      >
        show
      </button>
      <button onClick={() => dismiss(id.current)}>close</button>
    </>
  );
}

describe("toast onDismiss", () => {
  it("fires once when the toast is dismissed, and not while it is open", () => {
    const onDismiss = jest.fn();
    render(
      <ToastProvider>
        <Harness onDismiss={onDismiss} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("show"));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => fireEvent.click(screen.getByText("close")));
    act(() => fireEvent.click(screen.getByText("close")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("fires when the toast's own close button is used", () => {
    const onDismiss = jest.fn();
    render(
      <ToastProvider>
        <Harness onDismiss={onDismiss} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("show"));
    act(() => fireEvent.click(screen.getByLabelText("Dismiss")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
