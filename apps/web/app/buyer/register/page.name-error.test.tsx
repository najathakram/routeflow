import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import BuyerRegisterPage from "./page";

/**
 * B964: a refused formula-led buyer name (400 `TEXT_CELL_FORMULA_LEAD`, field `buyerName`) on buyer registration shows FIXED copy
 * ("Name can't start with ..."), never the server message or the camelCase key. Any other failure keeps its message.
 */
const registerMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({ register: registerMock, isAuthenticated: false }),
}));

const refusal = (body: object) =>
  Object.assign(new Error("Request failed with status code 400"), {
    response: { status: 400, data: body },
  });

async function submit() {
  render(<BuyerRegisterPage />);
  fireEvent.change(document.querySelector("input[name='name']") as HTMLInputElement, {
    target: { value: "=HYPERLINK(1)" },
  });
  fireEvent.change(document.querySelector("input[name='email']") as HTMLInputElement, {
    target: { value: "pat@example.com" },
  });
  fireEvent.change(document.querySelector("input[name='password']") as HTMLInputElement, {
    target: { value: "Sup3rSecret!x9" },
  });
  fireEvent.change(document.querySelector("input[name='confirmPassword']") as HTMLInputElement, {
    target: { value: "Sup3rSecret!x9" },
  });
  fireEvent.submit(document.querySelector("form") as HTMLFormElement);
}

describe("BuyerRegisterPage: refused name (B964)", () => {
  it("shows the Name copy, not the server message or the camelCase key", async () => {
    registerMock.mockRejectedValue(
      refusal({
        statusCode: 400,
        code: "TEXT_CELL_FORMULA_LEAD",
        field: "buyerName",
        message: "Name can't start with =, +, -, @ or a tab/line break",
      }),
    );
    await submit();
    expect(
      await screen.findByText("Name can't start with =, +, -, @ or a tab/line break."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/buyerName/)).not.toBeInTheDocument();
  });

  it("any other failure keeps the server message", async () => {
    registerMock.mockRejectedValue(
      refusal({ message: "An account with this email already exists" }),
    );
    await submit();
    expect(
      await screen.findByText("An account with this email already exists"),
    ).toBeInTheDocument();
  });
});
