// ─── Counter sale PARK / RESUME (SA-748 / 748r / 748r2) — the web screen <-> API contract ───────────────────────────
//
// A clerk sets the live cart aside ("parks" it) to serve the next customer and takes it back later. The parked cart is a
// SERVER row (`CounterParkedCart`), so another till or a refresh sees it. Routes (OPERATOR, tenant-scoped, all refused
// with COUNTER_SALES_DISABLED when the tenant has counter sales off):
//   POST   /orders/counter-sale/parked              park the cart (idempotent on the client-minted `id`)
//   GET    /orders/counter-sale/parked?register=&page=   the open parked carts, newest first
//   POST   /orders/counter-sale/parked/:id/resume   take it back (a compare-and-set: exactly one caller wins)
//   DELETE /orders/counter-sale/parked/:id          discard it
// No stock is reserved and no price is frozen: a resumed cart is re-priced for display, and the Idempotency-Key of the sale
// is minted only at Complete. The server REBUILDS every payload from a whitelist (`sanitizeParkedPayload`) and drops all
// unknown keys; the customer is never stored with an email. The server and the web screen import this one file.
//
// It lives in @routeflow/pricing (a built package) and NOT in @routeflow/types, because the API never value-imports
// @routeflow/types (L-261: that package is raw TypeScript and `nest build` does not bundle it). The error codes
// PARK_LIMIT / PARK_TAKEN are in @routeflow/types; the API carries literals of them, pinned by a parity spec.

// The default register and the register-key pattern are `COUNTER_DEFAULT_REGISTER` and `REGISTER_KEY_PATTERN` in
// ./counter-register (the one source for every register-keyed counter feature).

/** A parked cart expires this many hours after it was parked. */
export const COUNTER_PARK_TTL_HOURS = 24;
/** At most this many open parked carts per (tenant, register): the 11th is 409 PARK_LIMIT. */
export const COUNTER_PARK_MAX_PER_REGISTER = 10;
/**
 * At most this many open parked carts per TENANT, across every register. The per-register cap alone is not a bound while a
 * register key is free-form (and once several registers ship, 10 x registers is): this makes the stored volume
 * (50 x {@link COUNTER_PARK_MAX_BYTES} = 3.2 MB per tenant) a class bound that holds however many registers there are. Both caps
 * are checked under ONE advisory lock keyed by the tenant.
 */
export const COUNTER_PARK_MAX_PER_TENANT = 50;

/** Which cap a 409 PARK_LIMIT refers to (`scope` in the error body), so the screen can word it. */
export type ParkLimitScope = "register" | "tenant";

/** A parked cart holds at most this many lines. */
export const COUNTER_PARK_MAX_LINES = 200;
/** The rebuilt payload may be at most this many bytes of JSON. */
export const COUNTER_PARK_MAX_BYTES = 64 * 1024;
/** Longest label. */
export const COUNTER_PARK_LABEL_MAX = 60;
/**
 * The RESUME retry window (5 min): a resume that carries the SAME `resumeAttemptId` as the one that took the row may read it
 * again inside this window (a lost response must not lose the cart). Keyed on the attempt id, never on the actor: a second
 * till on the same login is a different attempt and gets 404 PARK_TAKEN.
 */
export const COUNTER_PARK_RETRY_WINDOW_MS = 5 * 60 * 1000;

/**
 * SERVER-RESERVED payload key. The resume compare-and-set stores `{ attemptId }` under it in the row's own JSON (atomically,
 * in the same statement that marks the row taken). It is NOT part of {@link ParkedCartPayload} (the client shape): the
 * whitelist rebuild never copies it, so it is absent from every response, and a park whose payload carries it is refused
 * with 400 ({@link hasReservedParkKey}).
 */
export const PARKED_PAYLOAD_RESUME_KEY = "_resume";

/** True when a client-sent park payload names the server-reserved key (own property, whatever its value). */
export function hasReservedParkKey(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    Object.prototype.hasOwnProperty.call(raw, PARKED_PAYLOAD_RESUME_KEY)
  );
}
/** The sweep deletes a RESUMED row after this many hours (the retry window is long past by then). */
export const COUNTER_PARK_SWEEP_RESUMED_HOURS = 24;
/** The list shows "from earlier - prices refresh when you pay" for a cart parked more than this many hours ago. */
export const COUNTER_PARK_STALE_HOURS = 12;
export const COUNTER_PARK_PAGE_SIZE = 20;
export const COUNTER_PARK_MAX_PAGE_SIZE = 50;

