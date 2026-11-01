import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SignupPage from "./page";

/**
 * W2 B7 + B8 (COPY.md section 8): the form asks four things (Business name, Workspace ID, Email,
 * Password) and shows the auto-filled username as one line with a Change button. Errors appear when a
 * field is left, not only on submit.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/signup",
}));

let usernameAvailable = true;
function mockFetch() {
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/public/tenants/register")) {
      return { ok: false, json: async () => ({ message: "stop here" }) } as Response;
    }
    if (u.includes("username-available")) {
      return { ok: true, json: async () => ({ available: usernameAvailable }) } as Response;
    }
    return { ok: true, json: async () => ({ available: true }) } as Response;
  }) as unknown as typeof fetch;
}

function typeBusiness(name = "Acme Distribution") {
  fireEvent.change(screen.getByPlaceholderText("Acme Distribution Co."), {
    target: { value: name },
  });
}

describe("SignupPage — four fields and a username line (W2 B8)", () => {
  beforeEach(() => {
    usernameAvailable = true;
    mockFetch();
  });

  it("asks for Business name, Workspace ID, Email and Password, and nothing else", () => {
    render(<SignupPage />);
    expect(screen.getByLabelText("Business name")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Confirm password")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(document.querySelectorAll("form input:not([type=hidden])")).toHaveLength(4);
  });

  it("shows no username line until there is a username to show", () => {
    render(<SignupPage />);
    expect(screen.queryByText(/^Username:/)).not.toBeInTheDocument();
  });

  it("shows the auto-filled username as one line with a Change button", async () => {
    render(<SignupPage />);
    typeBusiness();
    expect(await screen.findByText("Username: acme_distribution_admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
  });

  it("Change opens the field with the username in it, editable", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);
    typeBusiness();
    await user.click(await screen.findByRole("button", { name: "Change" }));

    const field = screen.getByLabelText("Username");
    expect(field).toHaveValue("acme_distribution_admin");
    await user.clear(field);
    await user.type(field, "acme_boss");
    expect(field).toHaveValue("acme_boss");
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
  });

  it("opens the field by itself when the auto-filled name is taken", async () => {
    usernameAvailable = false;
    render(<SignupPage />);
    typeBusiness();
    expect(await screen.findByLabelText("Username")).toHaveValue("acme_distribution_admin");
    expect(
      screen.getByText("This username is reserved. Please choose a different one."),
    ).toBeInTheDocument();
  });

  it("a field that opened by itself stays open and keeps focus while the person types in it", async () => {
    usernameAvailable = false;
    const user = userEvent.setup();
    render(<SignupPage />);
    typeBusiness();
    const field = await screen.findByLabelText("Username");
    usernameAvailable = true;
    await user.click(field);
    await user.type(field, "2");
    // The first keystroke clears "taken"; the field must not close under the cursor.
    expect(screen.getByLabelText("Username")).toBe(field);
    expect(field).toHaveFocus();
    expect(field).toHaveValue("acme_distribution_admin2");
    await user.type(field, "x");
    await waitFor(() =>
      expect(screen.getByText("This username is available.")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Username")).toHaveFocus();
    expect(screen.getByLabelText("Username")).toHaveValue("acme_distribution_admin2x");
  });

  it("still sends the username with the sign-up", async () => {
    render(<SignupPage />);
    typeBusiness();
    await screen.findByText("Username: acme_distribution_admin");
    fireEvent.change(screen.getByPlaceholderText("you@acme.com"), {
      target: { value: "owner@acme.example" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "Sup3rSecret!x9" },
    });
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);

    await waitFor(() => {
      const call = (global.fetch as jest.Mock).mock.calls.find(([u]) =>
        String(u).includes("/public/tenants/register"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(call[1].body)).toMatchObject({
        slug: "acme-distribution",
        adminUsername: "acme_distribution_admin",
        adminEmail: "owner@acme.example",
      });
    });
  });
});

describe("SignupPage — errors on leaving a field (W2 B7)", () => {
  beforeEach(() => {
    usernameAvailable = true;
    mockFetch();
  });

  it("shows the Business name error when the field is left empty, with no submit", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.click(screen.getByLabelText("Business name"));
    await user.tab();
    expect(
      await screen.findByText("Business name must be at least 2 characters"),
    ).toBeInTheDocument();
  });

  it("shows the Email error when a bad address is left", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.tab();
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
  });

  it("shows nothing before a field has been touched", () => {
    render(<SignupPage />);
    expect(
      screen.queryByText("Business name must be at least 2 characters"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Enter a valid email address")).not.toBeInTheDocument();
  });
});
