import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CreditLimitPanel } from "./credit-limit-panel";

/**
 * D6 / B462 + B576. The panel shows the figure the server's hard credit block is checked against
 * (`creditExposure`), never `customer.receivables` (which GET /customers/:id does not return —
 * the old bar always read $0.00), and surfaces unissued DRAFT invoices as `pendingExposure`
 * WITHOUT adding them into the bar (only drafts with no open/delivered order behind them; a
 * draft on a real order is already counted in `creditExposure`).
 */
const bar = () => screen.getByRole("progressbar", { name: /credit limit used/i });
const fill = () => bar().firstElementChild as HTMLElement;

describe("CreditLimitPanel — visibility", () => {
  it.each([[null], [undefined], [-5]])("renders nothing when there is no limit (%p)", (limit) => {
    const { container } = render(<CreditLimitPanel creditLimit={limit} creditExposure={100} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// REG-B1032: `Customer.creditLimit` of 0 is a REAL limit ("no credit extended" — the server's credit block
// refuses anything above $0); only null means no limit. The panel treated 0 as "no limit" and hid itself.
describe("CreditLimitPanel — a real $0 limit (REG-B1032)", () => {
  it("shows the panel with an explicit $0.00 limit instead of hiding it", () => {
    render(<CreditLimitPanel creditLimit={0} creditExposure={0} />);
    expect(screen.getByTestId("credit-limit-panel")).toBeInTheDocument();
    expect(screen.getByTestId("credit-limit-figures")).toHaveTextContent("$0.00 / $0.00");
    expect(screen.getByTestId("credit-limit-zero")).toHaveTextContent("$0.00 limit");
  });

  it("with exposure against a $0 limit it reads over the limit, with a full bar (no divide-by-zero)", () => {
    render(<CreditLimitPanel creditLimit={0} creditExposure={250} />);
    expect(screen.getByTestId("credit-limit-caption")).toHaveTextContent(
      "Over the limit by $250.00",
    );
    expect(fill().style.width).toBe("100%");
  });

  it("while the statement loads it still shows the limit and an em dash, not a zero", () => {
    render(<CreditLimitPanel creditLimit={0} />);
    expect(screen.getByTestId("credit-limit-figures")).toHaveTextContent("— / $0.00");
    expect(screen.getByTestId("credit-limit-zero")).toBeInTheDocument();
  });

  it("a positive limit does not carry the $0 marker", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={0} />);
    expect(screen.queryByTestId("credit-limit-zero")).not.toBeInTheDocument();
  });
});

describe("CreditLimitPanel — exposure figures", () => {
  it("B576: while the statement is loading it shows an em dash, NEVER a misleading $0.00", () => {
    render(<CreditLimitPanel creditLimit={1000} />);
    expect(screen.getByTestId("credit-limit-figures")).toHaveTextContent("— / $1,000.00");
    expect(screen.queryByText(/\$0\.00 \//)).not.toBeInTheDocument();
    expect(screen.getByTestId("credit-limit-caption")).toHaveTextContent("—");
    expect(bar()).toHaveAttribute("aria-busy", "true");
    expect(bar()).not.toHaveAttribute("aria-valuenow");
    expect(fill().style.width).toBe("0%");
  });

  it("says the figure is exposure incl. unbilled open orders — so it never reads as contradicting 'Outstanding'", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={700} />);
    expect(screen.getByTestId("credit-limit-basis")).toHaveTextContent(
      /credit block checks.*unbilled open orders/i,
    );
  });

  it("gives screen readers the money, not just a percentage (aria-valuetext)", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={200} />);
    expect(bar()).toHaveAttribute("aria-valuetext", "$200.00 of $1,000.00 used");
  });

  it("a FAILED statement request says so — not an endless loading state (no aria-busy)", () => {
    render(<CreditLimitPanel creditLimit={1000} statementUnavailable />);
    expect(screen.getByTestId("credit-limit-figures")).toHaveTextContent("— / $1,000.00");
    expect(screen.getByTestId("credit-limit-caption")).toHaveTextContent("Exposure unavailable");
    expect(bar()).toHaveAttribute("aria-busy", "false");
    expect(bar()).not.toHaveAttribute("aria-valuetext");
    expect(screen.queryByText(/\$0\.00 \//)).not.toBeInTheDocument();
  });

  it("a known exposure wins over a stale error flag", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={200} statementUnavailable />);
    expect(screen.getByTestId("credit-limit-caption")).toHaveTextContent("20% used");
  });

  it("shows used / limit, the percentage and what is available", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={200} />);
    expect(screen.getByTestId("credit-limit-figures")).toHaveTextContent("$200.00 / $1,000.00");
    expect(screen.getByTestId("credit-limit-caption")).toHaveTextContent(
      "20% used · $800.00 available",
    );
    expect(bar()).toHaveAttribute("aria-valuenow", "20");
    expect(bar()).toHaveAttribute("aria-busy", "false");
    expect(fill().style.width).toBe("20%");
  });

  it("a genuine $0.00 exposure is shown as $0.00 (known and zero is not the loading state)", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={0} />);
    expect(screen.getByTestId("credit-limit-figures")).toHaveTextContent("$0.00 / $1,000.00");
    expect(screen.getByTestId("credit-limit-caption")).toHaveTextContent(
      "0% used · $1,000.00 available",
    );
  });

  it.each([
    [200, "bg-brand-500"],
    [700, "bg-brand-500"], // exactly 70% is NOT past the warn threshold (strict >)
    [710, "bg-warning"],
    [750, "bg-warning"],
    [900, "bg-warning"], // exactly 90% is NOT past the danger threshold (strict >)
    [910, "bg-danger"],
    [950, "bg-danger"],
  ])("colours the bar by usage: %p → %s", (exposure, cls) => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={exposure} />);
    expect(fill().className).toContain(cls);
  });

  it("exactly at the limit: 100% used, nothing available, NOT over", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={1000} />);
    const caption = screen.getByTestId("credit-limit-caption");
    expect(caption).toHaveTextContent("100% used");
    expect(caption).not.toHaveTextContent(/available/);
    expect(caption).not.toHaveTextContent(/over the limit/i);
  });

  it("over the limit: says by how much, in the danger style, with the bar capped at 100%", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={1250} />);
    const caption = screen.getByTestId("credit-limit-caption");
    expect(caption).toHaveTextContent("Over the limit by $250.00");
    expect(caption.className).toContain("text-danger");
    expect(fill().style.width).toBe("100%");
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
  });

  it("float dust below a cent never flips the panel to 'over' (roundMoney before the comparison)", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={1000.004} />);
    expect(screen.getByTestId("credit-limit-caption")).not.toHaveTextContent(/over the limit/i);
  });

  it("a negative exposure is clamped to zero", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={-40} />);
    expect(screen.getByTestId("credit-limit-figures")).toHaveTextContent("$0.00 / $1,000.00");
  });
});

