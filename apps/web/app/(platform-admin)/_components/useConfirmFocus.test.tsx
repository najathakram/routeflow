import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConfirmFocus } from "./useConfirmFocus";

// A3 F9: "Execute Merge" is replaced by a confirm strip, so the clicked button unmounts and focus
// fell to <body>. The hook moves focus to the confirm action and back to the trigger.
function Strip() {
  const [confirming, setConfirming] = React.useState(false);
  const { triggerRef, confirmRef } = useConfirmFocus(confirming);
  return (
    <div>
      {!confirming ? (
        <button ref={triggerRef} onClick={() => setConfirming(true)}>
          Execute Merge
        </button>
      ) : (
        <>
          <button ref={confirmRef}>Yes, merge</button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </>
      )}
    </div>
  );
}

describe("useConfirmFocus", () => {
  it("does not steal focus on the first render", () => {
    render(<Strip />);
    expect(document.body).toHaveFocus();
  });

  it("moves focus to the confirm action when the strip opens", async () => {
    const user = userEvent.setup();
    render(<Strip />);
    await user.click(screen.getByRole("button", { name: "Execute Merge" }));
    expect(screen.getByRole("button", { name: "Yes, merge" })).toHaveFocus();
  });

  it("returns focus to the trigger when the strip closes again", async () => {
    const user = userEvent.setup();
    render(<Strip />);
    await user.click(screen.getByRole("button", { name: "Execute Merge" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Execute Merge" })).toHaveFocus();
  });
});
