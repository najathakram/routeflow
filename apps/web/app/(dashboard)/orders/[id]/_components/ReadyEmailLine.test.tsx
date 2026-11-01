import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";

const get = jest.fn();
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
jest.mock("@/lib/tenant-timezone", () => ({ useTenantTimeZone: () => "UTC" }));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast }) };
});

import { ReadyEmailLine } from "./ReadyEmailLine";

/**
 * W-1060 (SA-1070 R33/R34): the one line under the order's actions, one state per row, and Send again asks first.
 * The 14:14 UTC stamp reads "Oct 31, 2:14 PM" because the mocked zone is UTC.
 */
describe("ReadyEmailLine", () => {
  const AT = "2026-10-31T14:14:00.000Z";
  const send = (preview: Record<string, unknown>, last: Record<string, unknown> | null) =>
    get.mockResolvedValue({ data: { preview, last } });
  const line = (p: { status?: string } = {}) =>
    renderWithProviders(
      <ReadyEmailLine
        orderId="ord-1"
        status={p.status ?? "CONFIRMED"}
        customerName="Acme"
        onError={jest.fn()}
      />,
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    [
      "last SENT, order Ready",
      { notice: "SENT", email: "buyer@acme.test" },
      { notice: "SENT", email: "buyer@acme.test", at: AT },
      true,
      "Ready email sent to buyer@acme.test, Oct 31, 2:14 PM.",
      "Send again",
    ],
    [
      "last SENT after a demote (order not Ready): the line stays, no button",
      { notice: "SENT", email: "buyer@acme.test" },
      { notice: "SENT", email: "buyer@acme.test", at: AT },
      false,
      "Ready email sent to buyer@acme.test, Oct 31, 2:14 PM.",
      null,
    ],
    [
      "last FAILED, order Ready",
      { notice: "SENT", email: "buyer@acme.test" },
      { notice: "FAILED", at: AT },
      true,
      "The ready email didn't send, Oct 31, 2:14 PM.",
      "Send email",
    ],
    [
      "no record, a press would email",
      { notice: "SENT", email: "buyer@acme.test" },
      null,
      false,
      "Marking ready emails buyer@acme.test.",
      null,
    ],
    [
      "no record, no address",
      { notice: "NO_EMAIL" },
      null,
      false,
      "No email on file, so marking ready tells nobody.",
      null,
    ],
    [
      "no record, buyer opted out",
      { notice: "OPTED_OUT" },
      null,
      false,
      "This customer turned off order emails.",
      null,
    ],
    ["no record, emails off", { notice: "OFF" }, null, false, "Your order emails are off.", null],
  ])("R33 %s", async (_name, preview, last, ready, text, button) => {
    send(preview, last);
    line({ status: ready ? "OUT_FOR_DELIVERY" : "CONFIRMED" });
    expect(await screen.findByTestId("ready-email-line")).toHaveTextContent(text);
    if (button) expect(screen.getByRole("button", { name: button })).toBeInTheDocument();
    else expect(screen.queryByRole("button")).toBeNull();
  });

  it("says nothing once the order is Ready with no email behind it", async () => {
    send({ notice: "NO_EMAIL" }, null);
    line({ status: "OUT_FOR_DELIVERY" });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId("ready-email-line")).toBeNull();
  });

  // A finished order has no Ready button, so it promises no email: only a record of what was sent stays.
  it.each(["DELIVERED", "CANCELLED", "DRAFT"])(
    '%s with no record says nothing (no false "Marking ready emails")',
    async (status) => {
      send({ notice: "SENT", email: "buyer@acme.test" }, null);
      line({ status });
      await waitFor(() => expect(get).toHaveBeenCalled());
      expect(screen.queryByTestId("ready-email-line")).toBeNull();
    },
  );

  it.each(["DELIVERED", "CANCELLED"])(
    "%s keeps the line of what was sent, with no button",
    async (status) => {
      send(
        { notice: "SENT", email: "buyer@acme.test" },
        { notice: "SENT", email: "buyer@acme.test", at: AT },
      );
      line({ status });
      expect(await screen.findByTestId("ready-email-line")).toHaveTextContent(
        "Ready email sent to buyer@acme.test, Oct 31, 2:14 PM.",
      );
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it("R34: Send again asks first, naming the address and the first send; Cancel posts nothing", async () => {
    send(
      { notice: "SENT", email: "buyer@acme.test" },
      { notice: "SENT", email: "buyer@acme.test", at: AT },
    );
    const user = userEvent.setup();
    line({ status: "OUT_FOR_DELIVERY" });
    await user.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText("Email this customer again?")).toBeInTheDocument();
    expect(
      screen.getByText("buyer@acme.test was emailed on Oct 31 at 2:14 PM."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(post).not.toHaveBeenCalled();
  });

  it("confirming Send again posts resend: true once", async () => {
    send(
      { notice: "SENT", email: "buyer@acme.test" },
      { notice: "SENT", email: "buyer@acme.test", at: AT },
    );
    post.mockResolvedValue({ data: { notice: "SENT", email: "buyer@acme.test" } });
    const user = userEvent.setup();
    line({ status: "OUT_FOR_DELIVERY" });
    await user.click(await screen.findByRole("button", { name: "Send again" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Send again")!,
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/orders/ord-1/ready-for-pickup", { resend: true });
  });

  it("Send email after a failed send needs no confirm", async () => {
    send({ notice: "SENT", email: "buyer@acme.test" }, { notice: "FAILED", at: AT });
    post.mockResolvedValue({ data: { notice: "SENT", email: "buyer@acme.test" } });
    const user = userEvent.setup();
    line({ status: "OUT_FOR_DELIVERY" });
    await user.click(await screen.findByRole("button", { name: "Send email" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Email this customer again?")).toBeNull();
  });
});
