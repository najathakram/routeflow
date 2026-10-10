import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEmailSender } from "./useEmailSender";

/**
 * The hook must do NOTHING for a non-admin (the page passes enabled=false for operators), so the
 * tenant's sender address can never reach an operator's browser; and while the add-on / mailbox
 * queries are pending it must not claim a sender.
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useEmailSender (#1965 review)", () => {
  beforeEach(() => mockGet.mockReset());

  it("enabled=false (operators) makes no request and returns no sender", async () => {
    const { result } = renderHook(() => useEmailSender(false), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.sender).toBeNull();
    expect(mockGet).not.toHaveBeenCalledWith("/settings/email");
    expect(mockGet).not.toHaveBeenCalledWith("/settings/email/mailbox");
  });

  it("while the mailbox is still loading it claims nothing, then names the connected mailbox", async () => {
    let releaseMailbox: (v: unknown) => void = () => undefined;
    mockGet.mockImplementation((url: string) => {
      if (url === "/tenants/me/addons")
        return Promise.resolve({ data: { addons: ["email.connected_mailbox"] } });
      if (url === "/settings/email")
        return Promise.resolve({ data: { smtpConfigured: false, fromEmail: "" } });
      return new Promise((resolve) => {
        releaseMailbox = resolve;
      });
    });
    const { result } = renderHook(() => useEmailSender(true), { wrapper });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/settings/email/mailbox"));
    // SMTP answered "not configured" but the mailbox is unknown: must NOT say RouteFlow's address
    expect(result.current.sender).toBeNull();
    releaseMailbox({
      data: { connected: true, status: "CONNECTED", accountEmail: "ops@acme.test" },
    });
    await waitFor(() => expect(result.current.sender?.kind).toBe("mailbox"));
  });

  it("an add-on endpoint error fails closed too (no sender claimed)", async () => {
    mockGet.mockImplementation((url: string) =>
      url === "/tenants/me/addons"
        ? Promise.reject({ response: { status: 500 } })
        : Promise.resolve({ data: { smtpConfigured: false, fromEmail: "" } }),
    );
    const { result } = renderHook(() => useEmailSender(true), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.sender).toBeNull();
  });
});