/** The note / reason / name limits the payload rebuild applies. */
export const COUNTER_PARK_NOTE_MAX = 200;
export const COUNTER_PARK_NAME_MAX = 200;
export const COUNTER_PARK_REASON_MAX = 500;

// ─── Payload (the live-cart snapshot) ────────────────────────────────────────────────────────────────────────────────

export type ParkedPriceEditMode = "set" | "percent" | "amount";
export const PARKED_PRICE_EDIT_MODES: readonly ParkedPriceEditMode[] = ["set", "percent", "amount"];

export interface ParkedCartLine {
  tempId: string;
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  note?: string;
  listPrice?: number;
  unit?: string;
  priceType?: "STANDARD" | "SPECIAL";
  category?: string;
  tierPrices?: {
    pricePerUnit?: number | string | null;
    priceTier2?: number | string | null;
    priceTier3?: number | string | null;
    priceTier4?: number | string | null;
    priceTier5?: number | string | null;
  };
  priceEdited?: boolean;
  tierPrice?: number;
  override?: { mode: ParkedPriceEditMode; value: number; reason?: string };
}

/** The customer is kept to these four fields; an email is NEVER stored. */
export interface ParkedCartCustomer {
  id: string;
  businessName: string;
  pricingTier?: number;
  fulfillPath?: string;
}

export interface ParkedCartPayload {
  lines: ParkedCartLine[];
  customer: ParkedCartCustomer | null;
  method: string;
  tendered: string;
  reference: string;
}

// ─── Moved from the web: the shape checks the held-attempt snapshot and the live cart already use ───────────────────

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const optNum = (n: unknown): boolean => n === undefined || isNum(n);

/** A cart line has the fields a sale needs. (Moved from apps/web/lib/counter-sale.ts; the web re-exports it.) */
export function validLine(l: unknown): boolean {
  if (!l || typeof l !== "object") return false;
  const o = l as Record<string, unknown>;
  return (
    typeof o.productId === "string" &&
    !!o.productId &&
    isNum(o.qty) &&
    isNum(o.unitPrice) &&
    optNum(o.boxes) &&
    optNum(o.pieces) &&
    optNum(o.unitsPerBox)
  );
}

