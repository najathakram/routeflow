import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SignupPage from "./page";

/**
 * W2 (COPY.md 2k): the sign-up page says what a visitor gets in one look, and hands the Workspace ID
 * to the check-email screen, which shows it (sign-in asks for it typed).
 */
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function mockFetch(registerBody: object = { emailSent: true }) {
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    if (String(url).includes("/public/tenants/register")) {
      return { ok: true, json: async () => registerBody } as Response;
    }
    return { ok: true, json: async () => ({ available: true }) } as Response;
  }) as unknown as typeof fetch;
}

describe("SignupPage — words (W2 B4)", () => {
  beforeEach(() => {
    push.mockClear();
    mockFetch();
  });

  it("opens with the offer: Try it free for 14 days. / No card needed.", () => {
    render(<SignupPage />);
    expect(screen.getByRole("heading", { name: "Try it free for 14 days." })).toBeInTheDocument();
    expect(screen.getByText("No card needed.")).toBeInTheDocument();
    expect(screen.queryByText("Your next chapter starts here.")).not.toBeInTheDocument();
  });

  it("the kicker says Distributor account", () => {
    render(<SignupPage />);
    expect(screen.getByText("Distributor account")).toBeInTheDocument();
    expect(screen.queryByText("Distributor workspace")).not.toBeInTheDocument();
  });

  it("says the Workspace ID is needed to sign in, in plain words", () => {
    render(<SignupPage />);
    expect(
      screen.getByText("You’ll need this to sign in. Use small letters, numbers, and dashes (-)."),
    ).toBeInTheDocument();
  });

  it("the buyer door reads Buying from a distributor? Create a retailer account", () => {
    render(<SignupPage />);
    expect(screen.getByText(/^Buying from a distributor\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a retailer account" })).toHaveAttribute(
      "href",
      "/buyer/register",
    );
  });
});

describe("SignupPage — hands the Workspace ID on (W2 B1)", () => {
  it("sends the Workspace ID to check-email with the email", async () => {
    push.mockClear();
    mockFetch({ emailSent: true });
    render(<SignupPage />);
    fireEvent.change(screen.getByPlaceholderText("Acme Distribution Co."), {
      target: { value: "Acme Distribution Co." },
    });
    fireEvent.change(screen.getByPlaceholderText("acme-distribution"), {
      target: { value: "acme-distribution" },
    });
    fireEvent.change(screen.getByPlaceholderText("you@acme.com"), {
      target: { value: "owner@acme.example" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "Sup3rSecret!x9" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(push).toHaveBeenCalled());
    const url = new URL(String(push.mock.calls[0][0]), "http://x");
    expect(url.pathname).toBe("/signup/check-email");
    expect(url.searchParams.get("email")).toBe("owner@acme.example");
    expect(url.searchParams.get("workspace")).toBe("acme-distribution");
  });
});

// W2 B6 (COPY.md section 8): the password rule sits under the field, not only in a placeholder that
// disappears when typing starts, and it stays while the person types or a field error shows.
describe("SignupPage — password rule under the field (W2 B6)", () => {
  beforeEach(() => mockFetch());

  const rule = () => screen.getByText(/^At least 8 characters\./);

  it("shows the rule under the password field from the start", () => {
    render(<SignupPage />);
    expect(rule()).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("At least 8 characters").parentElement?.parentElement,
    ).toContainElement(rule());
  });

  it("keeps the rule while typing", () => {
    render(<SignupPage />);
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "abc" },
    });
    expect(rule()).toBeInTheDocument();
  });

  it("keeps the rule next to the error after a failed submit", async () => {
    render(<SignupPage />);
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "abc" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(await screen.findByText("Password must be at least 8 characters")).toBeInTheDocument();
    expect(rule()).toBeInTheDocument();
  });
});
