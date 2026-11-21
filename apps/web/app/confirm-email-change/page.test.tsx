/**
 * B461 (SA-1116): the confirm page for a held login-email change. Opening the link sends nothing (a mail scanner's
 * prefetch must not confirm it); the button POSTs the token in the body; every refusal shows the fixed sentence for
 * its code, never the server's text.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { API_ERROR_CODES } from "@routeflow/types";
import { EMAIL_CHANGE_REFUSAL_COPY } from "@/lib/email-change-copy";

let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useSearchParams: () => mockSearchParams,
}));

import ConfirmEmailChangePage from "./page";

const TOKEN = "a".repeat(64);

const reply = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

describe("confirm-email-change page", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockSearchParams = new URLSearchParams({ token: TOKEN });
  });

  it("makes no request on open and shows the confirm button", async () => {
    render(<ConfirmEmailChangePage />);

    expect(await screen.findByRole("button", { name: /confirm this address/i })).toBeEnabled();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the button POSTs the token in the body (not the URL) and shows the new address", async () => {
    const user = userEvent.setup();
    fetchSpy.mockReturnValueOnce(reply(200, { email: "new@example.com" }));
    render(<ConfirmEmailChangePage />);

    await user.click(await screen.findByRole("button", { name: /confirm this address/i }));

    expect(await screen.findByText(/your login email is now new@example.com/i)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/auth\/confirm-email-change$/);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
    expect(screen.getByRole("link", { name: /continue to sign in/i })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it.each([
    [400, API_ERROR_CODES.EMAIL_CHANGE_LINK_INVALID],
    [409, API_ERROR_CODES.EMAIL_TAKEN],
  ])(
    "a %s %s answer shows its fixed sentence, never the server's message",
    async (status, code) => {
      const user = userEvent.setup();
      fetchSpy.mockReturnValueOnce(reply(status, { code, message: "SERVER TEXT MUST NOT SHOW" }));
      render(<ConfirmEmailChangePage />);

      await user.click(await screen.findByRole("button", { name: /confirm this address/i }));

      expect(
        await screen.findByText(
          (EMAIL_CHANGE_REFUSAL_COPY as Record<string, string>)[code as string],
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/SERVER TEXT MUST NOT SHOW/)).not.toBeInTheDocument();
    },
  );

  it("an unknown answer reads as an invalid link", async () => {
    const user = userEvent.setup();
    fetchSpy.mockReturnValueOnce(reply(500, { message: "boom" }));
    render(<ConfirmEmailChangePage />);

    await user.click(await screen.findByRole("button", { name: /confirm this address/i }));

    expect(
      await screen.findByText(EMAIL_CHANGE_REFUSAL_COPY[API_ERROR_CODES.EMAIL_CHANGE_LINK_INVALID]),
    ).toBeInTheDocument();
  });

  it("a network failure says Try again and keeps a button that tries again; a coded refusal offers none", async () => {
    const user = userEvent.setup();
    fetchSpy
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(reply(200, { email: "new@example.com" }));
    render(<ConfirmEmailChangePage />);

    await user.click(await screen.findByRole("button", { name: /confirm this address/i }));
    expect(await screen.findByText(/something went wrong\. try again/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^try again$/i }));

    expect(await screen.findByText(/your login email is now new@example.com/i)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("a coded refusal is final: no retry button", async () => {
    const user = userEvent.setup();
    fetchSpy.mockReturnValueOnce(
      reply(400, { code: API_ERROR_CODES.EMAIL_CHANGE_LINK_INVALID, message: "x" }),
    );
    render(<ConfirmEmailChangePage />);

    await user.click(await screen.findByRole("button", { name: /confirm this address/i }));
    await screen.findByText(EMAIL_CHANGE_REFUSAL_COPY[API_ERROR_CODES.EMAIL_CHANGE_LINK_INVALID]);

    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("a page opened without a token shows the invalid-link sentence and no button", async () => {
    mockSearchParams = new URLSearchParams();
    render(<ConfirmEmailChangePage />);

    expect(
      await screen.findByText(EMAIL_CHANGE_REFUSAL_COPY[API_ERROR_CODES.EMAIL_CHANGE_LINK_INVALID]),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm this address/i })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
