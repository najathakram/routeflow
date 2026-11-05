/**
 * @jest-environment node
 */
// Site audit 2026-11-02: /login, /signup and /forgot-password were indexable and all carried the
// bare title "RouteFlow". They are forms, not pages to find, so each says noindex and has its own
// title. The pages are client components, so the metadata lives in a layout beside each one.
import { metadata as login } from "./login/layout";
import { metadata as signup } from "./signup/layout";
import { metadata as forgot } from "./forgot-password/layout";

describe("sign-in pages are not indexed and have their own titles (audit 2026-11-02)", () => {
  it.each([
    ["/login", login, "Sign in"],
    ["/signup", signup, "Start your free trial"],
    ["/forgot-password", forgot, "Reset your password"],
  ])("%s: noindex and a real title", (_path, meta, title) => {
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.title).toBe(title);
  });
});
