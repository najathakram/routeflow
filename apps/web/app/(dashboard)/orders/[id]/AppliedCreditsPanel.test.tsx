/**
 * #2404 (P0, epic #2400, SA-436 PR-3): the order's "Applied credits" panel lists EVERY credit
 * actually on the order's invoices — automatic or applied, each with its invoice — plus the
 * picked credits not yet applied, and staff can Remove an applied one (un-apply). Before, it
 * listed the hand-picked intents only, so an auto-applied credit was invisible on the order.
 */
import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";

const mutate = jest.fn();
jest.mock("@/lib/api/credit-notes", () => ({
  useUnapplyCreditNote: () => ({ mutate, isPending: false }),
}));

import { AppliedCreditsPanel } from "./AppliedCreditsPanel";

const order = {
  invoices: [
    {
      id: "inv-1",
      invoiceNumber: "INV-1",
      status: "SENT",
      total: 100,
      payments: [
        {
          id: "p1",
          amount: "12.50",
          creditNoteId: "cn-a",
          autoApplied: true,
          creditNote: { id: "cn-a", creditNoteNumber: "CN-A", reason: "old test credit" },
        },
        {
          id: "p2",
          amount: "5.00",
          creditNoteId: "cn-b",
          creditNote: { id: "cn-b", creditNoteNumber: "CN-B", reason: null },
        },
      ],
    },
  ],
  orderCreditNotes: [
    {
      id: "oc-c",
      creditNoteId: "cn-c",
      amount: null,
      creditNote: { id: "cn-c", creditNoteNumber: "CN-C", reason: "return R-9", amount: 20 },
    },
  ],
};

beforeEach(() => mutate.mockReset());

describe("AppliedCreditsPanel (#2404)", () => {
  it("lists every applied credit with its invoice and Automatic / Applied, plus pending picks", () => {
    render(<AppliedCreditsPanel order={order as any} role="OPERATOR" />);
    const a = screen.getByTestId("applied-credit-payment:p1");
    expect(within(a).getByText("CN-A")).toBeTruthy();
    expect(within(a).getByText("INV-1")).toBeTruthy();
    expect(within(a).getByText("Automatic")).toBeTruthy();
    expect(within(a).getByText("$12.50")).toBeTruthy();
    expect(
      within(screen.getByTestId("applied-credit-payment:p2")).getByText("Applied"),
    ).toBeTruthy();
    expect(screen.queryByText("Manual")).toBeNull();
    const pending = screen.getByTestId("applied-credit-intent:oc-c");
    expect(within(pending).getByText("Not yet applied")).toBeTruthy();
    expect(within(pending).getByText("Up to remaining")).toBeTruthy();
    expect(within(pending).queryByRole("button", { name: "Remove credit" })).toBeNull();
  });

  it("Remove confirms, then un-applies that credit from that invoice", () => {
    render(<AppliedCreditsPanel order={order as any} role="TENANT_ADMIN" />);
    fireEvent.click(
      within(screen.getByTestId("applied-credit-payment:p1")).getByRole("button", {
        name: "Remove credit",
      }),
    );
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove credit" }));
    expect(mutate).toHaveBeenCalledWith({ id: "cn-a", invoiceId: "inv-1" }, expect.anything());
  });

  it("non-staff never see Remove", () => {
    render(<AppliedCreditsPanel order={order as any} role="CUSTOMER" />);
    expect(screen.queryByRole("button", { name: "Remove credit" })).toBeNull();
  });

  it("renders nothing when the order has no credits", () => {
    const { container } = render(
      <AppliedCreditsPanel order={{ invoices: [], orderCreditNotes: [] } as any} role="OPERATOR" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("the order page renders the panel instead of the intents-only list", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(/<AppliedCreditsPanel[\s\S]*?order=\{order\}[\s\S]*?role=\{/);
    expect(src).not.toMatch(/order\.orderCreditNotes!\.map/);
  });

  it("the Remove confirm quotes the (note, invoice) pair total the server un-applies (SA-436 review)", () => {
    const twoOnOne = {
      invoices: [
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          status: "SENT",
          total: 100,
          payments: [
            {
              id: "x1",
              amount: "5.00",
              creditNoteId: "cn-b",
              autoApplied: false,
              creditNote: { id: "cn-b", creditNoteNumber: "CN-B" },
            },
            {
              id: "x2",
              amount: "2.50",
              creditNoteId: "cn-b",
              autoApplied: false,
              creditNote: { id: "cn-b", creditNoteNumber: "CN-B" },
            },
          ],
        },
      ],
      orderCreditNotes: [],
    };
    render(<AppliedCreditsPanel order={twoOnOne as any} role="OPERATOR" />);
    fireEvent.click(
      within(screen.getByTestId("applied-credit-payment:x1")).getByRole("button", {
        name: "Remove credit",
      }),
    );
    expect(screen.getByText(/un-apply \$7\.50 of CN-B from INV-1/)).toBeTruthy();
  });
  it("a partly-requested pending credit says what happens to the rest (#2600)", () => {
    const partial = {
      ...order,
      orderCreditNotes: [
        {
          id: "oc-d",
          creditNoteId: "cn-d",
          amount: "20.00",
          creditNote: { id: "cn-d", creditNoteNumber: "CN-D", reason: null, amount: "50.00" },
        },
      ],
    };
    render(<AppliedCreditsPanel order={partial as any} role="OPERATOR" />);
    expect(
      within(screen.getByTestId("applied-credit-intent:oc-d")).getByText(
        "Requested $20.00 of $50.00 (the rest stays as store credit)",
      ),
    ).toBeTruthy();
  });
});
