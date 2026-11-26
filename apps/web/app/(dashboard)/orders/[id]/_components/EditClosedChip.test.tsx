import * as fs from "fs";
import * as path from "path";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import {
  BUYER_EDIT_CLOSED_REASONS,
  DELIVERED_LINES_CLOSED_COPY,
  type BuyerEditClosedReason,
} from "@routeflow/types";
import { EditClosedChip } from "./EditClosedChip";

jest.mock("@/components/OrderStatusBadge", () => ({
  useOrderStatusLabel: () => (_status: string, normal: string) => normal,
}));

const SENTENCE =
  "Part of this order was already delivered, so it can't be changed here. Send a change request instead.";

function chip(closedReason: BuyerEditClosedReason | null, show = true) {
  return <EditClosedChip show={show} order={{ editWindow: { closedReason } }} />;
}

describe("EditClosedChip (SA-1546 10.3)", () => {
  it("DELIVERED_LINES shows the delivered-goods sentence, never the cancelled words", () => {
    render(chip("DELIVERED_LINES"));
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(/Order cancelled/)).not.toBeInTheDocument();
    expect(DELIVERED_LINES_CLOSED_COPY).toBe(SENTENCE);
  });

  it("STATUS keeps the cancelled words (REFUSED stays a LOW row)", () => {
    render(chip("STATUS"));
    expect(screen.getByText("Order cancelled — editing closed")).toBeInTheDocument();
  });

  it("DISPATCHED keeps the out-for-delivery words", () => {
    render(chip("DISPATCHED"));
    expect(screen.getByText("Out for delivery — editing closed")).toBeInTheDocument();
    expect(screen.queryByText(/Order cancelled/)).not.toBeInTheDocument();
  });

  it("says nothing when hidden or when no reason is sent", () => {
    const hidden = render(chip("DELIVERED_LINES", false));
    expect(hidden.container).toBeEmptyDOMElement();
    const none = render(chip(null));
    expect(none.container).toBeEmptyDOMElement();
  });

  it("every reason on the wire has a chip text (no reason falls to the cancelled default by accident)", () => {
    for (const reason of BUYER_EDIT_CLOSED_REASONS) {
      const { container, unmount } = render(chip(reason));
      const text = container.textContent ?? "";
      if (reason === "STATUS") expect(text).toMatch(/Order cancelled/);
      else expect(text).not.toMatch(/Order cancelled/);
      unmount();
    }
  });

  it("no client hand-types the closedReason union (it is BuyerEditClosedReason from @routeflow/types)", () => {
    const root = path.resolve(__dirname, "../../../../../../..");
    const files = [
      "apps/web/lib/api/orders.ts",
      "apps/mobile/lib/api/orders.ts",
      "apps/mobile/lib/api/admin.ts",
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      expect(src).toContain("closedReason: BuyerEditClosedReason | null");
      expect(src).not.toContain("closedReason: string");
      expect(src).not.toContain('closedReason: "DISPATCHED"');
    }
  });
});
