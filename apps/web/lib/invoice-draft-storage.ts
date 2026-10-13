/**
 * ROW 447: the new-invoice form survives a refresh. This is the pure storage side: a versioned, size-capped,
 * WHITELISTED snapshot of what the user TYPED, kept in localStorage under a tenant + user key.
 *
 * Rules this module owns:
 * - Inputs only. No subtotal / tax / total is ever written (the sanitizer rebuilds the snapshot from a closed list of
 *   fields, so an extra key on the form or a line is dropped). On restore the page recomputes every total from the
 *   lines through @routeflow/pricing.
 * - Storage is a convenience: EVERY access is in try/catch (private window, blocked, full). Nothing here throws.
 * - A read validates the version, the shape and the age. Anything else is ignored AND cleared. Ids are never trusted:
 *   the page re-checks a restored product / customer against the server before it keeps them.
 */

export const INVOICE_DRAFT_VERSION = 1;
/** A stored draft older than this is dropped (and cleared) on read. */
export const INVOICE_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Debounce for writes from the form. */
export const INVOICE_DRAFT_DEBOUNCE_MS = 500;
/** A snapshot whose JSON is longer than this is not written. */
export const INVOICE_DRAFT_MAX_BYTES = 200_000;
export const INVOICE_DRAFT_MAX_LINES = 200;

const KEY_PREFIX = "rf.invoice-draft.v1";

/** `rf.invoice-draft.v1:<tenant>:<user>`, or null when either part is missing (then nothing is persisted). */
export function invoiceDraftKey(
  tenant: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  const t = typeof tenant === "string" ? tenant.trim() : "";
  const u = typeof userId === "string" ? userId.trim() : "";
  if (!t || !u) return null;
  return `${KEY_PREFIX}:${encodeURIComponent(t)}:${encodeURIComponent(u)}`;
}

// ─── Snapshot shape ───────────────────────────────────────────────────────────

export type DraftBasis = "newSale" | "standalone";

export interface DraftPackBase {
  unit: string;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  sellBy?: "case" | "unit";
  listPrice: number;
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
}

/** One line as the user entered it. `unitPrice` is the price they see / typed, never a line total. */
export interface InvoiceDraftLine {
  productId?: string;
  description: string;
  qty: number;
  unitPrice: number;
  discount: number;
  taxable: boolean;
  priceEdited?: boolean;
  regularPrice?: number;
  isSpecialPrice?: boolean;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  sellBy?: "case" | "unit";
  overrideReason?: string;
  unit?: string;
  unitLabel?: string;
  listPrice?: number;
  priceType?: DraftPackBase["priceType"];
  pricing?: { tierPrice: number; listPrice: number; isSpecialTier: boolean };
  packBase?: DraftPackBase;
  category?: string;
  /** Set by a restore from the live product (cost is never stored in the draft). */
  avgCost?: number;
}

export interface InvoiceDraftSnapshot {
  basis: DraftBasis;
  customer: {
    id: string;
    businessName: string;
    pricingTier?: number;
    defaultPaymentTerms?: string;
  } | null;
  reference: string;
  subject: string;
  /** The Payment Terms dropdown value ("Net 30"). */
  terms: string;
  issueDate: string;
  dueDate: string;
  /** The user typed the due date by hand (it then wins over terms-derived dates). */
  dueDateEdited: boolean;
  /** The Terms & Conditions long text. */
  termsText: string;
  notes: string;
  deliveredNow: boolean;
  deliveredOn: string;
  depositOpen: boolean;
  depositPercent: number | null;
  depositDueDate: string;
  adjustment: number;
  lines: InvoiceDraftLine[];
}

export interface StoredInvoiceDraft {
  /** Epoch ms of the write. */
  savedAt: number;
  snapshot: InvoiceDraftSnapshot;
}

// ─── Sanitizers (closed whitelist) ────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2000): string | undefined =>
  typeof v === "string" ? v.slice(0, max) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e9 ? v : undefined;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateStr = (v: unknown): string | undefined =>
  typeof v === "string" && (v === "" || DATE_RE.test(v)) ? v : undefined;
const PRICE_TYPES = ["STANDARD", "SPECIAL", "DISCOUNTED", "MANUAL"] as const;

