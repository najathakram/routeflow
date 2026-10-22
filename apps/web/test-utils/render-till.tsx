import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders, type RenderWithProvidersResult } from "./render";

/**
 * S5: a fresh till asks "Who's buying?" and Complete waits for the answer. A test that is about something other than the
 * buyer (the tender, the receipt, a scan) renders the till and taps Walk-in, the way a clerk does. When the till shows no
 * question (still loading, a restored held sale that already has its buyer) nothing is tapped. Tests about the question
 * itself render with `renderWithProviders` and answer it (or not) on their own.
 */
export function renderTill(ui: React.ReactElement): RenderWithProvidersResult {
  const out = renderWithProviders(ui);
  const walkIn = screen.queryByRole("button", { name: "Walk-in" });
  if (walkIn) fireEvent.click(walkIn);
  return out;
}

/** The next sale after "Complete & next sale" / "New sale" asks again: answer it the same way. */
export function tapWalkIn(): void {
  fireEvent.click(screen.getByRole("button", { name: "Walk-in" }));
}
