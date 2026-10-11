import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { LEGACY_LINK_TTL_MS, LINK_FORMAT_CUTOVER_AT_MS } from "@/lib/account-link-token";
import VerifyEmailPage from "./page";

jest.mock("@/lib/auth", () => ({ adoptTokenPair: jest.fn() }));
import { adoptTokenPair } from "@/lib/auth";

const TOKEN = "V".repeat(43);
const fetchMock = jest.fn();

function respond(ok: boolean, body: unknown) {
  fetchMock.mockResolvedValue({ ok, json: () => Promise.resolve(body) });
}

describe("staff email verification page — token in the fragment", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    fetchMock.mockReset();
    (adoptTokenPair as jest.Mock).mockReset();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    window.history.replaceState(null, "", "/verify-email");
  });

  it("reads the fragment token, scrubs the address bar and POSTs the token in the body only", async () => {
    window.history.replaceState(null, "", `/verify-email#t=${TOKEN}`);
    respond(true, { accessToken: "a", refreshToken: "r" });

    const { unmount } = render(<VerifyEmailPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/auth\/verify-email$/);
    expect(String(url)).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    await waitFor(() => expect(adoptTokenPair).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Email verified!")).toBeInTheDocument();
    unmount();
  });

  it("sends the single-use token exactly once even when strict mode runs the effect twice", async () => {
    window.history.replaceState(null, "", `/verify-email#t=${TOKEN}`);
    respond(true, { accessToken: "a", refreshToken: "r" });

    const { unmount } = render(
      <React.StrictMode>
        <VerifyEmailPage />
      </React.StrictMode>,
    );

    await waitFor(() => expect(adoptTokenPair).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Email verified!")).toBeInTheDocument();
    unmount();
  });

  it("falls back to the legacy ?token= query inside the legacy window and scrubs it", async () => {
    jest.spyOn(Date, "now").mockReturnValue(LINK_FORMAT_CUTOVER_AT_MS - 1);
    window.history.replaceState(null, "", `/verify-email?token=${TOKEN}`);
    respond(true, { accessToken: "a", refreshToken: "r" });

    const { unmount } = render(<VerifyEmailPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: TOKEN });
    expect(window.location.search).toBe("");
    unmount();
  });

  it("ignores the legacy ?token= query once the verification-link lifetime has passed", async () => {
    jest
      .spyOn(Date, "now")
      .mockReturnValue(LINK_FORMAT_CUTOVER_AT_MS + LEGACY_LINK_TTL_MS.staffVerifyEmail);
    window.history.replaceState(null, "", `/verify-email?token=${TOKEN}`);

    render(<VerifyEmailPage />);

    expect(await screen.findByText(/No verification token found/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("shows fixed copy and makes no request when the link carries no token", async () => {
    render(<VerifyEmailPage />);

    expect(await screen.findByText("Verification failed")).toBeInTheDocument();
    expect(screen.getByText(/No verification token found/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows fixed copy on a refusal and never the server's text or the token", async () => {
    window.history.replaceState(null, "", `/verify-email#t=${TOKEN}`);
    respond(false, { message: "SERVER-SIDE DETAIL row 42", code: "SOMETHING" });

    render(<VerifyEmailPage />);

    expect(
      await screen.findByText(/This link is invalid, has expired or was already used/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SERVER-SIDE DETAIL/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(adoptTokenPair).not.toHaveBeenCalled();
  });

  it("shows fixed copy when the request itself fails", async () => {
    window.history.replaceState(null, "", `/verify-email#t=${TOKEN}`);
    fetchMock.mockRejectedValue(new Error("boom: network detail"));

    render(<VerifyEmailPage />);

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("network detail");
  });
});
