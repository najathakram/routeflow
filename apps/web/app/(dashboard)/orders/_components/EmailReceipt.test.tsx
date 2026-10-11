import * as React from "react";
import userEvent from "@testing-library/user-event";
import { API_ERROR_CODES } from "@routeflow/types";
import { renderWithProviders, screen, waitFor, fireEvent, act } from "@/test-utils/render";
import { EmailReceiptButton, EmailReceiptRow } from "./EmailReceipt";
import { useEmailReceipt } from "./useEmailReceipt";

/**
 * SA-751r "Email receipt": every state of the UX brief, at the component. The API is mocked at the apiClient boundary. The
 * harness mirrors the screens: Print, Email receipt, New sale in one row, the inline row under it. Placeholders only.
 */
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: jest.fn() },
}));

function Harness({ prefill = "", orderId = "o1" }: { prefill?: string; orderId?: string }) {
  const email = useEmailReceipt({ orderId, prefill });
  return (
    <div>
      <div className="flex flex-wrap gap-2 print:hidden">
        <button type="button">Print</button>
        <EmailReceiptButton email={email} />
        <button type="button">New sale</button>
      </div>
      <EmailReceiptRow email={email} />
    </div>
  );
}

const field = () => screen.getByRole("textbox", { name: "Email address" }) as HTMLInputElement;
const openRow = () => fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
const sendButton = () =>
  screen.getByRole("button", { name: /^(Send|Send again|Try again|Sending…)$/ });
const refuse = (code: string, status = 429) => ({
  response: { status, data: { code, message: "RAW SERVER TEXT" } },
});

let onLine = true;
beforeEach(() => {
  jest.clearAllMocks();
  onLine = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => onLine });
  post.mockResolvedValue({ data: { channel: "email", to: "x" } });
});

