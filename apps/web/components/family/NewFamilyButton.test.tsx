import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { NewFamilyButton } from "./NewFamilyButton";

let role = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("./CreateFamilyModal", () => ({
  CreateFamilyModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">New family dialog</div> : null,
}));

describe("NewFamilyButton", () => {
  it.each([
    ["OPERATOR", true],
    ["TENANT_ADMIN", true],
    ["DRIVER", false],
    ["CUSTOMER", false],
  ])("role %s -> shown: %s", (r, shown) => {
    role = r;
    render(<NewFamilyButton />);
    expect(!!screen.queryByRole("button", { name: "New family" })).toBe(shown);
  });

  it("opens the dialog on click", () => {
    role = "OPERATOR";
    render(<NewFamilyButton />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New family" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
