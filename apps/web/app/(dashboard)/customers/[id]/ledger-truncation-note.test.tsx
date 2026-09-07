import * as React from "react";
import { render, screen } from "@testing-library/react";
import { LedgerTruncationNote } from "./ledger-truncation-note";

/**
 * B110 disclosure (`.claude/pipeline/2026-09-07-F16-list-caps/build-plan.md`):
 * whenever the API reports `transactionsTruncated: true` the operator sees a
 * partial-view label above the statement ledger; when the flag is `false` or
 * absent, nothing is added — a complete ledger must not be labelled partial.
 */
describe("LedgerTruncationNote", () => {
  it("renders the partial-view note when the server reports the ledger truncated", () => {
    render(<LedgerTruncationNote truncated />);
    expect(screen.getByText(/Showing the most recent transactions only/i)).toBeInTheDocument();
  });

  it("renders nothing when the server reports the ledger complete", () => {
    const { container } = render(<LedgerTruncationNote truncated={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the flag is absent (older API response)", () => {
    const { container } = render(<LedgerTruncationNote />);
    expect(container).toBeEmptyDOMElement();
  });
});
