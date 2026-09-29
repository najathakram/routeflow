/**
 * #2653 / SA-542 — the native side of the shell bridge, as a pure decision: a raw postMessage
 * from the page → exactly one action. No RN imports; Jest-pinned. The WebShell screen performs
 * the action (open the scanner, register push, sign out, post a reply).
 *
 * Order matters: the ORIGIN of the page that sent it (RN exposes no postMessage origin, so
 * `nativeEvent.url` is checked against the shell's allowlist) comes first, then the schema. A
 * message failing either is dropped — never answered, so a foreign page learns nothing.
 */
import {
  parseWebToNative,
  type NativeToWebMessage,
  type ShellCapabilities,
} from "@routeflow/ui/shell-bridge";
import { classifyNavigation } from "./url-policy";

export interface BridgeContext {
  /** Origins the shell may load (url-policy allowedOrigins). */
  allowed: readonly string[];
  /** A native STAFF session exists — push is registered with the app's own JWT (SA-542). */
  hasStaffSession: boolean;
  /** The device can open the native scanner (camera module present). */
  scanAvailable: boolean;
  /** Mints the id of an outgoing native message. */
  newId: () => string;
}

export type BridgeAction =
  | { kind: "drop" }
  | { kind: "reply"; message: NativeToWebMessage }
  | { kind: "scan"; replyTo: string }
  | { kind: "push"; replyTo: string }
  | { kind: "logout" };

export function capabilitiesFor(
  ctx: Pick<BridgeContext, "hasStaffSession" | "scanAvailable">,
): ShellCapabilities {
  // handoff stays false until N-kit's POST /auth/handoff + web page land (#2653 Q1).
  return { scan: ctx.scanAvailable, push: ctx.hasStaffSession, handoff: false };
}

export function handleBridgeMessage(
  raw: unknown,
  sourceUrl: string | undefined,
  ctx: BridgeContext,
): BridgeAction {
  if (!sourceUrl || classifyNavigation(sourceUrl, ctx.allowed) !== "load") return { kind: "drop" };
  const msg = parseWebToNative(raw);
  if (!msg) return { kind: "drop" };

  switch (msg.type) {
    case "shell.hello":
      return {
        kind: "reply",
        message: {
          v: 1,
          id: ctx.newId(),
          type: "shell.ready",
          payload: { replyTo: msg.id, capabilities: capabilitiesFor(ctx) },
        },
      };
    case "scan.request":
      return ctx.scanAvailable
        ? { kind: "scan", replyTo: msg.id }
        : {
            kind: "reply",
            message: {
              v: 1,
              id: ctx.newId(),
              type: "scan.cancelled",
              payload: { replyTo: msg.id },
            },
          };
    case "push.register":
      return ctx.hasStaffSession
        ? { kind: "push", replyTo: msg.id }
        : {
            kind: "reply",
            message: {
              v: 1,
              id: ctx.newId(),
              type: "push.result",
              payload: { replyTo: msg.id, registered: false },
            },
          };
    case "auth.logout":
      return { kind: "logout" };
    case "auth.handoff":
      // Reserved until the handoff exists; capabilities.handoff is false, so a page never sends it.
      return { kind: "drop" };
  }
}
