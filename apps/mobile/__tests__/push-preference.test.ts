/**
 * B04 (train 2, cause-ruling.md §2/§3, D2) — `push-preference.test.ts`
 *
 * The operator Settings → Push notifications switch used to be local-only
 * state (`(operator)/settings/index.tsx`) — toggling it off never told the
 * server anything, and the next `login()` (`lib/auth.ts`) re-registered the
 * device unconditionally, undoing it. The fix binds the switch to the
 * `pushEnabled` UserPreference via `lib/notification-prefs.ts`, and gates
 * login's push-token registration on the same preference.
 *
 * Source-text spec in the style of `edit-items-scan-fab.test.ts`: nothing
 * renders under mobile Jest, so this reads the two screens as text and pins
 * pattern presence, never a rendered tree. Paths resolve from `__dirname`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SETTINGS_PATH = join(__dirname, "..", "app", "(operator)", "settings", "index.tsx");
const AUTH_PATH = join(__dirname, "..", "lib", "auth.ts");

const settingsSource = readFileSync(SETTINGS_PATH, "utf8");
const authSource = readFileSync(AUTH_PATH, "utf8");

describe("push notification preference (B04)", () => {
  it("REG-B04-A the settings switch reads/writes the pushEnabled preference", () => {
    // Must bind through the shared preference module, not local-only state.
    expect(settingsSource).toMatch(/notification-prefs/);
    expect(settingsSource).toMatch(/getPushEnabled/);
    expect(settingsSource).toMatch(/setPushEnabled/);
    // Amended (Fable train-2 fix round, item 3): the switch now defaults ON
    // (`useState(true)`) while the preference loads/fails, matching the
    // server's opt-out semantics — a `useState(false)` placeholder is the
    // pre-fix "silently OFF until the fetch resolves" bug.
    expect(settingsSource).not.toMatch(/useState\(false\)/);
    // Toggling must (de)register this device immediately, not just persist
    // the flag and wait for the next login.
    expect(settingsSource).toMatch(/registerPushToken/);
    expect(settingsSource).toMatch(/deregisterPushToken/);
  });

  it("REG-B04-B login registration is gated by the preference", () => {
    // Either registerPushToken() itself consults the preference, or login()
    // does before calling it — either way the source must reference the
    // preference module around the registration call, not call it
    // unconditionally the way the pre-fix code did.
    expect(authSource).toMatch(/notification-prefs|getPushEnabled/);

    const registerFnMatch = authSource.match(/async function registerPushToken\(\)[\s\S]*?\n}/);
    const registerFnBody = registerFnMatch ? registerFnMatch[0] : "";
    expect(registerFnBody).toMatch(/getPushEnabled/);
  });

  it("REG-B04-B extended: a preference-fetch rejection still lets registration through (fails OPEN)", () => {
    // A user with the preference genuinely enabled must not be silently
    // skipped just because the read (SecureStore/AsyncStorage) errored —
    // `getPushEnabled()` is awaited with a `.catch(() => true)` fallback,
    // not a bare `await getPushEnabled()` that would throw/return falsy and
    // short-circuit the `if (!(...)) return;` gate into a skip.
    const registerFnMatch = authSource.match(/async function registerPushToken\(\)[\s\S]*?\n}/);
    const registerFnBody = registerFnMatch ? registerFnMatch[0] : "";
    expect(registerFnBody).toMatch(/getPushEnabled\(\)\.catch\(\(\)\s*=>\s*true\)/);
  });
});
