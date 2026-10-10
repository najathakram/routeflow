import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SignupPage from "./page";

/**
 * B956: a refused formula-led business name (400 `TEXT_CELL_FORMULA_LEAD`) on tenant signup shows
 * FIXED copy with a human label, never the server message ("businessName must not start with …").
 */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

const registerBody = (over: object) => ({
  statusCode: 400,
  code: "TEXT_CELL_FORMULA_LEAD",
  field: "businessName",
  message: "businessName must not start with = + - @ or a tab/line break",
  ...over,
});

function mockFetch(registerResponse: { ok: boolean; body: unknown }) {
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/public/tenants/register")) {
      return { ok: registerResponse.ok, json: async () => registerResponse.body } as Response;
    }
    return { ok: true, json: async () => ({ available: true }) } as Response;
  }) as unknown as typeof fetch;
}

async function fillAndSubmit() {
  render(<SignupPage />);
  fireEvent.change(screen.getByPlaceholderText("Acme Distribution Co."), {
    target: { value: "=HYPERLINK(1)" },
  });
  fireEvent.change(screen.getByPlaceholderText("acme-distribution"), {
    target: { value: "acme-distribution" },
  });
  fireEvent.change(screen.getByPlaceholderText("you@acme.com"), {
    target: { value: "owner@acme.example" },
  });
  fireEvent.change(screen.getByPlaceholderText("acme_admin"), { target: { value: "acme_admin" } });
  fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
    target: { value: "Sup3rSecret!x9" },
  });
  fireEvent.change(screen.getByPlaceholderText("Re-enter your password"), {
    target: { value: "Sup3rSecret!x9" },
  });
  fireEvent.submit(document.querySelector("form") as HTMLFormElement);
}

describe("SignupPage — refused business name (B956)", () => {
  it("shows the Business name copy, not the server message or the camelCase key", async () => {
    mockFetch({ ok: false, body: registerBody({}) });
    await fillAndSubmit();
    expect(
      await screen.findByText("Business name can't start with =, +, -, @ or a tab/line break."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/businessName/)).not.toBeInTheDocument();
  });

  it("any other register failure keeps the server message", async () => {
    mockFetch({ ok: false, body: { message: "Slug already taken" } });
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByText("Slug already taken")).toBeInTheDocument());
  });
});
