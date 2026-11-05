import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * SA-1101 §2.5 / §4.3: the one action on a REFUSED order is "Deliver again". It is offered for no other status, opens
 * no reason dialog, and the page moves the order to CONFIRMED through the ordinary status call with NO reason (it is
 * not a demotion). Fixtures are placeholders.
 */
jest.mock("@/lib/api/addons", () => ({
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));

import { DeliverAgainTier } from "./DeliverAgainTier";

describe("DeliverAgainTier", () => {
  it("is offered on a REFUSED order, with the refusal named beside it", () => {
    render(<DeliverAgainTier status="REFUSED" onDeliverAgain={() => undefined} />);
    expect(screen.getByRole("button", { name: "Deliver again" })).toBeInTheDocument();
    expect(screen.getByTestId("refused-note")).toHaveTextContent(/^Refused at delivery\./);
  });

  it.each([
    "DRAFT",
    "PENDING",
    "CONFIRMED",
    "OUT_FOR_DELIVERY",
    "PARTIALLY_DELIVERED",
    "DELIVERED",
    "CANCELLED",
  ])("is not offered on a %s order", (status) => {
    render(<DeliverAgainTier status={status} onDeliverAgain={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Deliver again" })).toBeNull();
    expect(screen.queryByTestId("refused-note")).toBeNull();
  });

  it("a click calls the page's handler once and opens no reason dialog", () => {
    const onDeliverAgain = jest.fn();
    render(<DeliverAgainTier status="REFUSED" onDeliverAgain={onDeliverAgain} />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver again" }));
    expect(onDeliverAgain).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
  });
});

// The order page is not rendered by any test (it needs ~40 hooks), so the call it makes is pinned from source, the
// way restriction-warning-wiring.pins.test.ts and ActionTier.wiring.test.ts pin it.
describe("order page wiring for Deliver again", () => {
  const page = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
  const at = page.indexOf("const handleConfirm = "); // Deliver again reuses the plain CONFIRMED handler
  const body = page.slice(at, page.indexOf("\n  };", at));

  it("moves the order to CONFIRMED with no reason, and routes a refusal through the shared guard", () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toContain('status: "CONFIRMED"');
    expect(body).not.toMatch(/\breason\b/);
    expect(body).toContain('setLocalStatus("CONFIRMED")');
    expect(body).toContain("guardError(");
  });

  it("is rendered for staff only, from the local status", () => {
    expect(page).toMatch(
      /access\.staff && \(\s*<DeliverAgainTier\s+status=\{localStatus\}\s+onDeliverAgain={handleConfirm}/,
    );
  });

  it("never opens the demote-reason dialog for it", () => {
    expect(body).not.toContain("setDemoteTarget");
  });
});
