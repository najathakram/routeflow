import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import ReturnDetailPage from "./page";
import type { Return } from "@/lib/api/returns";

// #2406 (SA-484c): an INLINE return renders on this page, but never with the STANDARD
// approve/reject actions (it has its own capture/approve flow, PR-1c/1d).
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "ret-1" }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

let mockReturn: Return | undefined;
jest.mock("@/lib/api/returns", () => ({
  useReturn: () => ({ data: mockReturn, isLoading: false, isError: false }),
  useApproveReturn: () => ({ mutate: jest.fn(), isPending: false }),
  useRejectReturn: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkReturnInTransit: () => ({ mutate: jest.fn(), isPending: false }),
  useMarkReturnReceived: () => ({ mutate: jest.fn(), isPending: false }),
  useProcessRefund: () => ({ mutate: jest.fn(), isPending: false }),
  useCancelReturn: () => ({ mutate: jest.fn(), isPending: false }),
}));

const baseReturn = {
  id: "ret-1",
  returnNumber: "R-100",
  customerId: "c1",
  orderId: "o1",
  reason: "DAMAGED",
  notes: "",
  items: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
} as unknown as Return;

describe("ReturnDetailPage (#2406)", () => {
  it("a STANDARD PENDING return still shows Approve/Reject", () => {
    mockReturn = { ...baseReturn, kind: "STANDARD", status: "PENDING" } as Return;
    renderWithProviders(<ReturnDetailPage />);
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("an INLINE return shows no Approve/Reject actions, even if PENDING", () => {
    mockReturn = { ...baseReturn, kind: "INLINE", status: "PENDING" } as Return;
    renderWithProviders(<ReturnDetailPage />);
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();
  });

  it("an INLINE row still renders its return number", () => {
    mockReturn = {
      ...baseReturn,
      kind: "INLINE",
      status: "REFUNDED",
      refundAmount: 14.97,
      refundEstimate: null,
      refundEstimateReason: "INLINE",
    } as Return;
    renderWithProviders(<ReturnDetailPage />);
    expect(screen.getByRole("heading", { name: "R-100" })).toBeInTheDocument();
  });

  // Lead fold on #2601: an INLINE row sits at RECEIVED (or APPROVED/IN_TRANSIT) too, and the
  // server refuses every standard-path action on it — so none may render.
  it.each(["APPROVED", "IN_TRANSIT", "RECEIVED"])(
    "an INLINE %s return shows no Resolve / Cancel / receive / in-transit actions",
    (status) => {
      mockReturn = { ...baseReturn, kind: "INLINE", status } as Return;
      renderWithProviders(<ReturnDetailPage />);
      for (const name of [/resolve/i, /cancel return/i, /^cancel$/i, /received/i, /in transit/i]) {
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      }
    },
  );

  it("a STANDARD RECEIVED return still shows Resolve and Cancel (control)", () => {
    mockReturn = { ...baseReturn, kind: "STANDARD", status: "RECEIVED" } as Return;
    renderWithProviders(<ReturnDetailPage />);
    expect(screen.getAllByRole("button", { name: /resolve/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /cancel/i }).length).toBeGreaterThan(0);
  });

  describe("SA-773: a return the claim would refuse for the remainder cannot be resolved from the screen", () => {
    const received = (refundEstimate: number) =>
      ({
        ...baseReturn,
        kind: "STANDARD",
        status: "RECEIVED",
        refundEstimate,
        refundEstimateReason: "EXCEEDS_REFUNDABLE",
      }) as unknown as Return;

    it.each([
      [10, /Up to \$10\.00 can still be given back for these goods\./],
      [0, /Nothing more can be given back for these goods\./],
    ])(
      "an estimate of %s says what is left, and the Resolve Return button is disabled",
      async (estimate, left) => {
        mockReturn = received(estimate);
        const user = userEvent.setup();
        renderWithProviders(<ReturnDetailPage />);
        await user.click(screen.getAllByRole("button", { name: /resolve/i })[0]);
        const reason = await screen.findByTestId("resolve-estimate-reason");
        expect(reason).toHaveTextContent(/already returned or credited/);
        expect(reason).toHaveTextContent(left);
        expect(reason).toHaveTextContent(/Cancel the return/);
        // nothing in the dialog offers to mint or record the priced amount
        expect(screen.queryByText(/Choose how the/)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Resolve Return" })).toBeDisabled();
      },
    );

    it("a return that fits keeps the normal dialog and an enabled Resolve Return", async () => {
      mockReturn = {
        ...baseReturn,
        kind: "STANDARD",
        status: "RECEIVED",
        refundEstimate: 55,
        refundEstimateReason: null,
      } as unknown as Return;
      const user = userEvent.setup();
      renderWithProviders(<ReturnDetailPage />);
      await user.click(screen.getAllByRole("button", { name: /resolve/i })[0]);
      expect(await screen.findByText(/Choose how the \$55\.00/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Resolve Return" })).toBeEnabled();
    });
  });

  it("Train 4: a refunded return offers Print slip (from this same record)", async () => {
    mockReturn = {
      ...baseReturn,
      kind: "INLINE",
      status: "REFUNDED",
      refundAmount: 14.97,
      refundMethod: "EXTERNAL_REFUND",
      refundTender: "CASH",
      refundedAt: "2026-10-09T14:00:00.000Z",
      order: { id: "o1", orderNumber: "ORD-1", counterSale: true },
    } as unknown as Return;
    renderWithProviders(<ReturnDetailPage />);
    expect(await screen.findByRole("button", { name: "Print slip" })).toBeEnabled();
  });

  it.each(["PENDING", "APPROVED", "RECEIVED", "REJECTED"])(
    "Train 4: a %s return has no Print slip",
    (status) => {
      mockReturn = { ...baseReturn, kind: "STANDARD", status } as Return;
      renderWithProviders(<ReturnDetailPage />);
      expect(screen.queryByRole("button", { name: "Print slip" })).toBeNull();
    },
  );
});
