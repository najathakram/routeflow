/**
 * #1508 (B01) — PIN: the staff login screen has no "Remember me" control.
 *
 * The checkbox only toggled its own checkmark; login() never read it, and the
 * session is ALWAYS persisted (tokens in SecureStore, restored on launch).
 * Web — the golden reference — has no remember-me at all and keeps the session
 * the same way, so the control is removed rather than wired: a control that
 * promises a choice the app does not offer is the defect. Source-text pin (the
 * RN screen can't be rendered under the mobile Jest env), same convention as
 * `buyer-line-note.pins.test.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const LOGIN_PATH = join(__dirname, "..", "app", "(auth)", "login.tsx");

describe("pin: staff login has no decorative Remember me (B01)", () => {
  const src = readFileSync(LOGIN_PATH, "utf8");

  it("renders no Remember me control and keeps no rememberMe state", () => {
    expect(src).not.toMatch(/Remember me/i);
    expect(src).not.toMatch(/rememberMe|setRememberMe/);
  });

  it("still signs in with username + password only (no password is persisted)", () => {
    expect(src).toMatch(/await login\(data\.username, data\.password\)/);
  });
});
