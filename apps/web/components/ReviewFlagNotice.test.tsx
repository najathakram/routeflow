import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ReviewFlagNotice, reviewFlagLines } from "./ReviewFlagNotice";

/** Row 616: the staff-only banner for a Stripe refund/dispute flag in invoice / advance notes. */
const NOTE =
  "[REVIEW] Stripe reported a dispute (chargeback) on a card payment for this invoice (evt_9).";

describe("reviewFlagLines", () => {
  it("returns only the [REVIEW] lines, prefix stripped", () => {
    expect(reviewFlagLines(`first\n${NOTE}\n  [REVIEW] second\nlast`)).toEqual([
      "Stripe reported a dispute (chargeback) on a card payment for this invoice (evt_9).",
      "second",
    ]);
  });
  it("is empty for null, undefined and notes without a flag", () => {
    expect(reviewFlagLines(null)).toEqual([]);
    expect(reviewFlagLines(undefined)).toEqual([]);
    expect(reviewFlagLines("a [REVIEW] mid-line mention")).toEqual([]);
  });
});

describe("ReviewFlagNotice", () => {
  it.each(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"])("%s sees the notice", (role) => {
    render(<ReviewFlagNotice notes={NOTE} role={role} />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Needs review: Stripe reported a dispute",
    );
  });
  it.each([undefined, null, "CUSTOMER", "DRIVER"])("%s sees nothing", (role) => {
    const { container } = render(<ReviewFlagNotice notes={NOTE} role={role} />);
    expect(container.textContent).toBe("");
  });
  it("renders the compact form for list rows", () => {
    render(<ReviewFlagNotice notes={NOTE} role="OPERATOR" compact />);
    expect(screen.getByRole("alert").textContent).toContain("Needs review:");
  });
});
