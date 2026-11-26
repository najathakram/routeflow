import { render, screen } from "@testing-library/react";
import SignupPage from "./page";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/signup",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/UmamiScript", () => ({ UmamiScript: () => null }));

// The submit button must carry the shell's visible button class (its colours are pinned in
// components/auth/auth-shell-tokens.static.test.ts) and be enabled on a fresh form.
describe("signup submit button", () => {
  it("is the shell's rf-btn inside .rf-auth, enabled, with its label", () => {
    const { container } = render(<SignupPage />);
    const btn = screen.getByRole("button", { name: "Create account" });
    expect(btn).toBeEnabled();
    expect(btn.className).toContain("rf-btn");
    expect(container.querySelector(".rf-auth")?.contains(btn)).toBe(true);
  });
});
