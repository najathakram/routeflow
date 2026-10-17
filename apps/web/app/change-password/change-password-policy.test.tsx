import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import ChangePasswordPage from "./page";

/** The forced change after a reset: it says exactly what is missing, never a bare "Failed". */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
jest.mock("@/lib/auth", () => ({ ...jest.requireActual("@/lib/auth"), changePassword: jest.fn() }));

import { changePassword } from "@/lib/auth";
const mockedChange = changePassword as jest.Mock;

const rule = (name: RegExp) =>
  within(screen.getByRole("list", { name: "Password requirements" }))
    .getByText(name)
    .closest("li") as HTMLElement;

async function fill(newPassword: string, submit = true) {
  const user = userEvent.setup();
  renderWithProviders(<ChangePasswordPage />);
  await user.type(screen.getByLabelText("Current password"), "Current-pass-1");
  await user.type(screen.getByLabelText("New password"), newPassword);
  await user.type(screen.getByLabelText("Confirm new password"), newPassword);
  if (submit) await user.click(screen.getByRole("button", { name: /set new password/i }));
  return user;
}

describe("ChangePasswordPage: names exactly what is missing", () => {
  beforeEach(() => jest.clearAllMocks());

  it("a live checklist under New password marks each rule met or missing as you type", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChangePasswordPage />);
    for (const name of [
      /At least 8 characters/,
      /An uppercase letter/,
      /A lowercase letter/,
      /A number or symbol/,
    ]) {
      expect(rule(name)).toHaveAttribute("data-met", "false");
    }
    await user.type(screen.getByLabelText("New password"), "5C6AB7-E3B2041");
    expect(rule(/At least 8 characters/)).toHaveAttribute("data-met", "true");
    expect(rule(/An uppercase letter/)).toHaveAttribute("data-met", "true");
    expect(rule(/A lowercase letter/)).toHaveAttribute("data-met", "false");
    expect(rule(/A lowercase letter/)).toHaveTextContent("missing");
    expect(rule(/A number or symbol/)).toHaveAttribute("data-met", "true");
    expect(screen.getByLabelText("New password")).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining(screen.getByRole("list", { name: "Password requirements" }).id),
    );
    // announced politely once typing pauses
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Still needed: a lowercase letter."),
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it('"test_tenant" names the missing uppercase letter, focuses the field, and never calls the server', async () => {
    await fill("test_tenant");
    expect(await screen.findByText("Add an uppercase letter.")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveFocus();
    expect(mockedChange).not.toHaveBeenCalled();
  });

  it('"Test_tenant" is accepted: an underscore counts as a symbol', async () => {
    mockedChange.mockResolvedValue(undefined);
    await fill("Test_tenant");
    await waitFor(() => expect(mockedChange).toHaveBeenCalledWith("Current-pass-1", "Test_tenant"));
  });

  it('"5C6AB7-E3B2041" names the missing lowercase letter', async () => {
    await fill("5C6AB7-E3B2041");
    expect(await screen.findByText("Add a lowercase letter.")).toBeInTheDocument();
    expect(mockedChange).not.toHaveBeenCalled();
  });

  it("two rules missing are named together", async () => {
    await fill("lowercaseonly");
    expect(
      await screen.findByText("Add an uppercase letter and a number or symbol."),
    ).toBeInTheDocument();
  });

  it("a 400 whose message is an array maps to the per-rule wording", async () => {
    mockedChange.mockRejectedValue({
      response: {
        status: 400,
        data: { message: ["newPassword must be longer than or equal to 8 characters"] },
      },
    });
    await fill("Valid-pass-1");
    expect(await screen.findByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it("a string message still shows; a message-less error says to try again", async () => {
    mockedChange.mockRejectedValueOnce({
      response: { status: 400, data: { message: "Current password is incorrect" } },
    });
    await fill("Valid-pass-1");
    expect(await screen.findByText("Current password is incorrect.")).toBeInTheDocument();
  });

  it("a true unknown error falls back with Try again, never a bare Failed", async () => {
    mockedChange.mockRejectedValueOnce(new Error("Network Error"));
    await fill("Valid-pass-1");
    expect(
      await screen.findByText("Your password couldn't be changed. Try again."),
    ).toBeInTheDocument();
  });
});
