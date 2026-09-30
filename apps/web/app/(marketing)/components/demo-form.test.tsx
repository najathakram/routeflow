import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { DemoForm } from "./demo-form";

// R-MKT T8c — the contact page's DemoForm prepares a mailto: draft and
// never submits/stores anything (R8). One `it` per plan oracle so each
// produces its own red row rather than all of them hiding behind the first
// failed query.

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^name$/i), "Ada");
  await user.type(screen.getByLabelText(/^email$/i), "ada@example.com");
  await user.type(screen.getByLabelText(/^company$/i), "Northwind");
  await user.type(screen.getByLabelText(/^notes$/i), "x");
  await user.click(screen.getByRole("button", { name: /prepare my demo request/i }));
}

describe("DemoForm — R-MKT T8c", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  it("renders the Name / Email / Company / Notes fields and the submit button (R-MKT T8c)", () => {
    render(<DemoForm />);
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^company$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^notes$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prepare my demo request/i })).toBeInTheDocument();
  });

  it("shows the draft-ready success state on submit (R-MKT T8c)", async () => {
    const user = userEvent.setup();
    render(<DemoForm />);
    await fillAndSubmit(user);

    expect(
      await screen.findByRole("heading", { name: /your email draft is ready/i }),
    ).toBeInTheDocument();
  });

  it('links "Open email app" at mailto:hello@routeflow.info with a subject (R-MKT T8c)', async () => {
    const user = userEvent.setup();
    render(<DemoForm />);
    await fillAndSubmit(user);

    const openLink = screen.getByRole("link", { name: /open email app/i });
    const href = openLink.getAttribute("href") ?? "";
    expect(href.startsWith("mailto:hello@routeflow.info?subject=")).toBe(true);
  });

  it("encodes the company into the mailto subject (R-MKT T8c)", async () => {
    const user = userEvent.setup();
    render(<DemoForm />);
    await fillAndSubmit(user);

    const href = screen.getByRole("link", { name: /open email app/i }).getAttribute("href") ?? "";
    const subject = new URL(href).searchParams.get("subject") ?? "";
    expect(subject).toContain("RouteFlow demo request — Northwind");
  });

  it("never submits or stores the request — no network call on submit (R8, R-MKT T8c)", async () => {
    const user = userEvent.setup();
    render(<DemoForm />);
    await fillAndSubmit(user);

    await screen.findByRole("heading", { name: /your email draft is ready/i });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not reach the draft-ready state when submitted with all fields empty (R-MKT T8c)", async () => {
    const user = userEvent.setup();
    render(<DemoForm />);
    await user.click(screen.getByRole("button", { name: /prepare my demo request/i }));

    expect(
      screen.queryByRole("heading", { name: /your email draft is ready/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('"Start a new draft" restores the empty form (R-MKT T8c)', async () => {
    const user = userEvent.setup();
    render(<DemoForm />);
    await fillAndSubmit(user);

    await user.click(screen.getByRole("button", { name: /start a new draft/i }));
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /your email draft is ready/i }),
    ).not.toBeInTheDocument();
  });
});
