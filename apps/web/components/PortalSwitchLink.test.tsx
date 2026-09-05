import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { renderToString } from "react-dom/server";

/**
 * T13, T14, T15 (spec R6, R7, R8, R12): the shared PortalSwitchLink anchor.
 * The component and its `to`/`labels` props do not exist yet — the guarded
 * load below falls back to a component that renders null, so the import
 * itself never throws and every test fails on its own assertion
 * (`queryByRole("link")` is `null` / the SSR string is empty), never on a
 * module-resolution error.
 */

function load<T>(path: string): Partial<T> {
  try {
    return require(path);
  } catch (e) {
    // ONLY a genuinely-absent module falls back to `{}`. A syntax error or an
    // import-time throw inside the real component must surface as itself, not
    // as another `Received: null` that looks identical to "not written yet".
    if ((e as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw e;
    return {};
  }
}

interface PortalSwitchLinkProps {
  to: "buyer" | "op";
  labels?: { switch: string; signIn: string };
}

const PortalSwitchLink = (load<{ PortalSwitchLink: React.ComponentType<PortalSwitchLinkProps> }>(
  "./PortalSwitchLink",
).PortalSwitchLink ?? (() => null)) as React.ComponentType<PortalSwitchLinkProps>;

function clearCookies(): void {
  for (const name of ["rf-op-auth", "rf-buyer-auth", "rf-last-portal"]) {
    document.cookie = `${name}=; path=/; max-age=0`;
  }
}

describe("PortalSwitchLink (T13, T14, T15, R6, R7, R8, R12)", () => {
  beforeEach(() => {
    clearCookies();
  });

  describe("T13: presence-aware switch variant", () => {
    it("to='buyer' with rf-buyer-auth=1 renders 'Switch to buyer portal' -> /buyer/portal", () => {
      document.cookie = "rf-buyer-auth=1; path=/";
      renderWithProviders(<PortalSwitchLink to="buyer" />);

      const link = screen.queryByRole("link", { name: "Switch to buyer portal" });
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("href", "/buyer/portal");
    });

    it("to='op' with rf-op-auth=1 renders 'Switch to seller dashboard' -> /dashboard", () => {
      document.cookie = "rf-op-auth=1; path=/";
      renderWithProviders(<PortalSwitchLink to="op" />);

      const link = screen.queryByRole("link", { name: "Switch to seller dashboard" });
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("href", "/dashboard");
    });
  });

  describe("T14: sign-in variant when the target portal has no presence", () => {
    it("to='buyer' with no cookies renders 'Buyer portal sign-in' -> /buyer/login", () => {
      renderWithProviders(<PortalSwitchLink to="buyer" />);

      const link = screen.queryByRole("link", { name: "Buyer portal sign-in" });
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("href", "/buyer/login");
    });

    it("to='op' with no cookies renders 'Seller dashboard sign-in' -> /login", () => {
      renderWithProviders(<PortalSwitchLink to="op" />);

      const link = screen.queryByRole("link", { name: "Seller dashboard sign-in" });
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("href", "/login");
    });

    it("the labels prop overrides the sign-in text", () => {
      renderWithProviders(<PortalSwitchLink to="buyer" labels={{ switch: "X", signIn: "Y" }} />);

      // Asserted through the LINK, not bare text: `queryByText(...).toBeNull()`
      // alone also holds for a component that renders nothing at all.
      const link = screen.queryByRole("link", { name: "Y" });
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("href", "/buyer/login");
      expect(screen.queryByText("Buyer portal sign-in")).toBeNull();
    });
  });

  describe("T15 (R8, negative): server render ignores cookies", () => {
    it("renderToString with rf-buyer-auth=1 still renders the sign-in variant", () => {
      document.cookie = "rf-buyer-auth=1; path=/";

      const html = renderToString(<PortalSwitchLink to="buyer" />);

      expect(html).toContain("Buyer portal sign-in");
      // The full attribute, not the bare path — a bare "/buyer/login" substring
      // would also be satisfied by the string appearing anywhere in the markup.
      expect(html).toContain('href="/buyer/login"');
      expect(html).not.toContain("Switch to buyer portal");
    });
  });
});
