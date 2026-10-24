// ─── Counter sale QUICK KEYS (SA-747 + SA-747r) — the web screen <-> API contract ─────────────────
//
// GET /orders/counter-sale/quick-keys?register=<key> answers the grid for one register; the pins and hides are stored in the
// tenant settings (`SystemConfig` key `settings.quickKeys`, a JSON string) and written through PATCH /settings. The server
// (OrdersModule counter-sale/ + SettingsController) and the web screen both import this one file; never keep a second copy.
// SA-747r: each key carries the SAME product object the counter scan lookup returns (`GET /products/barcode/:code`: the full
// product row with its active variants and tenant-safe parent, without `scanMatch`), built for the whole grid in ONE query. The
// GRID never decides a price: the screen adds it through the scan add path and `reprice.tierFor` sets the customer's price.

// The default register and the register-key pattern are shared with every other counter feature: `COUNTER_DEFAULT_REGISTER`
// and `REGISTER_KEY_PATTERN` in @routeflow/pricing (counter-register.ts).

/** Look-back window for the ranking, in days, when the settings set none. */
export const QUICK_KEYS_DEFAULT_WINDOW_DAYS = 30;
/** Keys shown when the settings set no cap. */
export const QUICK_KEYS_DEFAULT_CAP = 12;
/** The hard maximum for `cap` (and so for the pins): one named constant, enforced by PATCH /settings. */
export const QUICK_KEYS_MAX_CAP = 24;
/** At most this many hidden products per register. */
export const QUICK_KEYS_MAX_HIDDEN = 100;
/** The ranking asks the database for this many products; the grid takes pinned + the top of these. */
export const QUICK_KEYS_RANK_TAKE = 40;
/** The ranking cache lives this long per (tenant, register); pins are always read live. */
export const QUICK_KEYS_RANK_TTL_MS = 60 * 60 * 1000;
/** Longest look-back the settings accept. */
export const QUICK_KEYS_MAX_WINDOW_DAYS = 365;

/** The packaging level a tap adds at, the same two values as `SellLevel` in @routeflow/pricing (pinned by a parity spec). */
export const QUICK_KEY_SELL_LEVEL_VALUES = ["BOX", "UNIT"] as const;
export type QuickKeySellLevel = (typeof QUICK_KEY_SELL_LEVEL_VALUES)[number];

/** One register's pins (in pin order) and hides, both lists of product ids. */
export interface QuickKeysRegisterSettings {
  pinned: string[];
  hidden: string[];
}

export interface QuickKeysCounterSettings {
  default: QuickKeysRegisterSettings;
  /** v1 writes `registers.main` -> `default`; a later release gives each register its own list. */
  registers?: Record<string, QuickKeysRegisterSettings>;
  /** default {@link QUICK_KEYS_DEFAULT_WINDOW_DAYS} */
  windowDays?: number;
  /** default {@link QUICK_KEYS_DEFAULT_CAP}, at most {@link QUICK_KEYS_MAX_CAP} */
  cap?: number;
}

/** The `quickKeys` value in PATCH /settings (and in the GET /settings response). */
export interface QuickKeysSettings {
  counter: QuickKeysCounterSettings;
}

/** One key in the grid. */
export interface QuickKey {
  productId: string;
  name: string;
  /** BOX when the product has unitsPerBox > 1, else UNIT (the scan default level). */
  sellLevel: QuickKeySellLevel;
  /** a signed image URL when the product has a picture */
  imageUrl?: string;
  /** true when the operator pinned it (shown first, in pin order) */
  pinned: boolean;
  /**
   * The product exactly as the scan lookup returns it (minus `scanMatch`): what `addScannedProduct` consumes. Built by the
   * same read as the scan (same include), never a second product shape.
   */
  product: Record<string, unknown> & { id: string };
}

export interface QuickKeysResponse {
  /** the register the answer is for (an unknown request register is answered as the default) */
  register: string;
  keys: QuickKey[];
  /** the cap in force, so the screen can say "12 of 12 pinned" */
  cap: number;
}
