/**
 * #2653 / SA-542a Q3 — is this page running inside the RouteFlow hybrid app shell?
 *
 * The native WebView appends the UA token "RouteFlowShell/<version>". SHELL_MARK_SCRIPT runs in
 * <head> before first paint (app/layout.tsx) and marks <html data-shell="1">, so the CSS in
 * app/shell.css hides every [data-google-signin] block with no flash: TestFlight builds must not
 * show Google sign-in in the shell (SA-542 Q3). The script is built from the SAME pattern
 * isShellUserAgent uses (@routeflow/ui/shell-bridge) — one source. It is this app's own static
 * script, not anything the native side injects.
 */
import { SHELL_UA_PATTERN } from "@routeflow/ui/shell-bridge";

/** The attribute the head script sets on <html>. */
export const SHELL_ATTR = "data-shell";

export const SHELL_MARK_SCRIPT = `(function(){try{if(new RegExp(${JSON.stringify(
  SHELL_UA_PATTERN,
)}).test(navigator.userAgent)){document.documentElement.setAttribute(${JSON.stringify(
  SHELL_ATTR,
)},"1")}}catch(e){}})();`;

/**
 * True inside the shell. Reads the mark the head script left on <html> (false during SSR).
 * Google handlers call it at click time as a second guard behind the CSS hide.
 */
export function isInShell(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute(SHELL_ATTR) === "1";
}
