/**
 * #2653 (SA-542a/b): the in-app sign-in handoff's shared contract — imported by BOTH the native
 * shell (apps/mobile, which builds the fragment) and the web /handoff page (which parses it).
 * Plain TS, no dependencies. The native shell loads
 *
 *   /handoff#code=<one-time code>&realm=staff|buyer[&seller=<slug>]
 *
 * (HANDOFF_ENTRY_PATH + buildHandoffFragment, shared with the shell). The code rides ONLY in the
 * FRAGMENT, which browsers never send to a server or put in a Referer; a `?code=` query string is
 * refused. The page strips the hash with replaceState BEFORE its first await, exchanges the code
 * at its realm's endpoint, adopts the FRESH pair with the realm's one adopter, and leaves.
 */

export const HANDOFF_ENTRY_PATH = "/handoff";
export type HandoffWebRealm = "staff" | "buyer";

/** Where the native app mints a code, with its own JWT. */
export const HANDOFF_MINT_PATH: Record<HandoffWebRealm, string> = {
  staff: "/auth/handoff",
  buyer: "/buyer/auth/handoff",
};

/** The deviceId the mint endpoints accept (recorded as deviceName "hybrid-shell:<deviceId>"). */
export const HANDOFF_DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Where the web page exchanges it for a fresh pair. */
export const HANDOFF_EXCHANGE_PATH: Record<HandoffWebRealm, string> = {
  staff: "/auth/handoff/exchange",
  buyer: "/buyer/auth/handoff/exchange",
};

/** What the shell appends after "#": the one format both sides build and parse. */
export function buildHandoffFragment(p: { code: string; realm: HandoffWebRealm; seller?: string }) {
  const q = new URLSearchParams({ code: p.code, realm: p.realm });
  if (p.seller) q.set("seller", p.seller);
  return q.toString();
}

export type ParsedHandoff =
  | { ok: true; code: string; realm: HandoffWebRealm; seller: string | null }
  | { ok: false; reason: "missing" | "query-refused" | "bad-realm" };

const SELLER_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseHandoffLocation(hash: string, search: string): ParsedHandoff {
  // A code in the query string has already been sent to a server (logs, Referer). Refuse it
  // outright, even if the fragment also carries one.
  if (new URLSearchParams(search).has("code")) return { ok: false, reason: "query-refused" };
  const f = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const code = f.get("code");
  if (!code) return { ok: false, reason: "missing" };
  const realm = f.get("realm");
  if (realm !== "staff" && realm !== "buyer") return { ok: false, reason: "bad-realm" };
  const seller = f.get("seller");
  return { ok: true, code, realm, seller: seller && SELLER_SLUG.test(seller) ? seller : null };
}
