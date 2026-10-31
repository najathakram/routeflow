import * as React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const post = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast }) };
});

import { useReadyForPickupAction } from "./use-ready-for-pickup";

/** W-1043 (SA-1062 MUST 19) R16/R17: the press posts once; the result is read back to staff exactly. */
describe("useReadyForPickupAction", () => {
  const onReady = jest.fn();
  const onError = jest.fn();
  const run = () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return renderHook(
      () =>
        useReadyForPickupAction({ orderId: "ord-1", customerName: "Acme Co", onReady, onError }),
      { wrapper },
    );
  };
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("posts to the order's ready-for-pickup route and moves the page on", async () => {
    post.mockResolvedValue({ data: { notice: "SENT", email: "buyer@acme.test" } });
    const { result } = run();
    act(() => result.current.press());
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/orders/ord-1/ready-for-pickup");
  });

  it("SENT is a success toast that fades on its own", async () => {
    post.mockResolvedValue({ data: { notice: "SENT", email: "buyer@acme.test" } });
    const { result } = run();
    act(() => result.current.press());
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const arg = toast.mock.calls[0][0];
    expect(arg).toMatchObject({
      title: "Ready for pickup. Email sent to buyer@acme.test.",
      variant: "success",
    });
    expect(arg.duration).toBeUndefined();
  });

  it.each(["NO_EMAIL", "OPTED_OUT", "OFF", "FAILED"])(
    "%s is not a success and stays until dismissed",
    async (notice) => {
      post.mockResolvedValue({ data: { notice } });
      const { result } = run();
      act(() => result.current.press());
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      const arg = toast.mock.calls[0][0];
      expect(arg.variant).toBe("warning");
      expect(arg.duration).toBe(Infinity);
      expect(arg.title).toMatch(/^Ready for pickup\. /);
    },
  );

  it("a repeat press (alreadyReady) moves the page on and says nothing", async () => {
    post.mockResolvedValue({ data: { alreadyReady: true } });
    const { result } = run();
    act(() => result.current.press());
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(toast).not.toHaveBeenCalled();
  });

  it("W-1060: a customer already emailed (toldOnce) moves the page on and says so in a toast that fades", async () => {
    post.mockResolvedValue({
      data: { toldOnce: true, email: "buyer@acme.test", at: "2026-10-31T14:14:00.000Z" },
    });
    const { result } = run();
    act(() => result.current.press());
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    const arg = toast.mock.calls[0][0];
    expect(arg).toMatchObject({
      title: "Ready for pickup. buyer@acme.test was already emailed, so no new email went.",
      variant: "success",
    });
    expect(arg.duration).toBeUndefined();
  });

  it("W-1060: resend posts { resend: true } and reads its answer like a press", async () => {
    post.mockResolvedValue({ data: { notice: "SENT", email: "buyer@acme.test" } });
    const { result } = run();
    act(() => result.current.resend());
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/orders/ord-1/ready-for-pickup", { resend: true });
    expect(toast.mock.calls[0][0].title).toBe("Ready for pickup. Email sent to buyer@acme.test.");
  });

  it("a refusal goes to the page's error handler and shows no notice", async () => {
    const err = new Error("409");
    post.mockRejectedValue(err);
    const { result } = run();
    act(() => result.current.press());
    await waitFor(() => expect(onError).toHaveBeenCalledWith(err));
    expect(onReady).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