/** A customer is absent or has an id and a name. (Moved from apps/web/lib/counter-sale.ts; the web re-exports it.) */
export function validCustomer(c: unknown): boolean {
  if (c === null || c === undefined) return true;
  if (typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.businessName === "string";
}

// ─── The whitelist rebuild ───────────────────────────────────────────────────────────────────────────────────────────

export type ParkedPayloadRefusal = "INVALID" | "TOO_MANY_LINES";

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/**
 * Caps a string at `max` UTF-16 code units and removes every UNPAIRED surrogate (a lone half of an emoji, whether it was
 * sent that way or left by the cut): Postgres jsonb rejects one, which would be a 500 instead of a stored cart.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const capText = (v: string, max: number): string => v.slice(0, max).replace(LONE_SURROGATE, "");
const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" ? capText(v, max) : undefined;
const TIER_KEYS = ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

function rebuildLine(raw: unknown): ParkedCartLine | null {
  if (!validLine(raw) || !isObj(raw)) return null;
  const tempId = str(raw.tempId, 64);
  const name = str(raw.name, COUNTER_PARK_NAME_MAX);
  if (!tempId || name === undefined) return null;
  const line: ParkedCartLine = {
    tempId,
    productId: capText(raw.productId as string, 64),
    name,
    unitPrice: raw.unitPrice as number,
    qty: raw.qty as number,
  };
  if (isNum(raw.unitsPerBox)) line.unitsPerBox = raw.unitsPerBox;
  if (isNum(raw.boxes)) line.boxes = raw.boxes;
  if (isNum(raw.pieces)) line.pieces = raw.pieces;
  const note = str(raw.note, COUNTER_PARK_NOTE_MAX);
  if (note !== undefined) line.note = note;
  if (isNum(raw.listPrice)) line.listPrice = raw.listPrice;
  const unit = str(raw.unit, 40);
  if (unit !== undefined) line.unit = unit;
  if (raw.priceType === "STANDARD" || raw.priceType === "SPECIAL") line.priceType = raw.priceType;
  const category = str(raw.category, 100);
  if (category !== undefined) line.category = category;
  if (isObj(raw.tierPrices)) {
    const tp: NonNullable<ParkedCartLine["tierPrices"]> = {};
    for (const k of TIER_KEYS) {
      const v = raw.tierPrices[k];
      if (isNum(v) || v === null) tp[k] = v;
      else if (typeof v === "string") tp[k] = capText(v, 32);
    }
    line.tierPrices = tp;
  }
  if (typeof raw.priceEdited === "boolean") line.priceEdited = raw.priceEdited;
  if (isNum(raw.tierPrice)) line.tierPrice = raw.tierPrice;
  if (isObj(raw.override)) {
    const mode = raw.override.mode;
    if (
      PARKED_PRICE_EDIT_MODES.includes(mode as ParkedPriceEditMode) &&
      isNum(raw.override.value)
    ) {
      const override: NonNullable<ParkedCartLine["override"]> = {
        mode: mode as ParkedPriceEditMode,
        value: raw.override.value,
      };
      const reason = str(raw.override.reason, COUNTER_PARK_REASON_MAX);
      if (reason !== undefined) override.reason = reason;
      line.override = override;
    }
  }
  return line;
}

function rebuildCustomer(raw: unknown): ParkedCartCustomer | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!validCustomer(raw) || !isObj(raw)) return undefined;
  const c: ParkedCartCustomer = {
    id: capText(raw.id as string, 64),
    businessName: capText(raw.businessName as string, COUNTER_PARK_NAME_MAX),
  };
  if (isNum(raw.pricingTier)) c.pricingTier = raw.pricingTier;
  const fulfillPath = str(raw.fulfillPath, 20);
  if (fulfillPath !== undefined) c.fulfillPath = fulfillPath;
  return c;
}

/**
 * Rebuilds a parked-cart payload from a WHITELIST. Every key not named here is dropped (an email on the customer, a
 * stray field on a line), every string is length-capped, every number must be finite. Returns the clean payload, or the
 * reason it cannot be one: `TOO_MANY_LINES` over {@link COUNTER_PARK_MAX_LINES}, `INVALID` for any other shape error.
 * `allowedMethods` is the payment-method list of the counter sale (the caller owns it). Pure; the caller still bounds
 * the rebuilt JSON by {@link COUNTER_PARK_MAX_BYTES}.
 */
export function sanitizeParkedPayload(
  raw: unknown,
  allowedMethods: readonly string[],
): { ok: true; value: ParkedCartPayload } | { ok: false; reason: ParkedPayloadRefusal } {
  if (!isObj(raw) || !Array.isArray(raw.lines)) return { ok: false, reason: "INVALID" };
  if (raw.lines.length > COUNTER_PARK_MAX_LINES) return { ok: false, reason: "TOO_MANY_LINES" };
  const lines: ParkedCartLine[] = [];
  for (const l of raw.lines) {
    const line = rebuildLine(l);
    if (!line) return { ok: false, reason: "INVALID" };
    lines.push(line);
  }
  const customer = rebuildCustomer(raw.customer);
  if (customer === undefined) return { ok: false, reason: "INVALID" };
  const method = typeof raw.method === "string" ? raw.method : "";
  if (!allowedMethods.includes(method)) {
    return { ok: false, reason: "INVALID" };
  }
  const tendered = str(raw.tendered, 20) ?? "";
  const reference = str(raw.reference, 100) ?? "";
  return { ok: true, value: { lines, customer, method, tendered, reference } };
}

// ─── Requests and responses ──────────────────────────────────────────────────────────────────────────────────────────

/** POST /orders/counter-sale/parked */
export interface ParkCartRequest {
  /** minted by the client (a UUID): a replay of the same park returns the stored row instead of a second one */
  id: string;
  registerKey?: string;
  /** at most {@link COUNTER_PARK_LABEL_MAX}; the server defaults it ("Walk-in · HH:MM" or the customer's name) */
  label?: string;
  payload: ParkedCartPayload;
}

/** One parked cart in the list (and the answer to a park). */
export interface ParkedCartListItem {
  id: string;
  label: string;
  registerKey: string;
  createdAt: string;
  expiresAt: string;
  lineCount: number;
  customerName?: string;
}

export interface ParkCartResponse extends ParkedCartListItem {
  /** true when this answer is the stored row of an earlier park with the same id */
  replayed?: boolean;
}

export interface ParkedCartListResponse {
  data: ParkedCartListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * POST /orders/counter-sale/parked/:id/resume. `resumeAttemptId` is a uuid v4 the client mints per resume TAP and reuses only
 * for a retry of that same tap whose answer was lost (see {@link COUNTER_PARK_RETRY_WINDOW_MS}).
 */
export interface ResumeParkedCartRequest {
  resumeAttemptId: string;
}

/** The answer to a resume. `payload` never carries the server-reserved {@link PARKED_PAYLOAD_RESUME_KEY}. */
export interface ResumeParkedCartResponse {
  id: string;
  label: string;
  createdAt: string;
  payload: ParkedCartPayload;
}
