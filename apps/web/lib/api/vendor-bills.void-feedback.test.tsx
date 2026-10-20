/**
 * B846 sibling (void): a refused void shows the server's 409 message (not "Please try again"), and a
 * void whose backdated reversal could not replay the product's cost history shows the same warning
 * receive shows. The bill page has no RTL harness, so the hook is rendered here and the page's wiring
 * is pinned from source (like pack-size-unknown-wiring-b743.test.ts).
 */
import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import {
  costHistoryGapToast,
  useVoidVendorBill,
  voidFailureToast,
  voidSuccessToast,
} from "./vendor-bills";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
const mockedPost = apiClient.post as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => jest.clearAllMocks());

// The server's own sentence: the toast must NOT render it (B986), it shows fixed copy chosen by the code.
const GAP_MESSAGE =
  '"Widget" can\'t be voided — its stock records for bill B-1 (7) do not match what the bill says was received (10). Ask an admin to look into this product first.';
const GAP_COPY =
  "Widget's stock records show more received than this bill, so it can't be voided here. We've flagged it for a repair.";

describe("void feedback", () => {
  it("a refused void shows fixed copy for its code, never the server's message", async () => {
    mockedPost.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: "INVENTORY_LEDGER_GAP",
          message: GAP_MESSAGE,
          name: "Widget",
          ledgerExcess: { posted: "12", received: "10" },
        },
      },
    });
    const { result } = renderHook(() => useVoidVendorBill(), { wrapper: Wrapper });
    let caught: unknown;
    await act(async () => {
      await result.current.mutateAsync("bill-1").catch((e) => (caught = e));
    });
    expect(voidFailureToast(caught)).toEqual({
      title: "Failed to void bill",
      description: GAP_COPY,
      variant: "error",
    });
    expect(voidFailureToast(caught).description).not.toContain(GAP_MESSAGE);
  });

  it("a revert-style gap (no ledgerExcess) never gets the excess copy", () => {
    const err = {
      response: {
        status: 409,
        data: { code: "INVENTORY_LEDGER_GAP", message: GAP_MESSAGE, name: "Widget" },
      },
    };
    expect(voidFailureToast(err).description).not.toBe(GAP_COPY);
    expect(voidFailureToast(err).description).not.toContain(GAP_MESSAGE);
  });

  it("S3: a void refused because the date is in a filed period has fixed copy naming the period", () => {
    const err = {
      response: {
        status: 409,
        data: {
          code: "STOCK_DATE_IN_FILED_PERIOD",
          message: "raw server sentence",
          productId: "p1",
          period: "September 2026",
        },
      },
    };
    expect(voidFailureToast(err)).toEqual({
      title: "Failed to void bill",
      description:
        "September 2026 is already filed for a product on this bill, so it can't be voided today. Ask an admin before voiding it.",
      variant: "error",
    });
    expect(
      voidFailureToast({ response: { data: { code: "STOCK_DATE_IN_FILED_PERIOD" } } }).description,
    ).toContain("This period is already filed");
  });

  it("S2: the void mutation opts out of the app-wide error toast (the page toasts once)", async () => {
    mockedPost.mockRejectedValue(new Error("x"));
    const qc = createTestQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useVoidVendorBill(), { wrapper });
    await act(async () => {
      result.current.mutate("bill-1", { onError: () => undefined });
    });
    expect(qc.getMutationCache().getAll()[0]?.meta).toEqual({ localErrorToast: true });
  });

  it("an uncoded server message is never rendered either", () => {
    const err = { response: { status: 400, data: { message: "raw server sentence" } } };
    expect(voidFailureToast(err).description).not.toContain("raw server sentence");
  });

  it("falls back to today's text when the error carries no message", () => {
    for (const err of [new Error("Network Error"), { response: { data: {} } }, null, undefined]) {
      expect(voidFailureToast(err).description).toBe("Please try again.");
    }
  });

  it("a void that returns gapsDetected warns like receive does; none means no toast", async () => {
    mockedPost.mockResolvedValue({
      data: { status: "VOID", gapsDetected: [{ productId: "p1", name: "Widget", stockDrift: 3 }] },
    });
    const { result } = renderHook(() => useVoidVendorBill(), { wrapper: Wrapper });
    let updated: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      updated = await result.current.mutateAsync("bill-1");
    });
    const toast = costHistoryGapToast(updated?.gapsDetected, "voided");
    expect(toast).toMatchObject({
      title: "Voided — cost history not recomputed",
      variant: "warning",
    });
    expect(toast?.description).toContain("Widget");
    expect(toast?.description).toContain("Ask an admin to look into this product.");
    expect(costHistoryGapToast([], "voided")).toBeNull();
    expect(costHistoryGapToast(undefined, "voided")).toBeNull();
    // receive keeps its exact wording
    expect(
      costHistoryGapToast([{ productId: "p1", name: "Widget", stockDrift: 1 }], "received")
        ?.description,
    ).toContain("received and costed normally");
  });

  it("SA-808b: a shortfall void says what it adjusted, exactly", () => {
    const gap = { productId: "p1", name: "Widget", stockDrift: 3, noReceiptQty: 3 };
    expect(voidSuccessToast("B-1", [gap])).toEqual({
      title: "Voided. 3 Widget had no receipt record and were adjusted today.",
      variant: "info",
    });
    expect(
      voidSuccessToast("B-1", [
        gap,
        { productId: "p2", name: "Gadget", stockDrift: 2, noReceiptQty: 2 },
      ]).title,
    ).toBe("Voided. 3 Widget and 2 Gadget had no receipt record and were adjusted today.");
    // no shortfall: today's toast; and a shortfall is not also reported as a cost-history gap
    expect(voidSuccessToast("B-1", undefined).title).toBe("Bill voided");
    expect(voidSuccessToast("B-1", []).description).toBe("Bill B-1 has been voided.");
    expect(costHistoryGapToast([gap], "voided")).toBeNull();
  });

  it("SA-808b: a lot the void could not identify is named in the description, not as a cost gap", () => {
    const lot = { productId: "p1", name: "Widget", stockDrift: 0, lotsLeft: 4 };
    expect(voidSuccessToast("B-1", [lot])).toEqual({
      title: "Bill voided",
      description:
        "Some stock batches for this bill were left unchanged and are listed in the activity log.",
      variant: "info",
    });
    const gap = { productId: "p2", name: "Gadget", stockDrift: 3, noReceiptQty: 3 };
    expect(voidSuccessToast("B-1", [gap, lot]).title).toBe(
      "Voided. 3 Gadget had no receipt record and were adjusted today.",
    );
    expect(costHistoryGapToast([lot], "voided")).toBeNull();
  });

  it("the bill page wires both into handleVoid", () => {
    const page = readFileSync(
      join(__dirname, "..", "..", "app", "(dashboard)", "vendor-bills", "[id]", "page.tsx"),
      "utf8",
    );
    const handleVoid = page.slice(
      page.indexOf("const handleVoid"),
      page.indexOf("const handleRevertToDraft"),
    );
    expect(handleVoid).toContain("toast(voidFailureToast(err))");
    expect(handleVoid).toContain('costHistoryGapToast(updated?.gapsDetected, "voided")');
    expect(handleVoid).toContain("toast(voidSuccessToast(bill.billNumber, updated?.gapsDetected))");
  });
});