describe("Email receipt: closed by default", () => {
  it("shows only the button, directly after Print, a 44 px secondary hidden from print", () => {
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Print", "Email receipt", "New sale"]);
    expect(screen.queryByRole("textbox")).toBeNull();
    const b = screen.getByRole("button", { name: "Email receipt" });
    expect(b.className).toContain("min-h-[44px]");
    expect(b.className).toContain("print:hidden");
    expect(b).toHaveAttribute("aria-expanded", "false");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("Email receipt: opening the row", () => {
  it("a named customer: the field is pre-filled and SEND has focus; nothing is sent by opening", () => {
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    expect(field().value).toBe("buyer@example.com");
    expect(sendButton()).toHaveFocus();
    expect(sendButton()).toBeEnabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("a walk-in: the field is empty and focused, Send is disabled", () => {
    renderWithProviders(<Harness />);
    openRow();
    expect(field().value).toBe("");
    expect(field()).toHaveFocus();
    expect(sendButton()).toBeDisabled();
  });

  it("the field is an email input that never autocompletes and names its example", () => {
    renderWithProviders(<Harness />);
    openRow();
    expect(field()).toHaveAttribute("type", "email");
    expect(field()).toHaveAttribute("autocomplete", "off");
    expect(field()).toHaveAttribute("placeholder", "name@example.com");
  });

  it("the layout is mobile-first: a full-width field and a full-width Send that stacks below it until sm", () => {
    renderWithProviders(<Harness />);
    openRow();
    expect(field().className).toContain("w-full");
    expect(field().className).toContain("min-h-[44px]");
    expect(field().closest("form")!.className).toContain("flex-col");
    expect(sendButton().className).toContain("w-full");
    expect(sendButton().className).toContain("min-h-[44px]");
    expect(document.getElementById("email-receipt-row")!.className).toContain("print:hidden");
  });

  it("pressing Email receipt again while open brings focus back to where the cashier acts and does not close it", () => {
    renderWithProviders(<Harness />);
    openRow();
    screen.getByRole("button", { name: "Email receipt" }).focus();
    openRow();
    expect(field()).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });
});

describe("Email receipt: validation", () => {
  it("Send is disabled until the address is valid; an invalid address says so on blur, and fixing it clears the line", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    openRow();
    await user.type(field(), "not-an-address");
    expect(screen.queryByText("Check the email address.")).toBeNull(); // not while typing
    await user.tab();
    expect(await screen.findByText("Check the email address.")).toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(sendButton()).toBeDisabled();
    await user.clear(field());
    await user.type(field(), "ok@example.com");
    expect(screen.queryByText("Check the email address.")).toBeNull();
    expect(sendButton()).toBeEnabled();
  });

  it("an empty field is not 'invalid' (no scolding before the cashier has typed)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    openRow();
    await user.tab();
    expect(screen.queryByText("Check the email address.")).toBeNull();
  });

  it("Enter in an invalid field sends nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    openRow();
    await user.type(field(), "nope{Enter}");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("Email receipt: sending", () => {
  it("Enter sends to /orders/:id/receipt as { channel: 'email', to } and nothing else", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness orderId="ord 1" />);
    openRow();
    await user.type(field(), "buyer@example.com{Enter}");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/orders/ord%201/receipt", {
      channel: "email",
      to: "buyer@example.com",
    });
  });

  it("while sending: a spinner, the button reads 'Sending…' and is disabled, the field is read-only, New sale stays enabled", async () => {
    let resolve!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => (resolve = r)));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    const sending = await screen.findByRole("button", { name: "Sending…" });
    expect(sending).toBeDisabled();
    expect(sending.querySelector(".animate-spin")).not.toBeNull();
    expect(field()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "New sale" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Print" })).toBeEnabled();
    await act(async () => resolve({ data: {} }));
  });

  it("a double press sends once", async () => {
    let resolve!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => (resolve = r)));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.submit(field().closest("form")!);
    fireEvent.submit(field().closest("form")!);
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ data: {} }));
  });

  it("sent: a status line 'Sent to {address}.', the button becomes 'Send again'", async () => {
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Sent to buyer@example.com.");
    expect(screen.getByRole("button", { name: "Send again" })).toBeEnabled();
  });

  it("send again: edit the address and resend in one press (a second request, the new address)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    await screen.findByText("Sent to buyer@example.com.");
    await user.clear(field());
    await user.type(field(), "other@example.com");
    // editing retires the old 'Sent to' line: it was about the other address
    expect(screen.queryByText("Sent to buyer@example.com.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send again" }));
    expect(await screen.findByText("Sent to other@example.com.")).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toEqual({ channel: "email", to: "other@example.com" });
  });

  it("pads are trimmed before they are sent", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    openRow();
    await user.type(field(), "  buyer@example.com  {Enter}");
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].to).toBe("buyer@example.com");
  });
});

