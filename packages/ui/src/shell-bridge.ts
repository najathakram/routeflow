/**
 * #2653 / SA-542 — the hybrid shell's postMessage bridge: the ONE versioned, zod-validated message
 * schema shared by the web (inside the WebView) and the native shell. Lives in @routeflow/ui (web +
 * mobile only) rather than @routeflow/types, which stays dependency-free because the API imports it.
 *
 * Envelope `{ v: 1, id, type, payload }`. Every payload is `.strict()`: a message carrying ANY
 * extra field (a token, a code, a URL) fails validation and is dropped — SA-542 refuses tokens or
 * codes over the bridge, link.open / navigate requests, and injecting page data. Unknown `type`s
 * and wrong-direction messages are dropped too. Never trust a message the parser did not return.
 */
import { z } from "zod";

export const SHELL_BRIDGE_VERSION = 1 as const;

/**
 * SA-542a: the shell marker is a user-agent product token, "RouteFlowShell/<version>", set by the
 * native WebView (applicationNameForUserAgent). It rides on the page's very FIRST request, so the
 * web can decide before paint (hide Google sign-in, Q3) — fail-closed and flash-free. The web must
 * test it with isShellUserAgent, never its own string match.
 */
export const SHELL_UA_PRODUCT = "RouteFlowShell";

export function shellUserAgentToken(appVersion: string): string {
  const v = /^[0-9A-Za-z.+-]{1,32}$/.test(appVersion) ? appVersion : "0";
  return `${SHELL_UA_PRODUCT}/${v}`;
}

/**
 * The UA test as a RegExp SOURCE string, so the web's pre-paint head script (a plain inline
 * script, no imports) is built from the SAME pattern isShellUserAgent uses — one source.
 */
export const SHELL_UA_PATTERN = String.raw`(^|\s)RouteFlowShell\/[0-9A-Za-z.+-]+(\s|$)`;

export function isShellUserAgent(userAgent: string | null | undefined): boolean {
  return !!userAgent && new RegExp(SHELL_UA_PATTERN).test(userAgent);
}
/** A raw message larger than this is dropped before JSON.parse. */
export const SHELL_BRIDGE_MAX_BYTES = 4096;

const empty = z.object({}).strict();
const id = z.string().min(1).max(64);

const envelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ v: z.literal(SHELL_BRIDGE_VERSION), id, type: z.literal(type), payload }).strict();

/** web → native: what the page may ask the shell for (SA-542 allowed list). */
export const webToNativeSchema = z.discriminatedUnion("type", [
  envelope("shell.hello", empty),
  envelope("scan.request", empty),
  envelope("push.register", empty),
  envelope("auth.logout", empty),
  // Reserved for the sign-in handoff (#2653 Q1, N-kit): a retry of the handoff. No code rides here.
  envelope("auth.handoff", empty),
]);

export const shellCapabilitiesSchema = z
  .object({ scan: z.boolean(), push: z.boolean(), handoff: z.boolean() })
  .strict();

/** native → web: the shell's answers. `replyTo` is the id of the request being answered. */
export const nativeToWebSchema = z.discriminatedUnion("type", [
  envelope(
    "shell.ready",
    z.object({ replyTo: id, capabilities: shellCapabilitiesSchema }).strict(),
  ),
  envelope("scan.result", z.object({ replyTo: id, code: z.string().min(1).max(256) }).strict()),
  envelope("scan.cancelled", z.object({ replyTo: id }).strict()),
  envelope("push.result", z.object({ replyTo: id, registered: z.boolean() }).strict()),
]);

export type WebToNativeMessage = z.infer<typeof webToNativeSchema>;
export type NativeToWebMessage = z.infer<typeof nativeToWebSchema>;
export type ShellCapabilities = z.infer<typeof shellCapabilitiesSchema>;

function parseWith<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > SHELL_BRIDGE_MAX_BYTES) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = schema.safeParse(data);
  return res.success ? res.data : null;
}

/** The native side's parser for a page's postMessage string. null ⇒ drop it. */
export function parseWebToNative(raw: unknown): WebToNativeMessage | null {
  return parseWith(webToNativeSchema, raw);
}

/** The page's parser for a message the shell sent. null ⇒ drop it. */
export function parseNativeToWeb(raw: unknown): NativeToWebMessage | null {
  return parseWith(nativeToWebSchema, raw);
}

/** Serialise an outgoing message; throws on a shape the schema would refuse (a programming error). */
export function encodeNativeToWeb(msg: NativeToWebMessage): string {
  return JSON.stringify(nativeToWebSchema.parse(msg));
}

export function encodeWebToNative(msg: WebToNativeMessage): string {
  return JSON.stringify(webToNativeSchema.parse(msg));
}
