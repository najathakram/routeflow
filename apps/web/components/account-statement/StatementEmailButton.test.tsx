import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { ReadOnlyGateProvider } from "@/lib/read-only-gate";
import { StatementEmailButton } from "./StatementEmailButton";

/**
 * SA-1078 W-1096 PR-4 (web): E3 (no address on file → the sheet asks), E4/E5 (the failure lines, typed address kept),
 * E7 (warning), E9 (double tap = one send), E10 (read-only: disabled with the hint).
 */

const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => mockPost(...a) },
}));

const apiError = (code: string, message = "server text") =>
  Object.assign(new Error("Request failed"), {
    response: { status: 400, data: { code, message } },
  });

beforeEach(() => {
  mockPost.mockReset();
  mockPost.mockResolvedValue({ data: { success: true, sentTo: "ap@acme.example" } });
});

describe("the Email control", () => {
  it("E1/E2: opens a form prefilled with the on-file address; Send posts what the field says", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementEmailButton customerId="c1" emailOnFile="ap@acme.example" />);
    expect(screen.queryByLabelText("Send to")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Email" }));
    const field = screen.getByLabelText("Send to");
    expect(field).toHaveValue("ap@acme.example");
    await user.clear(field);
    await user.type(field, "billing@acme.example");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith("/customers/c1/account-statement/email", {
      email: "billing@acme.example",
    });
  });

  it("success says where it went, and the form closes", async () => {
    mockPost.mockResolvedValue({ data: { success: true, sentTo: "ap@acme.example" } });
    const user = userEvent.setup();
    renderWithProviders(<StatementEmailButton customerId="c1" emailOnFile="ap@acme.example" />);
    await user.click(screen.getByRole("button", { name: "Email" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Statement sent to ap@acme.example")).toBeInTheDocument();
    expect(screen.queryByLabelText("Send to")).toBeNull();
  });

  it("E3: with no address on file the field is empty, and Send waits for one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementEmailButton customerId="c1" emailOnFile={null} />);
    await user.click(screen.getByRole("button", { name: "Email" }));
    expect(screen.getByLabelText("Send to")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(screen.getByLabelText("Send to"), "ap@acme.example");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("E4: email not set up says so, in words an operator can act on, and nothing else changes", async () => {
    mockPost.mockRejectedValue(apiError("EMAIL_NOT_CONFIGURED"));
    const user = userEvent.setup();
    renderWithProviders(<StatementEmailButton customerId="c1" emailOnFile="ap@acme.example" />);
    await user.click(screen.getByRole("button", { name: "Email" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Email isn't set up yet");
    expect(alert).not.toHaveTextContent("server text");
    expect(screen.getByLabelText("Send to")).toHaveValue("ap@acme.example");
  });

  it("E5: a failed send keeps the typed address and offers Send again", async () => {
    mockPost.mockRejectedValueOnce(
      apiError("EMAIL_SEND_FAILED", "The statement couldn't be emailed (550)."),
    );
    const user = userEvent.setup();
    renderWithProviders(<StatementEmailButton customerId="c1" emailOnFile={null} />);
    await user.click(screen.getByRole("button", { name: "Email" }));
    await user.type(screen.getByLabelText("Send to"), "typed@acme.example");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't be emailed");
    expect(screen.getByLabelText("Send to")).toHaveValue("typed@acme.example");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    mockPost.mockResolvedValueOnce({ data: { success: true, sentTo: "typed@acme.example" } });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Statement sent to typed@acme.example")).toBeInTheDocument();
  });

  it("E7: a tenant-SMTP fallback still reads as sent, with the warning shown", async () => {
    mockPost.mockResolvedValue({
      data: {
        success: true,
        sentTo: "ap@acme.example",
        warning: "Your SMTP login was refused.",
        fromAddress: "noreply@routeflow.example",
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<StatementEmailButton customerId="c1" emailOnFile="ap@acme.example" />);
    await user.click(screen.getByRole("button", { name: "Email" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Statement sent to ap@acme.example")).toBeInTheDocument();
    expect(screen.getByText(/Your SMTP login was refused\./)).toBeInTheDocument();
  });

  it("E9: a double tap is one send, and the button is busy while it runs", async () => {
    let finish: (v: unknown) => void = () => undefined;
    mockPost.mockReturnValue(new Promise((r) => (finish = r)));
    const user = userEvent.setup();
    renderWithProviders(<StatementEmailButton customerId="c1" emailOnFile="ap@acme.example" />);
    await user.click(screen.getByRole("button", { name: "Email" }));
    const send = screen.getByRole("button", { name: "Send" });
    await user.dblClick(send);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
    finish({ data: { success: true, sentTo: "ap@acme.example" } });
    expect(await screen.findByText("Statement sent to ap@acme.example")).toBeInTheDocument();
  });

  it("E10: a read-only workspace disables Email and says why; nothing is posted", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReadOnlyGateProvider view={{ status: "READ_ONLY" } as any}>
        <StatementEmailButton customerId="c1" emailOnFile="ap@acme.example" />
      </ReadOnlyGateProvider>,
    );
    const email = screen.getByRole("button", { name: "Email" });
    expect(email).toBeDisabled();
    expect(screen.getByTestId("statement-email-read-only")).toBeInTheDocument();
    await user.click(email);
    expect(screen.queryByLabelText("Send to")).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
