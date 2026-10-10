import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GenerateOrderNowButton } from "./generate-order-button";

/**
 * B1054: a double click on "Generate order now" must fire ONE generate request. The page owns the
 * mutation; this harness mirrors its contract (pending flips true synchronously on the first
 * click and stays true until the request settles).
 */
function Harness({ onRequest }: { onRequest: () => void }) {
  const [pending, setPending] = React.useState(false);
  return (
    <GenerateOrderNowButton
      pending={pending}
      onGenerate={() => {
        setPending(true);
        onRequest(); // the request never settles within the test: the worst case for a double click
      }}
    />
  );
}

describe("GenerateOrderNowButton (B1054)", () => {
  it("REG-B1054: a double click while the request is pending fires ONE request", async () => {
    const onRequest = jest.fn();
    render(<Harness onRequest={onRequest} />);

    await userEvent.dblClick(screen.getByRole("button", { name: /generate order now/i }));

    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("is disabled and busy while pending, enabled and idle otherwise", () => {
    const { rerender } = render(<GenerateOrderNowButton pending={false} onGenerate={jest.fn()} />);
    const button = screen.getByRole("button", { name: /generate order now/i });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "false");

    rerender(<GenerateOrderNowButton pending onGenerate={jest.fn()} />);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("a single click calls onGenerate once when idle", async () => {
    const onGenerate = jest.fn();
    render(<GenerateOrderNowButton pending={false} onGenerate={onGenerate} />);

    await userEvent.click(screen.getByRole("button", { name: /generate order now/i }));

    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});
