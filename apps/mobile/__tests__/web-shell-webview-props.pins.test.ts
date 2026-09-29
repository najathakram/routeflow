/**
 * #2653 — PIN the WebShell's WebView props. Source-text pin (the RN screen can't render under
 * the mobile Jest env), same convention as the other *.pins tests.
 * - Sim proof F2: without inline playback the barcode scanner's camera video goes fullscreen and
 *   stalls, so inline playback is on and media never waits for a user gesture.
 * - SA-542: no file access, no popup windows, UA marker set — these must never be dropped.
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "..", "app", "(shell)", "web.tsx"), "utf8");

describe("pin: WebShell WebView props (#2653)", () => {
  it.each([
    ["inline media playback (F2)", /\ballowsInlineMediaPlayback\b(?!=\{false\})/],
    ["media without a user gesture (F2)", /\bmediaPlaybackRequiresUserAction=\{false\}/],
    ["no file access", /\ballowFileAccess=\{false\}/],
    ["no file-URL access", /\ballowFileAccessFromFileURLs=\{false\}/],
    ["no universal file-URL access", /\ballowUniversalAccessFromFileURLs=\{false\}/],
    ["no multiple windows", /\bsetSupportMultipleWindows=\{false\}/],
    ["no script-opened windows", /\bjavaScriptCanOpenWindowsAutomatically=\{false\}/],
    ["the navigation allowlist", /\bonShouldStartLoadWithRequest=\{onShouldStart\}/],
    ["the shell UA marker", /\bapplicationNameForUserAgent=\{SHELL_UA\}/],
  ])("keeps %s", (_label, re) => {
    expect(src).toMatch(re);
  });
});
