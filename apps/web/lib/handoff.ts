/**
 * #2653 (SA-542a/b): the web /handoff page's logic, kept free of React/window so it is testable.
 * The fragment contract (path, build, parse) is shared with the native shell in
 * @routeflow/ui/shell-handoff. The page strips the hash with replaceState BEFORE its first await,
 * exchanges the code at its realm's endpoint, adopts the FRESH pair with the realm's one adopter,
 * and leaves.
 */
import { HANDOFF_EXCHANGE_PATH, parseHandoffLocation } from "@routeflow/ui/shell-handoff";

export interface HandoffDeps {
  location: { hash: string; search: string; pathname: string; assign(url: string): void };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  apiUrl: string;
  post: (
    url: string,
    body: unknown,
  ) => Promise<
    { realm: string; accessToken: string; refreshToken: string } & Record<string, unknown>
  >;
  adoptTokenPair: (data: never) => void;
  adoptBuyerTokenPair: (data: never) => void;
}

export type HandoffOutcome = { ok: true; to: string } | { ok: false; reason: string };

/** Run the whole handoff. Never throws; a failure returns a reason for the fallback screen. */
export async function runHandoff(d: HandoffDeps): Promise<HandoffOutcome> {
  const parsed = parseHandoffLocation(d.location.hash, d.location.search);
  // Strip the fragment (and any query) BEFORE the first await, so the code never lingers in the
  // address bar, history or a crash report.
  d.history.replaceState(null, "", d.location.pathname);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  let data: Awaited<ReturnType<HandoffDeps["post"]>>;
  try {
    data = await d.post(`${d.apiUrl}${HANDOFF_EXCHANGE_PATH[parsed.realm]}`, { code: parsed.code });
  } catch {
    return { ok: false, reason: "exchange-refused" };
  }
  if (data.realm !== parsed.realm.toUpperCase()) return { ok: false, reason: "realm-mismatch" };
  if (parsed.realm === "staff") {
    d.adoptTokenPair(data as never);
    d.location.assign("/");
    return { ok: true, to: "/" };
  }
  d.adoptBuyerTokenPair(data as never);
  const to = parsed.seller ? `/buyer/portal/${parsed.seller}/dashboard` : "/buyer/portal";
  d.location.assign(to);
  return { ok: true, to };
}