function sanitizePackBase(v: unknown): DraftPackBase | undefined {
  if (!isObj(v)) return undefined;
  const unit = str(v.unit, 80);
  const qty = num(v.qty);
  const listPrice = num(v.listPrice);
  const unitPrice = num(v.unitPrice);
  const priceType = PRICE_TYPES.find((p) => p === v.priceType);
  if (unit === undefined || qty === undefined || listPrice === undefined) return undefined;
  if (unitPrice === undefined || !priceType) return undefined;
  const out: DraftPackBase = { unit, qty, listPrice, unitPrice, priceType };
  const upb = num(v.unitsPerBox);
  const boxes = num(v.boxes);
  const pieces = num(v.pieces);
  if (upb !== undefined) out.unitsPerBox = upb;
  if (boxes !== undefined) out.boxes = boxes;
  if (pieces !== undefined) out.pieces = pieces;
  if (v.sellBy === "case" || v.sellBy === "unit") out.sellBy = v.sellBy;
  return out;
}

function sanitizeLine(v: unknown): InvoiceDraftLine | null {
  if (!isObj(v)) return null;
  const qty = num(v.qty);
  const unitPrice = num(v.unitPrice);
  if (qty === undefined || unitPrice === undefined) return null;
  const out: InvoiceDraftLine = {
    description: str(v.description, 500) ?? "",
    qty,
    unitPrice,
    discount: num(v.discount) ?? 0,
    taxable: v.taxable === true,
  };
  const productId = str(v.productId, 100);
  if (productId) out.productId = productId;
  if (v.priceEdited === true) out.priceEdited = true;
  if (v.isSpecialPrice === true) out.isSpecialPrice = true;
  for (const k of ["regularPrice", "unitsPerBox", "boxes", "pieces", "listPrice"] as const) {
    const n = num(v[k]);
    if (n !== undefined) out[k] = n;
  }
  for (const k of ["overrideReason", "unit", "unitLabel", "category"] as const) {
    const s = str(v[k], 500);
    if (s) out[k] = s;
  }
  if (v.sellBy === "case" || v.sellBy === "unit") out.sellBy = v.sellBy;
  const priceType = PRICE_TYPES.find((p) => p === v.priceType);
  if (priceType) out.priceType = priceType;
  if (isObj(v.pricing)) {
    const tierPrice = num(v.pricing.tierPrice);
    const listPrice = num(v.pricing.listPrice);
    if (tierPrice !== undefined && listPrice !== undefined) {
      out.pricing = { tierPrice, listPrice, isSpecialTier: v.pricing.isSpecialTier === true };
    }
  }
  const packBase = sanitizePackBase(v.packBase);
  if (packBase) out.packBase = packBase;
  return out;
}

/** Rebuild a snapshot from untrusted input through the closed whitelist, or null when its shape is wrong. */
export function sanitizeSnapshot(raw: unknown): InvoiceDraftSnapshot | null {
  if (!isObj(raw)) return null;
  if (raw.basis !== "newSale" && raw.basis !== "standalone") return null;
  if (!Array.isArray(raw.lines) || raw.lines.length > INVOICE_DRAFT_MAX_LINES) return null;
  const lines: InvoiceDraftLine[] = [];
  for (const l of raw.lines) {
    const s = sanitizeLine(l);
    if (!s) return null;
    lines.push(s);
  }
  let customer: InvoiceDraftSnapshot["customer"] = null;
  if (raw.customer !== null && raw.customer !== undefined) {
    if (!isObj(raw.customer)) return null;
    const id = str(raw.customer.id, 100);
    if (!id) return null;
    customer = { id, businessName: str(raw.customer.businessName, 200) ?? "" };
    const tier = num(raw.customer.pricingTier);
    if (tier !== undefined) customer.pricingTier = tier;
    const dpt = str(raw.customer.defaultPaymentTerms, 100);
    if (dpt) customer.defaultPaymentTerms = dpt;
  }
  const percent = raw.depositPercent === null ? null : (num(raw.depositPercent) ?? null);
  return {
    basis: raw.basis,
    customer,
    reference: str(raw.reference, 200) ?? "",
    subject: str(raw.subject, 500) ?? "",
    terms: str(raw.terms, 100) ?? "",
    issueDate: dateStr(raw.issueDate) ?? "",
    dueDate: dateStr(raw.dueDate) ?? "",
    dueDateEdited: raw.dueDateEdited === true,
    termsText: str(raw.termsText, 5000) ?? "",
    notes: str(raw.notes, 5000) ?? "",
    deliveredNow: raw.deliveredNow !== false,
    deliveredOn: dateStr(raw.deliveredOn) ?? "",
    depositOpen: raw.depositOpen === true,
    depositPercent: percent,
    depositDueDate: dateStr(raw.depositDueDate) ?? "",
    adjustment: num(raw.adjustment) ?? 0,
    lines,
  };
}

