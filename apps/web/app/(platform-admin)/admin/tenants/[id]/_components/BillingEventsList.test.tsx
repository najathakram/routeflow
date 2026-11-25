import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { BillingEventsList } from "./BillingEventsList";

// R-2 test 21 (SA-1297 W8): the list renders `label ?? type`, the ruled staff-refund row, and the empty line.
const mockList = jest.fn();
jest.mock("@/lib/api/platform-billing-events", () => ({
  ...jest.requireActual("@/lib/api/platform-billing-events"),
  listBillingEvents: (id: string) => mockList(id),
}));

const rows = [
  {
    id: "e2",
    type: "refund.staff",
    label: "Staff refund",
    createdAt: "2026-11-19T10:00:00.000Z",
    actorName: "acme-staff",
    payload: {
      invoiceId: "in_acme_1",
      amount: "1188.50",
      currency: "usd",
      refundDate: "2026-11-18",
      providerRef: "re_acme_9",
    },
  },
  {
    id: "e1",
    type: "plan.changed",
    label: null,
    createdAt: "2026-11-15T09:00:00.000Z",
    actorName: null,
    payload: { toPlan: "GROWTH" },
  },
];

beforeEach(() => jest.clearAllMocks());

describe("test 21: the Billing events list", () => {
  it("prints the staff refund row in the ruled format and other types as label ?? type", async () => {
    mockList.mockResolvedValue(rows);
    render(<BillingEventsList tenantId="tenant-1" />);
    expect(await screen.findByText("Billing events")).toBeInTheDocument();
    const items = await screen.findAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "2026-11-18 · Staff refund · Yearly payment $1,188.50 refunded in full · Ref re_acme_9 · by acme-staff · recorded 2026-11-19",
      "plan.changed",
    ]);
    expect(within(items[1]).queryByText(/Staff refund/)).toBeNull();
    expect(screen.queryByText("No billing events yet.")).toBeNull();
  });

  it("a labelled non-refund type prints its label", async () => {
    mockList.mockResolvedValue([{ ...rows[1], label: "Plan changed" }]);
    render(<BillingEventsList tenantId="tenant-1" />);
    expect(await screen.findByText("Plan changed")).toBeInTheDocument();
  });

  it("an empty answer prints the empty line", async () => {
    mockList.mockResolvedValue([]);
    render(<BillingEventsList tenantId="tenant-1" />);
    expect(await screen.findByText("No billing events yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("a failed read does not crash the tab and shows the empty line", async () => {
    mockList.mockRejectedValue(new Error("network"));
    render(<BillingEventsList tenantId="tenant-1" />);
    expect(await screen.findByText("No billing events yet.")).toBeInTheDocument();
  });
});
