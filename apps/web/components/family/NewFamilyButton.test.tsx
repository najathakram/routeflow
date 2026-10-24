import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewFamilyButton } from "./NewFamilyButton";

let role = "OPERATOR";
let query = "";
const replace = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(query),
}));
jest.mock("./CreateFamilyModal", () => ({
  CreateFamilyModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">New family dialog</div> : null,
}));

beforeEach(() => {
  role = "OPERATOR";
  query = "";
  replace.mockClear();
  window.history.replaceState({}, "", "/products");
});

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
    render(<NewFamilyButton />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New family" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("?newFamily=1 as an OPERATOR opens the dialog and strips the param", async () => {
    query = "newFamily=1&q=cola";
    window.history.replaceState({}, "", "/products?newFamily=1&q=cola");
    render(<NewFamilyButton />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/products?q=cola", { scroll: false }),
    );
  });

  it("?newFamily=1 alone strips back to /products", async () => {
    query = "newFamily=1";
    window.history.replaceState({}, "", "/products?newFamily=1");
    render(<NewFamilyButton />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/products", { scroll: false }));
  });

  it("?newFamily=1 for any other role does nothing", () => {
    role = "DRIVER";
    query = "newFamily=1";
    render(<NewFamilyButton />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
