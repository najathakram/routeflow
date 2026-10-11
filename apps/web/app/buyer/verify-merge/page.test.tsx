import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { LINK_FORMAT_CUTOVER_AT_MS } from "@/lib/account-link-token";
import VerifyMergePage from "./page";

const TOKEN = "c".repeat(64);
const fetchMock = jest.fn();

function respond(ok: boolean, body: unknown) {
  fetchMock.mockResolvedValue({ ok, json: async () => body });
}

describe("buyer merge verification page — token in the fragment", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    fetchMock.mockReset();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    window.history.replaceState(null, "", "/buyer/verify-merge");
  });

  it("reads the fragment token, scrubs the address bar and POSTs the token in the body only", async () => {
    window.history.replaceState(null, "", `/buyer/verify-merge#t=${TOKEN}`);
    respond(true, { message: "SERVER SUCCESS TEXT" });
    render(<VerifyMergePage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/buyer\/auth\/verify-merge$/);
    expect(String(url)).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(await screen.findByText("Account Verified!")).toBeInTheDocument();
    // fixed success copy, not the server's message
    expect(screen.queryByText(/SERVER SUCCESS TEXT/)).not.toBeInTheDocument();
  });

  it("falls back to the legacy ?token= query inside the legacy window and still POSTs a body", async () => {
    jest.spyOn(Date, "now").mockReturnValue(LINK_FORMAT_CUTOVER_AT_MS - 1);
    window.history.replaceState(null, "", `/buyer/verify-merge?token=${TOKEN}`);
    respond(true, {});
    render(<VerifyMergePage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain(TOKEN);
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
    expect(window.location.search).toBe("");
  });

  it("shows the failure state without a token and makes no request", async () => {
    render(<VerifyMergePage />);
    expect(await screen.findByText("Verification Failed")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows fixed copy on failure and never the server's text", async () => {
    window.history.replaceState(null, "", `/buyer/verify-merge#t=${TOKEN}`);
    respond(false, { message: "SERVER-SIDE DETAIL row 42" });
    render(<VerifyMergePage />);

    expect(await screen.findByText("Verification Failed")).toBeInTheDocument();
    expect(screen.queryByText(/SERVER-SIDE DETAIL/)).not.toBeInTheDocument();
    expect(screen.getByText(/could not verify this link/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
