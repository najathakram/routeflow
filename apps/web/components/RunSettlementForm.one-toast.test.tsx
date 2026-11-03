import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderHook, waitFor as waitForHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { useSettleRun, useUpdateRouteRunStatus } from "@/lib/api/routes";
import { RunSettlementForm } from "./RunSettlementForm";

/**
 * Review-a on #4188 (B594, Row 348): a settlement refusal raises ONE message. The form words every refusal itself, so the
 * app-wide mutation handler must stay off. This runs the REAL hooks and the REAL `handleMutationError`; the form's own
 * test mocks the hooks and cannot see a second toast.
 */
const mockToast = jest.fn(); // the form's own useToast
const mockGlobalToast = jest.fn(); // the app-wide MutationCache handler
const post = jest.fn();
const patch = jest.fn();

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

const RUN = {
  id: "run-1",
  settlementNote: null,
  collectedPayments: { cashTotal: 60, checkTotal: 0, count: 1 },
} as never;

async function submit(count = "60") {
  const onDone = jest.fn();
  renderWithProviders(<RunSettlementForm run={RUN} mode="driver" onDone={onDone} />, {
    queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
  });
  await userEvent.type(screen.getByLabelText(/cash and checks counted/i), count);
  await userEvent.click(screen.getByRole("button", { name: /settle and finish route/i }));
  return onDone;
}

describe("RunSettlementForm: one message per refusal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    post.mockResolvedValue({ data: {} });
    patch.mockResolvedValue({ data: {} });
  });

  it("RUN_ALREADY_SETTLED (a lost response): the green line only, then the run finishes; no red toast", async () => {
    post.mockRejectedValue(refusal(409, { code: "RUN_ALREADY_SETTLED", message: "settled" }));
    const onDone = await submit();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Settlement already recorded.", variant: "success" }),
    );
    expect(mockGlobalToast).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith("/route-runs/run-1/status", { status: "COMPLETED" });
  });

  it("RUN_VARIANCE_REASON_REQUIRED: the inline ask only; no toast of either kind", async () => {
    post.mockRejectedValue(
      refusal(400, { code: "RUN_VARIANCE_REASON_REQUIRED", message: "varianceReason is required" }),
    );
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/expected amount changed/i);
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockGlobalToast).not.toHaveBeenCalled();
  });

  it("a 500 on settle: the form's one red toast, not two", async () => {
    post.mockRejectedValue(refusal(500, { message: "boom" }));
    await submit();
    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't save the settlement", variant: "error" }),
    );
    expect(mockGlobalToast).not.toHaveBeenCalled();
  });

  it("a refused finish (a stop still pending): the form's one red toast, not two", async () => {
    patch.mockRejectedValue(refusal(400, { message: "Cannot complete a run with stops pending" }));
    await submit();
    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't save the settlement", variant: "error" }),
    );
    expect(mockGlobalToast).not.toHaveBeenCalled();
  });
});

describe("run hooks: localErrorToast keeps the app-wide toast off, the default leaves it on", () => {
  function runHook<T>(hook: () => T) {
    const queryClient = queryClientWithGlobalErrorToast(mockGlobalToast);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(hook, { wrapper });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    post.mockRejectedValue(refusal(400, { message: "x" }));
    patch.mockRejectedValue(refusal(400, { message: "x" }));
  });

  it.each([
    ["useSettleRun", () => useSettleRun, (m: any) => m.mutate({ id: "r", countedCash: 1 })],
    [
      "useUpdateRouteRunStatus",
      () => useUpdateRouteRunStatus,
      (m: any) => m.mutate({ id: "r", status: "COMPLETED" }),
    ],
  ] as const)("%s", async (_name, pick, fire) => {
    const hook = pick() as (o?: { localErrorToast?: boolean }) => any;
    const quiet = runHook(() => hook({ localErrorToast: true }));
    fire(quiet.result.current);
    await waitForHook(() => expect(quiet.result.current.isError).toBe(true));
    expect(mockGlobalToast).not.toHaveBeenCalled();

    const loud = runHook(() => hook());
    fire(loud.result.current);
    await waitForHook(() => expect(loud.result.current.isError).toBe(true));
    expect(mockGlobalToast).toHaveBeenCalled();
  });
});
