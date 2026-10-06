import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { fireEvent, render, screen } from "@testing-library/react";
import { CancelOrderButton, WITH_CARRIER_COPY } from "./CancelOrderButton";

describe("CancelOrderButton (B1083)", () => {
  it("no block reason: today's Cancel Order button, and it cancels", () => {
    const onClick = jest.fn();
    render(<CancelOrderButton blockedReason={null} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel order/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
    render(<CancelOrderButton onClick={onClick} />); // an older API with no field
    expect(screen.getAllByRole("button", { name: /cancel order/i })).toHaveLength(2);
  });

  it("WITH_CARRIER: no button at all, only the fixed explanation", () => {
    const onClick = jest.fn();
    render(<CancelOrderButton blockedReason="WITH_CARRIER" onClick={onClick} />);
    expect(screen.queryByRole("button", { name: /cancel order/i })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(WITH_CARRIER_COPY);
    expect(WITH_CARRIER_COPY).toBe(
      "This order is already with the carrier. Use a return instead of cancelling.",
    );
  });

  it("every Cancel Order action on the order page goes through it with the server's reason", () => {
    const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(
      (src.match(/<CancelOrderButton\s+blockedReason=\{order\.cancelBlockedReason\}/g) ?? [])
        .length,
    ).toBe(4); // PENDING, CONFIRMED, OUT_FOR_DELIVERY, and (B1134) a customer's DRAFT
    expect(src).not.toMatch(/>\s*Cancel Order\s*<\/Button>/);
  });
});