/**
 * Nothing worth saving: no customer, no filled-in line, no reference / subject, no adjustment or deposit. Notes and
 * terms text alone do not count: the page pre-fills them from the tenant's invoicing settings on every visit.
 */
export function isPristineSnapshot(s: InvoiceDraftSnapshot): boolean {
  const lineFilled = (l: InvoiceDraftLine) =>
    !!l.productId || l.description.trim() !== "" || l.unitPrice !== 0;
  return (
    s.customer === null &&
    !s.lines.some(lineFilled) &&
    s.reference.trim() === "" &&
    s.subject.trim() === "" &&
    s.adjustment === 0 &&
    !(s.depositOpen && s.depositPercent)
  );
}

/** True when the form (raw, unsanitized) holds nothing worth saving. A shape that cannot be read counts as pristine. */
export function isPristineForm(form: unknown): boolean {
  const snap = sanitizeSnapshot(form);
  return !snap || isPristineSnapshot(snap);
}

// ─── Storage (never throws) ───────────────────────────────────────────────────

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function clearInvoiceDraft(key: string | null): void {
  if (!key) return;
  try {
    store()?.removeItem(key);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

// Set the moment a sign-out starts. A sign-out ends in a page navigation, and navigation fires `pagehide`: the form's
// last-chance flush must not write the draft straight back after the wipe. A sign-in resumes writes; so does a reload
// (module re-init).
let signingOut = false;
export function resumeInvoiceDraftWrites(): void {
  signingOut = false;
}

/** Sign-out: drop every stored draft on this browser, whoever it belonged to, and refuse new ones. Never throws. */
export function clearAllInvoiceDrafts(): void {
  signingOut = true;
  try {
    const s = store();
    if (!s) return;
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k && k.startsWith(`${KEY_PREFIX}:`)) doomed.push(k);
    }
    doomed.forEach((k) => s.removeItem(k));
  } catch {
    /* storage unavailable: nothing was kept */
  }
}

/** Writes the sanitized snapshot. Returns false when nothing was written (no key, pristine, too big, storage broken). */
export function writeInvoiceDraft(
  key: string | null,
  form: unknown,
  now: number = Date.now(),
): boolean {
  if (!key || signingOut) return false;
  try {
    const snapshot = sanitizeSnapshot(form);
    if (!snapshot || isPristineSnapshot(snapshot)) return false;
    const json = JSON.stringify({ v: INVOICE_DRAFT_VERSION, savedAt: now, data: snapshot });
    if (json.length > INVOICE_DRAFT_MAX_BYTES) return false;
    const s = store();
    if (!s) return false;
    s.setItem(key, json);
    return true;
  } catch {
    return false;
  }
}

/** The stored draft, or null. A wrong version / shape / age is cleared, never thrown. */
export function readInvoiceDraft(
  key: string | null,
  now: number = Date.now(),
): StoredInvoiceDraft | null {
  if (!key) return null;
  let raw: string | null = null;
  try {
    raw = store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObj(parsed) && parsed.v === INVOICE_DRAFT_VERSION) {
      const savedAt =
        typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : undefined;
      const snapshot = sanitizeSnapshot(parsed.data);
      const age = savedAt === undefined ? Infinity : now - savedAt;
      // A clock set back (negative age) is not a reason to keep a draft forever.
      if (snapshot && age >= -60_000 && age <= INVOICE_DRAFT_MAX_AGE_MS) {
        if (!isPristineSnapshot(snapshot)) return { savedAt: savedAt as number, snapshot };
      }
    }
  } catch {
    /* corrupt JSON: fall through to clear */
  }
  clearInvoiceDraft(key);
  return null;
}
