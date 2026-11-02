/**
 * B238 — the credit-notes page's status counters and money tiles come from ONE server query (`useCreditNoteSummary`), not a
 * `useCreditNotes({ limit: 999 })` fetch-all that silently drops every note past the cap.
 *
 * Pinned through a REAL QueryClient: the summary must refresh after the mutations that change it (the key lives under the
 * `["credit-notes"]` prefix every mutation here already invalidates), so a future re-key fails here and not in production.
 */
import * as React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { useCreateCreditNote, useCreditNoteSummary } from "./credit-notes";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;

const TODAY = "2026-11-02";
const SUMMARY = {
  counts: { total: 1500, issued: 1200, applied: 200, void: 100 },
  openCredit: 7200,
  openCount: 1200,
  issued30Value: 12000,
  issued30Count: 1200,
  topReason: "Damaged",
  topReasonPct: 60,
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const summaryReads = () =>
  mockedGet.mock.calls.filter((c) => c[0] === "/credit-notes/summary").length;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue({ data: SUMMARY });
  mockedPost.mockResolvedValue({ data: { id: "cn-1", customerId: "c1" } });
});

describe("useCreditNoteSummary (B238)", () => {
  it("reads GET /credit-notes/summary with the viewer's own calendar day", async () => {
    const { result } = renderHook(() => useCreditNoteSummary(TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedGet).toHaveBeenCalledWith("/credit-notes/summary", { params: { today: TODAY } });
    expect(result.current.data?.counts.total).toBe(1500);
  });

  it("refetches after a credit note is created", async () => {
    const { result } = renderHook(
      () => ({ summary: useCreditNoteSummary(TODAY), create: useCreateCreditNote() }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.summary.isSuccess).toBe(true));
    expect(summaryReads()).toBe(1);
    await act(async () => {
      await result.current.create.mutateAsync({ customerId: "c1", amount: 5 } as any);
    });
    await waitFor(() => expect(summaryReads()).toBe(2));
  });
});
