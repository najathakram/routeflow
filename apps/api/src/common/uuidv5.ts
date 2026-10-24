import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 4122 name-based (SHA-1) UUID, version 5: the same `name` in the same `namespace` always yields the
 * same id. Local so the API takes no new dependency. Used for the server-built `paymentGroupId` of a
 * split counter tender leg (never client-supplied).
 */
export function uuidv5(name: string, namespace: string): string {
  if (!UUID_RE.test(namespace)) throw new Error(`uuidv5: namespace is not a UUID (${namespace})`);
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const bytes = createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
