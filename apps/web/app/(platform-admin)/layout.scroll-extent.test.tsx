import * as React from "react";
import { render, screen } from "@testing-library/react";
import PlatformAdminLayout from "./layout";

/**
 * BO-01: every admin page scrolled past its end into a blank band. The FeatureConsole's sr-only spans
 * are `position: absolute`; with no positioned ancestor their containing block was the viewport, so
 * they extended the document's scroll area. `<main>` is now positioned (Tailwind `relative`), so it
 * contains them. The layout proof (scrollHeight at 1440/768/390) is e2e/bo-web-scroll.spec.ts.
 */
jest.mock("next/navigation", () => ({
  usePathname: () => "/admin/tenants",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

beforeEach(() => {
  localStorage.setItem(
    "superAdminToken",
    `${b64({ alg: "none" })}.${b64({ role: "SUPER_ADMIN", exp: Date.now() / 1000 + 3600 })}.x`,
  );
});

it("the admin <main> is the positioned containing block of the page's sr-only spans", async () => {
  render(
    <PlatformAdminLayout>
      <span className="sr-only">On</span>
    </PlatformAdminLayout>,
  );
  const span = await screen.findByText("On");
  const main = span.closest("main") as HTMLElement;
  expect(main).not.toBeNull();
  // the nearest ancestor with a positioning class is <main> itself, not the viewport
  let el: HTMLElement | null = span.parentElement;
  while (el && !/\b(relative|absolute|fixed|sticky)\b/.test(el.className)) el = el.parentElement;
  expect(el).toBe(main);
  // and main still scrolls its own content
  expect(main).toHaveClass("overflow-y-auto");
});
