import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "@routeflow/ui/web";

/**
 * SA-1066: the "Ready for pickup" toast names the customer's email. One long unbroken address
 * ran past the right edge of the toast at 390 px and was clipped. The toast text now wraps
 * anywhere (`overflow-wrap` is inherited, so one class on the text column covers the title and
 * the description). jsdom has no layout, so this pins the class; the real wrap is browser-proved.
 */
const LONG =
  "accounts.payable.department.of.a.very.long.business.name@example-wholesale-company.com";

function Fire() {
  const { toast } = useToast();
  React.useEffect(() => {
    toast({ title: "Ready for pickup", description: `Email sent to ${LONG}`, variant: "success" });
  }, [toast]);
  return null;
}

const WRAPS = /(^|\s)(\[overflow-wrap:anywhere\]|break-words)(\s|$)/;

function wrapsFrom(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (WRAPS.test(n.className)) return true;
    if (n.getAttribute("role") === "status" || n.tagName === "LI") break;
  }
  return false;
}

describe("SA-1066: a long unbroken word wraps inside the toast", () => {
  it("the description (the email) and the title both sit under a wrapping class", async () => {
    await act(async () => {
      render(
        <ToastProvider>
          <Fire />
        </ToastProvider>,
      );
    });
    expect(wrapsFrom(await screen.findByText(`Email sent to ${LONG}`))).toBe(true);
    expect(wrapsFrom(screen.getByText("Ready for pickup"))).toBe(true);
  });
});
