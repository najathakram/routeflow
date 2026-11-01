/**
 * The last Workspace ID a person signed in with, kept on this device (W2 B3, COPY.md 2k and 2l).
 *
 * Sign-in asks for the Workspace ID typed, and a person who signed out has to remember it. The tenant
 * cookie cannot carry it: `endStaffSession` clears that cookie on purpose. So this is a separate stored
 * value that sign-out leaves alone. It holds a Workspace ID only, never a name, email or token.
 */

const KEY = "rf-last-workspace";

// Same rule the sign-in form checks (login/page.tsx WORKSPACE_RE): lowercase letters, digits, hyphens.
const WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** True when the text has the shape of a Workspace ID; anything else is never shown or stored as one. */
export function isWorkspaceId(text: string): boolean {
  return WORKSPACE_ID.test(text);
}

export function rememberLastWorkspace(slug: string): void {
  if (typeof window === "undefined" || !isWorkspaceId(slug)) return;
  try {
    window.localStorage.setItem(KEY, slug);
  } catch {
    // Storage blocked or full: sign-in works without the shortcut.
  }
}

export function readLastWorkspace(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(KEY);
    return value && isWorkspaceId(value) ? value : null;
  } catch {
    return null;
  }
}
