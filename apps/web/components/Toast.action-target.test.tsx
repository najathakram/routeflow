import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "@routeflow/ui/web";

/**
 * W-674 (604 recheck, F28): a toast's action ("View Order", "Undo", "Discard") was a bare 12.5px text link, measured 65 x 19
 * px on the order-created toast: too small to hit with a thumb on a phone. Every toast action is now a 44 px tall target
 * (`min-h-11`), the WCAG 2.5.5 / Apple HIG minimum; the label keeps its size and weight. The real 44 px is measured by
 * Playwright at 390/768/1440 (jsdom has no layout, so this pins the class).
 */
function Fire({ secondary = false }: { secondary?: boolean }) {
  const { toast } = useToast();
  React.useEffect(() => {
    toast({
      title: "Order ORD-00042 created",
      variant: "success",
      action: { label: "View Order", onClick: () => undefined },
      ...(secondary ? { secondaryAction: { label: "Discard", onClick: () => undefined } } : {}),
    });
  }, [toast, secondary]);
  return null;
}

describe("W-674: toast actions are 44 px targets", () => {
  it("the View Order action is a button at least 44 px tall", async () => {
    await act(async () => {
      render(
        <ToastProvider>
          <Fire />
        </ToastProvider>,
      );
    });
    const btn = screen.getByRole("button", { name: "View Order" });
    expect(btn.className).toMatch(/(^|\s)min-h-11(\s|$)/);
  });

  it("a second action gets the same target", async () => {
    await act(async () => {
      render(
        <ToastProvider>
          <Fire secondary />
        </ToastProvider>,
      );
    });
    expect(screen.getByRole("button", { name: "Discard" }).className).toMatch(
      /(^|\s)min-h-11(\s|$)/,
    );
  });
});
