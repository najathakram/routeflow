/**
 * Persist an in-progress stock count session to localStorage so it survives
 * a tab close / refresh. The session is cleared explicitly after a successful
 * commit.
 *
 * Key shape: `rf-stock-count-{tenantSlug}-v1` — tenant-scoped to avoid
 * cross-tenant leakage when a super-admin impersonates between tenants.
 */

export type StockCountMode = "REPLACE" | "ADD";

export interface StockCountRow {
  /** Stable client-side id; not the productId. Lets us key React lists. */
  rowId: string;
  productId: string;
  name: string;
  sku?: string | null;
  unit: string;
  /** Snapshot taken at scan-time, used for the UI delta preview only.
   *  The server recomputes the delta against live currentStock at commit. */
  currentStockSnapshot: number;
  scannedQty: number;
  mode: StockCountMode;
}

export interface StockCountSession {
  sessionId: string;
  startedAt: string;
  defaultMode: StockCountMode;
  qtyPerScan: number;
  rows: StockCountRow[];
}

const KEY_PREFIX = "rf-stock-count-";
const KEY_SUFFIX = "-v1";

function isBrowser() {
  return typeof window !== "undefined";
}

export function getStorageKey(tenantSlug: string | null | undefined): string {
  return `${KEY_PREFIX}${tenantSlug ?? "default"}${KEY_SUFFIX}`;
}

export function loadSession(tenantSlug: string | null | undefined): StockCountSession | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(getStorageKey(tenantSlug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StockCountSession;
    if (!parsed?.sessionId || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(
  tenantSlug: string | null | undefined,
  session: StockCountSession,
): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(getStorageKey(tenantSlug), JSON.stringify(session));
  } catch {
    // Quota exceeded or storage unavailable — fail silently; the user can
    // still submit what's on screen.
  }
}

export function clearSession(tenantSlug: string | null | undefined): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(getStorageKey(tenantSlug));
  } catch {
    // ignore
  }
}

/** Browsers don't expose a sync uuid generator everywhere; this is fine for
 *  a client-side session id and stable row ids. */
export function makeId(): string {
  if (isBrowser() && typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