describe("Email receipt: failures", () => {
  it("failed: an alert with the fixed copy, the address kept, 'Try again' in place; one press retries", async () => {
    post.mockRejectedValueOnce(refuse(API_ERROR_CODES.RECEIPT_EMAIL_NOT_SENT, 502));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't send. Try again.");
    expect(field().value).toBe("buyer@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Sent to buyer@example.com.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("the server's own text is never shown (any error, any message)", async () => {
    post.mockRejectedValueOnce({ response: { status: 500, data: { message: "RAW SERVER TEXT" } } });
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent("RAW SERVER TEXT");
  });

  it("a network error (no response at all) is the same retryable failure", async () => {
    post.mockRejectedValueOnce(new Error("Network Error"));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't send. Try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("the per-order limit: its copy, and NO retry control (not Send, not Try again)", async () => {
    post.mockRejectedValueOnce(refuse(API_ERROR_CODES.RECEIPT_EMAIL_ORDER_LIMIT));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This receipt reached its email limit.",
    );
    expect(screen.queryByRole("button", { name: /^(Send|Send again|Try again)$/ })).toBeNull();
    expect(field()).toHaveAttribute("readonly");
    // Enter in the field cannot send either
    fireEvent.submit(field().closest("form")!);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("the per-day limit: its copy, no retry control", async () => {
    post.mockRejectedValueOnce(refuse(API_ERROR_CODES.RECEIPT_EMAIL_DAY_LIMIT));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Today's email limit is reached. Print instead.",
    );
    expect(screen.queryByRole("button", { name: /^(Send|Send again|Try again)$/ })).toBeNull();
  });

  it("the 4th send: three sent, then the limit, with no retry (the whole path)", async () => {
    const user = userEvent.setup();
    post
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(refuse(API_ERROR_CODES.RECEIPT_EMAIL_ORDER_LIMIT));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    await user.click(sendButton());
    await screen.findByText("Sent to buyer@example.com.");
    for (let i = 0; i < 2; i++) {
      await user.click(screen.getByRole("button", { name: "Send again" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(i + 2));
      await screen.findByText("Sent to buyer@example.com.");
    }
    await user.click(screen.getByRole("button", { name: "Send again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("email limit");
    expect(screen.queryByRole("button", { name: /Send|Try again/ })).toBeNull();
  });

  it("a sale voided after the view opened: its fixed copy, NO retry control (not Send, not Try again), and Enter cannot send", async () => {
    post.mockRejectedValueOnce(refuse(API_ERROR_CODES.RECEIPT_NOT_AVAILABLE, 409));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This sale can't be emailed any more.",
    );
    expect(screen.queryByRole("button", { name: /^(Send|Send again|Try again)$/ })).toBeNull();
    expect(field()).toHaveAttribute("readonly");
    fireEvent.submit(field().closest("form")!);
    expect(post).toHaveBeenCalledTimes(1);
    // still final after the row is closed and reopened
    fireEvent.keyDown(field(), { key: "Escape" });
    openRow();
    expect(screen.getByRole("alert")).toHaveTextContent("This sale can't be emailed any more.");
    expect(screen.queryByRole("button", { name: /Send|Try again/ })).toBeNull();
  });

  it("the per-address cap: its copy, Send is off for THIS address, and a different address can be sent in one press", async () => {
    const user = userEvent.setup();
    post.mockRejectedValueOnce(refuse(API_ERROR_CODES.RECEIPT_EMAIL_ADDRESS_LIMIT));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This address reached today's receipt limit.",
    );
    expect(sendButton()).toBeDisabled(); // the same address would be refused again
    expect(field()).not.toHaveAttribute("readonly"); // but the cashier may type another
    fireEvent.submit(field().closest("form")!);
    expect(post).toHaveBeenCalledTimes(1);
    await user.clear(field());
    await user.type(field(), "other@example.com");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(sendButton());
    expect(await screen.findByText("Sent to other@example.com.")).toBeInTheDocument();
    expect(post.mock.calls[1][1]).toEqual({ channel: "email", to: "other@example.com" });
  });

  it("a limit stays after the row is closed and reopened (it is about the order, not the attempt)", async () => {
    post.mockRejectedValueOnce(refuse(API_ERROR_CODES.RECEIPT_EMAIL_ORDER_LIMIT));
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.click(sendButton());
    await screen.findByRole("alert");
    fireEvent.keyDown(field(), { key: "Escape" });
    openRow();
    expect(screen.getByRole("alert")).toHaveTextContent("This receipt reached its email limit.");
    expect(screen.queryByRole("button", { name: /^(Send|Send again|Try again)$/ })).toBeNull();
  });
});

describe("Email receipt: offline", () => {
  it("Send is disabled with the offline line and nothing is queued; coming back online re-enables it", async () => {
    onLine = false;
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    expect(
      screen.getByText("You're offline. Print it, or send it later from Today's sales."),
    ).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    fireEvent.submit(field().closest("form")!);
    expect(post).not.toHaveBeenCalled();
    onLine = true;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(/You're offline/)).toBeNull();
    expect(sendButton()).toBeEnabled();
  });

  it("going offline while the row is open disables Send", () => {
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    expect(sendButton()).toBeEnabled();
    onLine = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("You're offline.");
  });
});

describe("Email receipt: keyboard", () => {
  it("Escape closes the row and returns focus to Email receipt", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    openRow();
    await user.type(field(), "a");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Email receipt" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Email receipt" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("Escape also works from the Send button", () => {
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.keyDown(sendButton(), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Email receipt" })).toHaveFocus();
  });

  it("reopening keeps what the cashier typed", () => {
    renderWithProviders(<Harness prefill="buyer@example.com" />);
    openRow();
    fireEvent.change(field(), { target: { value: "typed@example.com" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    openRow();
    expect(field().value).toBe("typed@example.com");
  });
});
