import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { DeliveryBottomSheet, type SheetDetent } from "./DeliveryBottomSheet";

/**
 * Controlled-component harness: DeliveryBottomSheet owns no detent state of
 * its own, so the test drives `detent` the same way DeliveryMobileLayout
 * does.
 */
function Harness({ initial = "half" as SheetDetent }) {
  const [detent, setDetent] = React.useState<SheetDetent>(initial);
  return (
    <DeliveryBottomSheet
      detent={detent}
      onDetentChange={setDetent}
      summary="3 stops · 5 orders"
      primary={{ label: "Send", onClick: jest.fn() }}
    >
      <p>sheet body</p>
    </DeliveryBottomSheet>
  );
}

describe("DeliveryBottomSheet — detent cycling via the handle button", () => {
  it("cycles peek → half → full → peek on repeated activation, updating aria-expanded and the label", async () => {
    const user = userEvent.setup();
    render(<Harness initial="peek" />);

    const handle = screen.getByRole("button", { name: /delivery details, collapsed/i });
    expect(handle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "peek");

    await user.click(handle);
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "half");
    expect(
      screen.getByRole("button", { name: /delivery details, half expanded/i }),
    ).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: /delivery details, half expanded/i }));
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "full");
    expect(
      screen.getByRole("button", { name: /delivery details, fully expanded/i }),
    ).toHaveAttribute("aria-expanded", "true");

    // Cycles back to peek — a real <button> per owner spec item 7, not a
    // one-way expand control.
    await user.click(screen.getByRole("button", { name: /delivery details, fully expanded/i }));
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "peek");
    expect(screen.getByRole("button", { name: /delivery details, collapsed/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("cycles via keyboard activation (Enter), which never fires a pointer event", async () => {
    const user = userEvent.setup();
    render(<Harness initial="half" />);

    const handle = screen.getByRole("button", { name: /delivery details, half expanded/i });
    handle.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "full");
  });

  it("Escape collapses a non-peek sheet to peek", async () => {
    const user = userEvent.setup();
    render(<Harness initial="full" />);

    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "full");
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "peek");
  });

  it("renders the primary action and calls it on click", async () => {
    const onPrimary = jest.fn();
    const user = userEvent.setup();
    render(
      <DeliveryBottomSheet
        detent="half"
        onDetentChange={jest.fn()}
        summary="1 stop · 1 order"
        primary={{ label: "Build 1 stop · 1 order", onClick: onPrimary }}
      >
        <p>body</p>
      </DeliveryBottomSheet>,
    );
    await user.click(screen.getByRole("button", { name: "Build 1 stop · 1 order" }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it("opens the overflow menu and, for a `keepOpen` item, stays open to show a follow-up action", async () => {
    const user = userEvent.setup();
    const onDiscard = jest.fn();
    function OverflowHarness() {
      const [confirming, setConfirming] = React.useState(false);
      return (
        <DeliveryBottomSheet
          detent="full"
          onDetentChange={jest.fn()}
          summary="2 stops · 2 orders"
          primary={{ label: "Send", onClick: jest.fn() }}
          overflow={
            confirming
              ? [{ key: "yes", label: "Yes, discard delivery", onClick: onDiscard }]
              : [
                  {
                    key: "discard",
                    label: "Discard delivery",
                    onClick: () => setConfirming(true),
                    destructive: true,
                    keepOpen: true,
                  },
                ]
          }
        >
          <p>body</p>
        </DeliveryBottomSheet>
      );
    }
    render(<OverflowHarness />);

    await user.click(screen.getByRole("button", { name: "More delivery actions" }));
    const discardItem = screen.getByRole("menuitem", { name: "Discard delivery" });
    await user.click(discardItem);

    // keepOpen: true — the menu is still open, now showing the confirm item.
    const confirmItem = await screen.findByRole("menuitem", { name: "Yes, discard delivery" });
    await user.click(confirmItem);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
