import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { RunSettleFooter } from "./RunSettleFooter";

/**
 * Review-b on #4188 (ask 6): `open` outlived the footer. A refresh that settles the run (or reopens a stop) takes the
 * button away; when the run later needs settling again the sheet must NOT open by itself.
 */
const CASH = { cashTotal: 60, checkTotal: 0, count: 1 };
const run = (over: Record<string, unknown> = {}) =>
  ({
    id: "run-1",
    status: "IN_PROGRESS",
    stops: [{ id: "a", status: "COMPLETED" }],
    collectedPayments: CASH,
    settlementNote: null,
    ...over,
  }) as never;

describe("RunSettleFooter", () => {
  it("does not reopen the sheet by itself once the footer has gone and come back", async () => {
    const { rerender } = renderWithProviders(<RunSettleFooter run={run()} />);
    await userEvent.click(screen.getByRole("button", { name: /settle your run/i }));
    expect(screen.getByText(/count the cash and checks you collected/i)).toBeInTheDocument();

    // A stop is reopened under the open sheet: the footer goes (nothing to offer while a stop is left).
    rerender(<RunSettleFooter run={run({ stops: [{ id: "a", status: "PENDING" }] })} />);
    expect(screen.queryByRole("button", { name: /settle your run/i })).toBeNull();
    expect(screen.queryByText(/count the cash and checks you collected/i)).toBeNull();

    // The stop is finished again: the button is back, the sheet is closed.
    rerender(<RunSettleFooter run={run()} />);
    expect(screen.getByRole("button", { name: /settle your run/i })).toBeInTheDocument();
    expect(screen.queryByText(/count the cash and checks you collected/i)).toBeNull();
  });
});