describe("CreditLimitPanel — pending exposure (unissued DRAFT invoices)", () => {
  it("shows the pending line with the amount and what it means", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={200} pendingExposure={340.5} />);
    const line = screen.getByTestId("credit-pending-exposure");
    expect(line).toHaveTextContent("Pending exposure $340.50");
    expect(line).toHaveTextContent(/draft invoices with no order behind them/i);
    expect(line).toHaveTextContent(/counted toward the limit once issued/i);
  });

  it("is NOT added into the bar: used stays the server's creditExposure", () => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={200} pendingExposure={900} />);
    expect(screen.getByTestId("credit-limit-figures")).toHaveTextContent("$200.00 / $1,000.00");
    expect(fill().style.width).toBe("20%");
    expect(screen.getByTestId("credit-limit-caption")).not.toHaveTextContent(/over the limit/i);
  });

  it.each([[undefined], [0], [-3]])("is hidden when there is nothing pending (%p)", (pending) => {
    render(<CreditLimitPanel creditLimit={1000} creditExposure={200} pendingExposure={pending} />);
    expect(screen.queryByTestId("credit-pending-exposure")).not.toBeInTheDocument();
  });

  it("is still shown while the exposure figure itself is unavailable", () => {
    render(<CreditLimitPanel creditLimit={1000} pendingExposure={50} />);
    expect(screen.getByTestId("credit-pending-exposure")).toHaveTextContent("$50.00");
  });
});
