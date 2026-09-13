import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import type { Estimate, EstimateStatus } from "@/lib/api/estimates";
import EstimateDetailPage from "./page";

// REG-B17 (rc-b17): HEAD's POST /estimates/:id/send only flips DRAFT -> SENT —
// no EmailService is ever called (apps/api/src/estimates has zero
// EmailService/sendMail/mailer hits) — yet the button read "Send" and the
// success toast claimed delivery ("... has been sent to the customer" /
// "... has been sent" / "emailed to ..."). Quoting rc-b17's report verbatim so
// this assertion's failure message names the exact wrong strings it must never
// see again: title "Estimate marked as sent" was paired with a description
// claiming delivery, and the button read "Send" instead of "Mark as sent".
//
// This file documents PRE-EXISTING, ALREADY-CORRECT behavior — the REG-B17
// fix and the REG-B15 pre-gate checks (control visibility / navigation /
// count) both already pass on HEAD. They are kept here, separate from
// page.test.tsx, so that file's RED-gate scope for rt-b17-web (the convert
// failure toast hardcoding "Please try again.") stays structurally isolated
// from behavior this task does not change.
const B17_DELIVERY_CLAIM_STRINGS = [
  "has been sent to the customer",
  "has been sent",
  "emailed to the customer",
] as const;

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  return {
    id: "est-1",
    estimateNumber: "EST-0001",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods", contactName: "Jane" },
    status: "DRAFT" as EstimateStatus,
    issueDate: "2026-01-01",
    expiresAt: "2026-02-01",
    subtotal: 100,
    taxAmount: 8,
    total: 108,
    notes: undefined,
    items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 100, subtotal: 100 } as any],
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
    ...overrides,
  };
}

const mockUseEstimate = jest.fn((..._args: unknown[]) => ({
  data: makeEstimate(),
  isLoading: false,
  isError: false,
}));

const sendEstimateMutate = jest.fn();
const convertEstimateMutate = jest.fn();
const routerPushMock = jest.fn();
const toastMock = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "est-1" }),
  useRouter: () => ({ push: routerPushMock }),
}));

jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimate: (...args: unknown[]) => mockUseEstimate(...args),
  useSendEstimate: () => ({ mutate: sendEstimateMutate, isPending: false }),
  useAcceptEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useDeclineEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useConvertEstimateToInvoice: () => ({ mutate: convertEstimateMutate, isPending: false }),
  useVoidEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: toastMock, dismiss: jest.fn() }),
}));

/** Renders the page with a DRAFT (or overridden-status) estimate. */
function renderEstimatePage({ status }: { status?: EstimateStatus } = {}) {
  mockUseEstimate.mockReturnValue({
    data: makeEstimate(status ? { status } : {}),
    isLoading: false,
    isError: false,
  });
  return renderWithProviders(<EstimateDetailPage />);
}

describe("EstimateDetailPage — REG-B17 send toast/label no longer claim delivery (existing, already-correct behavior)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("REG-B17 send toast does not claim delivery", async () => {
    const user = userEvent.setup();
    sendEstimateMutate.mockImplementation((_id: string, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderEstimatePage({ status: "DRAFT" as EstimateStatus });

    // Query in a way that resolves both before ("Send") and after ("Mark as
    // sent") the rename.
    const sendButton = screen.getByRole("button", { name: /^(send|mark as sent)$/i });
    await user.click(sendButton);

    await waitFor(() => expect(toastMock).toHaveBeenCalled());

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Estimate marked as sent",
        description: "EST-0001 is marked Sent. No email was sent.",
      }),
    );

    const deliveryClaimPattern = /sent to the customer|has been sent|email(ed)? to/i;
    for (const call of toastMock.mock.calls) {
      for (const arg of call) {
        const haystack = JSON.stringify(arg);
        expect({ toastArg: haystack, quotedBugStrings: B17_DELIVERY_CLAIM_STRINGS }).toEqual(
          expect.objectContaining({
            toastArg: expect.not.stringMatching(deliveryClaimPattern),
          }),
        );
      }
    }

    expect(screen.getByRole("button", { name: "Mark as sent" })).toBeInTheDocument();
  });
});

// REG-B15/REG-B394/PIN-B15 coverage lives in page.test.tsx, not here — an
// earlier partial round duplicated it into this "existing-behavior" file too,
// which is meant to hold only PIN-class behavior kept separate from
// page.test.tsx's RED-gate scope. Removed rather than left redundant so
// campaign-check's REG-B394 token citation stays unambiguous (one test, not
// two, claim the same registry proof).
