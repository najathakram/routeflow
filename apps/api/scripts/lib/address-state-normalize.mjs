/**
 * Pure decision layer behind `apps/api/scripts/normalize-address-states.mjs` — no database, no
 * `process` access, no printing. The ONE outbound effect in this file is the opt-in Google
 * Address Validation call, and even that goes through an injected `fetchImpl` (defaulting to the
 * global `fetch`) so every branch is unit-tested from
 * `apps/api/src/common/normalize-address-states-script.spec.ts` with a fake and never touches the
 * network. The CLI only queries, formats and (in `--live`) executes what these functions decide.
 *
 * WHAT IT DECIDES. For each `CustomerAddress` row whose `stateCode` is NULL, the free-text `state`
 * column is turned into a 2-letter USPS code or the row is LISTED as unresolved — NEVER guessed.
 * The selling-restrictions engine reads ONLY `stateCode`; an unresolved row is INDETERMINATE there,
 * and `stateNeedsReview = true` is the annotation that drives the "State needs review" chip.
 *
 * CLASSIFICATION, in strict precedence (the first rule that resolves wins; nothing is fuzzy):
 *   1. EXACT  — `normalizeUsState(state)` (lib/us-states.mjs, a verbatim mirror of
 *      packages/types/api/us-states.ts): trims, case-folds, a bare code or a full name. This is
 *      exactly what the API's write boundary accepts, so `RESOLVED_LOCAL_EXACT` means "the
 *      engine's own normalizer already agrees".
 *   2. ALIAS  — the text is FOLDED (lowercase, every `.` deleted, every `,` turned into a space,
 *      whitespace collapsed) and looked up as: a USPS code, a full state name, or one entry of
 *      `STATE_ALIASES` below — the traditional GPO/AP abbreviations, nothing else. So `N.Y.`,
 *      `Calif.`, `Tex`, `U.S. Virgin Islands`, `New  York`, `Texas.` resolve.
 *   3. ALIAS via stripping — ONE trailing zip (`12345` / `12345-6789`) and/or ONE trailing country
 *      token (`USA`, `US`, `United States`, `United States of America`) may be removed, but only
 *      when something remains and that remainder is then a state by rule 2 (`TX 77001`,
 *      `Texas, USA`). `Houston TX 77001`, `Springfield IL`, `Washington DC` stay unresolved.
 *   4. otherwise UNRESOLVED — `EMPTY` (blank / whitespace / NULL) or `UNPARSEABLE` (text that is
 *      not a state: `Tejas`, `Texs`, `N/A`, a city name...). No edit distance, no city or zip
 *      inference, no soundex — a near-miss is a decision for the owner, not for this script.
 *   5. GOOGLE — opt-in (`google` option), for `UNPARSEABLE` rows only (`GOOGLE_ELIGIBLE_LOCAL_REASONS`)
 *      that carry enough address to send (`googleSendable`, computed in SQL). Accepted ONLY when
 *      `result.verdict.addressComplete === true` AND `result.address.postalAddress.administrativeArea`
 *      maps through `normalizeUsState` (and, when present, `regionCode` is "US"). Everything else is
 *      unresolved, and a transport failure never throws out of the run.
 *
 * REASON CODES (`UNRESOLVED:<reason>`): EMPTY, UNPARSEABLE, NEEDS_GOOGLE (would need Google and
 * `--google` was not given), GOOGLE_NO_MATCH, GOOGLE_INCOMPLETE, GOOGLE_ERROR (HTTP / timeout /
 * network / unreadable body — kept apart from NO_MATCH so a transient failure is not read as
 * "Google has no data"), NULL_TENANT (never written, never sent anywhere).
 *
 * The ONE import besides the state mirror is the test-tenant policy (`scripts/lib/test-tenants.cjs`),
 * used by `assertTestTenantTargets` — the guard behind the CLI's `--only-test-tenants`.
 */
import {
  isTestTenant,
  TEST_TENANT_PATTERN,
  TEST_TENANT_SLUGS,
} from "../../../../scripts/lib/test-tenants.cjs";
import { US_STATES, normalizeUsState } from "./us-states.mjs";

/** The only table this tool may ever write. `buildUpdates` interpolates nothing from a row. */
export const TABLE = "CustomerAddress";

export const VERDICT_RESOLVED_LOCAL_EXACT = "RESOLVED_LOCAL_EXACT";
export const VERDICT_RESOLVED_LOCAL_ALIAS = "RESOLVED_LOCAL_ALIAS";
export const VERDICT_RESOLVED_GOOGLE = "RESOLVED_GOOGLE";
export const UNRESOLVED_PREFIX = "UNRESOLVED:";

export const RESOLVED_VERDICTS = new Set([
  VERDICT_RESOLVED_LOCAL_EXACT,
  VERDICT_RESOLVED_LOCAL_ALIAS,
  VERDICT_RESOLVED_GOOGLE,
]);

export const REASON_EMPTY = "EMPTY";
export const REASON_UNPARSEABLE = "UNPARSEABLE";
export const REASON_NEEDS_GOOGLE = "NEEDS_GOOGLE";
export const REASON_GOOGLE_NO_MATCH = "GOOGLE_NO_MATCH";
export const REASON_GOOGLE_INCOMPLETE = "GOOGLE_INCOMPLETE";
export const REASON_GOOGLE_ERROR = "GOOGLE_ERROR";
export const REASON_NULL_TENANT = "NULL_TENANT";

export const REASONS = [
  REASON_EMPTY,
  REASON_UNPARSEABLE,
  REASON_NEEDS_GOOGLE,
  REASON_GOOGLE_NO_MATCH,
  REASON_GOOGLE_INCOMPLETE,
  REASON_GOOGLE_ERROR,
  REASON_NULL_TENANT,
];

/** Local failure reasons whose rows may be sent to Google. `EMPTY` is deliberately NOT here: a
 *  blank state has no text to normalize, so any answer would be Google INFERRING a value nobody
 *  recorded — the owner's "never guessed" ruling. Widening this set is a one-line, reviewable
 *  decision; it is not made silently. */
export const GOOGLE_ELIGIBLE_LOCAL_REASONS = new Set([REASON_UNPARSEABLE]);

// ─── the alias table ──────────────────────────────────────────────────────────────────────────

/**
 * The traditional GPO/AP abbreviations, FOLDED (lowercase, no periods), and nothing else — this is
 * the whole of rule 2's abbreviation list. Deliberately absent: spaced forms ("N. Y.", "W. Va."),
 * any city, any zip, any misspelling. `Wash`, `Ind`, `Miss`, `Mass`, `Mich` are the documented
 * standard abbreviations of Washington, Indiana, Mississippi, Massachusetts and Michigan.
 * `Penn` / `Penna` are the two common Pennsylvania forms. A 2-letter entry that is also a USPS code
 * (`ny`, `pa`, ...) is reachable only through punctuation ("N.Y.", "Pa.") — the bare code is rule 1.
 * Kept as pairs so the spec can pin every entry and check each target is a real code.
 */
export const STATE_ALIASES = [
  ["ala", "AL"],
  ["ariz", "AZ"],
  ["ark", "AR"],
  ["calif", "CA"],
  ["colo", "CO"],
  ["conn", "CT"],
  ["del", "DE"],
  ["fla", "FL"],
  ["ga", "GA"],
  ["ill", "IL"],
  ["ind", "IN"],
  ["kan", "KS"],
  ["ky", "KY"],
  ["la", "LA"],
  ["mass", "MA"],
  ["md", "MD"],
  ["mich", "MI"],
  ["minn", "MN"],
  ["miss", "MS"],
  ["mo", "MO"],
  ["mont", "MT"],
  ["neb", "NE"],
  ["nev", "NV"],
  ["nh", "NH"],
  ["nj", "NJ"],
  ["nm", "NM"],
  ["ny", "NY"],
  ["nc", "NC"],
  ["nd", "ND"],
  ["okla", "OK"],
  ["ore", "OR"],
  ["pa", "PA"],
  ["penn", "PA"],
  ["penna", "PA"],
  ["ri", "RI"],
  ["sc", "SC"],
  ["sd", "SD"],
  ["tenn", "TN"],
  ["tex", "TX"],
  ["vt", "VT"],
  ["va", "VA"],
  ["wash", "WA"],
  ["wva", "WV"],
  ["wis", "WI"],
  ["wyo", "WY"],
  ["dc", "DC"],
];

// Map, never a plain object: a state value of `constructor` / `__proto__` / `toString` must miss.
const ALIAS_MAP = new Map(STATE_ALIASES);
const CODE_SET = new Set(US_STATES.map((s) => s.code));

/** Lowercase, `.` deleted (so `N.Y.` -> `ny`), `,` -> space (so `Texas,USA` -> `texas usa`),
 *  whitespace collapsed. No Unicode normalisation: a full-width `ＴＸ` stays unresolved. */
export function foldState(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FOLDED_NAME_MAP = new Map(US_STATES.map((s) => [foldState(s.name), s.code]));

/** A folded string -> `{ code, rule }` when it is a USPS code, a full state name or an alias. */
function lookupFolded(folded) {
  const upper = folded.toUpperCase();
  if (upper.length === 2 && CODE_SET.has(upper)) return { code: upper, rule: "folded-code" };
  const byName = FOLDED_NAME_MAP.get(folded);
  if (byName) return { code: byName, rule: "folded-name" };
  const byAlias = ALIAS_MAP.get(folded);
  if (byAlias) return { code: byAlias, rule: "alias" };
  return null;
}

const ZIP_TOKEN = /^\d{5}(?:-\d{4})?$/;
// Longest first, as folded token lists.
const COUNTRY_PHRASES = [
  ["united", "states", "of", "america"],
  ["united", "states"],
  ["usa"],
  ["us"],
];

/** Removes ONE trailing zip and/or ONE trailing country token (either order) from a FOLDED
 *  string. Returns the remainder, or `null` when nothing was removed or nothing is left. */
export function stripTrailingZipCountry(folded) {
  const tokens = folded === "" ? [] : folded.split(" ");
  let zipDone = false;
  let countryDone = false;
  let removed = false;
  for (let guard = 0; guard < 2 && tokens.length > 0; guard++) {
    const last = tokens[tokens.length - 1];
    if (!zipDone && ZIP_TOKEN.test(last)) {
      tokens.pop();
      zipDone = true;
      removed = true;
      continue;
    }
    const phrase = countryDone
      ? undefined
      : COUNTRY_PHRASES.find(
          (p) =>
            tokens.length >= p.length &&
            p.every((word, i) => tokens[tokens.length - p.length + i] === word),
        );
    if (phrase) {
      tokens.splice(tokens.length - phrase.length, phrase.length);
      countryDone = true;
      removed = true;
      continue;
    }
    break;
  }
  return removed && tokens.length > 0 ? tokens.join(" ") : null;
}

// ─── local classification ─────────────────────────────────────────────────────────────────────

/**
 * One free-text `state` value -> `{ resolved: true, stateCode, verdict, rule }` or
 * `{ resolved: false, reason }`. `rule` is one of exact | folded-code | folded-name | alias |
 * stripped, for the owner's records; the verdict is `RESOLVED_LOCAL_EXACT` only for `exact`.
 *
 * @param {string|null|undefined} raw
 */
export function classifyLocal(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (text.trim() === "") return { resolved: false, reason: REASON_EMPTY };

  const exact = normalizeUsState(text);
  if (exact) {
    return {
      resolved: true,
      stateCode: exact,
      verdict: VERDICT_RESOLVED_LOCAL_EXACT,
      rule: "exact",
    };
  }

  const folded = foldState(text);
  const viaFold = lookupFolded(folded);
  if (viaFold) {
    return {
      resolved: true,
      stateCode: viaFold.code,
      verdict: VERDICT_RESOLVED_LOCAL_ALIAS,
      rule: viaFold.rule,
    };
  }

  const remainder = stripTrailingZipCountry(folded);
  if (remainder !== null) {
    const viaStrip = lookupFolded(remainder);
    if (viaStrip) {
      return {
        resolved: true,
        stateCode: viaStrip.code,
        verdict: VERDICT_RESOLVED_LOCAL_ALIAS,
        rule: "stripped",
      };
    }
  }
  return { resolved: false, reason: REASON_UNPARSEABLE };
}

// ─── output discipline ────────────────────────────────────────────────────────────────────────

/** The longest raw `state` value ever shown, and only for an UNRESOLVED row. */
export const RAW_STATE_DISPLAY_MAX = 40;

/** The raw value as it may be SHOWN: cut to `RAW_STATE_DISPLAY_MAX` code points. Escaping happens
 *  at print time (`jsonToken`); the JSON document is escaped by `JSON.stringify` itself. */
export function displayRawState(raw) {
  const points = [...(typeof raw === "string" ? raw : "")];
  return {
    rawState: points.slice(0, RAW_STATE_DISPLAY_MAX).join(""),
    truncated: points.length > RAW_STATE_DISPLAY_MAX,
  };
}

// JSON.stringify already escapes C0 controls, quotes and backslashes. It leaves C1 controls, the
// line/paragraph separators and the bidi controls literal -- a terminal-spoofing surface for text
// that came out of a database -- so those are escaped here as well. The ranges are written as
// numbers, not as a regexp literal of escape sequences, so no tool chain can decode them into raw
// characters on the way to disk.
const SPOOFABLE_RANGES = [
  [0x7f, 0x9f], // DEL and the C1 controls
  [0x200e, 0x200f], // LRM / RLM
  [0x2028, 0x2029], // line / paragraph separator
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2066, 0x2069], // bidi isolates
];

const isSpoofable = (codePoint) =>
  SPOOFABLE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

/** A JSON-escaped, double-quoted rendering safe to print on a terminal. */
export function jsonToken(value) {
  let out = "";
  for (const ch of JSON.stringify(String(value))) {
    const codePoint = ch.codePointAt(0);
    out += isSpoofable(codePoint) ? `\\u${codePoint.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

/** An identifier rendered without the surrounding quotes (uuids pass through unchanged). */
const idToken = (value) =>
  value === null || value === undefined || value === "" ? "-" : jsonToken(value).slice(1, -1);

// ─── the Google leg (opt-in) ──────────────────────────────────────────────────────────────────

export const GOOGLE_ENDPOINT = "https://addressvalidation.googleapis.com/v1:validateAddress";
export const GOOGLE_DEFAULT_MAX = 200;
export const GOOGLE_HARD_MAX = 2000;
export const GOOGLE_DEFAULT_TIMEOUT_MS = 10_000;

/** Raised BEFORE any request is made when more rows need Google than `--google-max` allows —
 *  the cap is a refusal, never a silent truncation. The CLI maps it to exit 2. */
export class GoogleCapExceededError extends Error {
  constructor(needed, max) {
    super(
      `normalize-address-states: ${needed} address(es) would be sent to Google but --google-max is ` +
        `${max} — nothing was sent and nothing was written. Raise --google-max, or scope the run ` +
        "with --tenant-slug.",
    );
    this.name = "GoogleCapExceededError";
    this.needed = needed;
    this.max = max;
  }
}

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * The ONLY thing ever sent to Google: a US region code and two address lines built from the row's
 * line1, city, free-text state and zip. Never line2, a name, an id, coordinates or a tenant.
 */
export function buildGoogleRequestBody(row) {
  const tail = [trimmed(row?.state), trimmed(row?.zip)].filter(Boolean).join(" ");
  const line2 = [trimmed(row?.city), tail].filter(Boolean).join(", ");
  return { address: { regionCode: "US", addressLines: [trimmed(row?.line1), line2] } };
}

/** A Google response body -> `{ stateCode }` or `{ reason }`. Strict: see the header. */
export function interpretGoogleResponse(json) {
  const result = json && typeof json === "object" ? json.result : null;
  if (!result || typeof result !== "object") return { reason: REASON_GOOGLE_NO_MATCH };
  if (result.verdict?.addressComplete !== true) return { reason: REASON_GOOGLE_INCOMPLETE };
  const postal = result.address?.postalAddress;
  const region = postal?.regionCode;
  // A non-US answer (e.g. an Australian `WA`) must never be read as Washington — and a response
  // that simply OMITS the country is not evidence it was US, so anything but an explicit "US" is
  // refused (listed, never guessed).
  if (region !== "US") {
    return { reason: REASON_GOOGLE_NO_MATCH };
  }
  const area = postal?.administrativeArea;
  const stateCode = typeof area === "string" ? normalizeUsState(area) : null;
  return stateCode ? { stateCode } : { reason: REASON_GOOGLE_NO_MATCH };
}

const failure = (error) => ({ reason: REASON_GOOGLE_ERROR, error });
const errorKind = (e) =>
  e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "network";

/**
 * One validateAddress call. NEVER throws and never echoes an error message, a URL or the key: a
 * failure comes back as `{ reason: GOOGLE_ERROR, error: "http-500" | "timeout" | "network" |
 * "invalid-response" }` — a short code with nothing from the wire in it.
 */
export async function validateWithGoogle(
  row,
  { apiKey, fetchImpl = globalThis.fetch, timeoutMs = GOOGLE_DEFAULT_TIMEOUT_MS },
) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
    }, timeoutMs);
  });
  try {
    // The key travels in a HEADER, never the URL (L-188: a bearer-shaped secret in a query string
    // lands in proxy/access logs and error messages).
    const url = GOOGLE_ENDPOINT;
    let res;
    try {
      res = await Promise.race([
        fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
          body: JSON.stringify(buildGoogleRequestBody(row)),
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (e) {
      return failure(errorKind(e));
    }
    const status = typeof res?.status === "number" ? res.status : NaN;
    if (!(status >= 200 && status < 300)) {
      return failure(Number.isFinite(status) ? `http-${status}` : "invalid-response");
    }
    let json;
    try {
      json = await Promise.race([res.json(), deadline]);
    } catch (e) {
      return failure(e?.name === "TimeoutError" ? "timeout" : "invalid-response");
    }
    return interpretGoogleResponse(json);
  } finally {
    clearTimeout(timer);
  }
}

// ─── batch classification ─────────────────────────────────────────────────────────────────────

function baseReport(row) {
  return {
    table: TABLE,
    id: row.id,
    tenantId: row.tenantId ?? null,
    tenantSlug: row.tenantSlug ?? null,
    verdict: null,
    stateCode: null,
    reason: null,
    localReason: null,
    rule: null,
    alreadyFlagged: row.stateNeedsReview === true,
  };
}

function resolve(report, stateCode, verdict, rule) {
  Object.assign(report, { verdict, stateCode, reason: null, rule });
}

/** Marks a report unresolved. The raw `state` is attached HERE and only here — the single place
 *  output discipline allows it. */
function unresolve(report, row, reason, extra = {}) {
  const { rawState, truncated } = displayRawState(row.state);
  Object.assign(report, {
    verdict: `${UNRESOLVED_PREFIX}${reason}`,
    stateCode: null,
    reason,
    rule: null,
    rawState,
    ...(truncated ? { rawStateTruncated: true } : {}),
    ...extra,
  });
}

/**
 * Classifies every candidate row, in order, and returns `{ reports, google }`.
 *
 * `rows` are the CLI's listing rows: `{ id, tenantId, tenantSlug, state, stateNeedsReview,
 * googleSendable, line1?, city?, zip? }` (the last three only when `google` is on).
 * `google` is `null` (default: rows that would need it become `NEEDS_GOOGLE`, nothing is sent) or
 * `{ apiKey, max, fetchImpl?, timeoutMs?, onStart? }`.
 *
 * A NULL-tenant row is `NULL_TENANT` before anything else, is never sent to Google and is never
 * written. Throws `GoogleCapExceededError` — before the first request — when more rows need Google
 * than `google.max`; every other Google failure is a `GOOGLE_ERROR` row, not a throw.
 */
export async function classifyBatch(rows, { google = null } = {}) {
  const reports = [];
  const pending = [];
  for (const row of rows ?? []) {
    const report = baseReport(row);
    reports.push(report);
    if (!row.tenantId) {
      unresolve(report, row, REASON_NULL_TENANT);
      continue;
    }
    const local = classifyLocal(row.state);
    if (local.resolved) {
      resolve(report, local.stateCode, local.verdict, local.rule);
      continue;
    }
    report.localReason = local.reason;
    if (GOOGLE_ELIGIBLE_LOCAL_REASONS.has(local.reason) && row.googleSendable === true) {
      pending.push({ report, row });
    } else {
      unresolve(report, row, local.reason);
    }
  }

  const stats = {
    enabled: google !== null,
    needed: pending.length,
    attempted: 0,
    resolved: 0,
    errors: {},
  };

  if (!google) {
    for (const { report, row } of pending) unresolve(report, row, REASON_NEEDS_GOOGLE);
    return { reports, google: stats };
  }

  const max = google.max ?? GOOGLE_DEFAULT_MAX;
  if (pending.length > max) throw new GoogleCapExceededError(pending.length, max);
  if (pending.length > 0) google.onStart?.({ needed: pending.length, max });

  // Sequential on purpose: bounded spend, no burst, and a failure never races a success.
  for (const { report, row } of pending) {
    stats.attempted++;
    const outcome = await validateWithGoogle(row, google);
    if (outcome.stateCode) {
      resolve(report, outcome.stateCode, VERDICT_RESOLVED_GOOGLE, "google");
      stats.resolved++;
    } else {
      if (outcome.error) stats.errors[outcome.error] = (stats.errors[outcome.error] ?? 0) + 1;
      unresolve(report, row, outcome.reason, outcome.error ? { googleError: outcome.error } : {});
    }
  }
  return { reports, google: stats };
}

// ─── the listing SQL ──────────────────────────────────────────────────────────────────────────

/**
 * The candidate listing. `line1` / `city` / `zip` are SELECTed ONLY when Google needs them to build
 * a request (`withAddress`); the report path never even loads them, so nothing it prints can carry
 * one — output discipline by the SELECT list. `googleSendable` is computed in SQL from those
 * columns for the same reason. `$1` is the tenant slug when `tenantScoped`.
 */
export function candidateSql({ withAddress = false, tenantScoped = false } = {}) {
  return (
    `SELECT a."id", a."tenantId", t."slug" AS "tenantSlug", a."state", a."stateNeedsReview",` +
    ` (btrim(a."line1") <> '' AND (btrim(a."city") <> '' OR btrim(a."zip") <> '')) AS "googleSendable"` +
    (withAddress ? `, a."line1" AS "line1", a."city" AS "city", a."zip" AS "zip"` : "") +
    ` FROM "${TABLE}" a LEFT JOIN "Tenant" t ON t."id" = a."tenantId"` +
    ` WHERE a."stateCode" IS NULL` +
    (tenantScoped ? ` AND t."slug" = $1` : "") +
    ` ORDER BY a."createdAt", a."id"`
  );
}

// ─── the write list ───────────────────────────────────────────────────────────────────────────

/** Resolved: id-pinned, still-NULL-only. The `AND "stateCode" IS NULL` is what makes a re-run and
 *  a concurrent writer safe: a row normalised under us returns zero rows and aborts the batch. */
export const SET_STATE_SQL =
  `UPDATE "${TABLE}" SET "stateCode" = $1, "stateNeedsReview" = false, "updatedAt" = now()` +
  ` WHERE "id" = $2 AND "stateCode" IS NULL RETURNING "id"`;

/** Unresolved: ONLY the review annotation, never a state code. Re-states both preconditions the
 *  report showed (still NULL, not yet flagged), so a row that changed in between rolls back. */
export const FLAG_REVIEW_SQL =
  `UPDATE "${TABLE}" SET "stateNeedsReview" = true, "updatedAt" = now()` +
  ` WHERE "id" = $1 AND "stateCode" IS NULL AND "stateNeedsReview" = false RETURNING "id"`;

/**
 * The explicit, ordered write list — one guarded UPDATE per row that needs a write, nothing for a
 * row that does not. Report order is preserved. There is deliberately no blanket
 * `WHERE "stateCode" IS NULL` form: every statement pins one id that appeared in the report the
 * owner just read.
 *   - resolved            -> SET_STATE_SQL  [stateCode, id]
 *   - unresolved          -> FLAG_REVIEW_SQL [id] (skipped when the row is already flagged, which
 *                            is what makes a second run a no-op)
 *   - NULL_TENANT         -> never written
 * Throws rather than returning a half-safe list when a report is malformed (wrong table, unknown
 * verdict, a code that is not a US state, a resolved/unresolved mismatch, a duplicate id, or a
 * NULL-tenant row carrying a write).
 *
 * @returns {Array<{ table: string, id: string, tenantId: string, action: "set-state"|"flag-review",
 *                   stateCode: string|null, sql: string, params: string[] }>}
 */
export function buildUpdates(reports) {
  const updates = [];
  const seen = new Set();
  for (const report of reports ?? []) {
    if (!report) continue;
    if (report.table !== TABLE) {
      throw new Error(`address-state-normalize: unknown table "${report.table}" in report`);
    }
    if (typeof report.id !== "string" || report.id === "") {
      throw new Error("address-state-normalize: a report carries no id");
    }
    if (seen.has(report.id)) {
      throw new Error(`address-state-normalize: duplicate report for ${report.id}`);
    }
    seen.add(report.id);

    const resolved = RESOLVED_VERDICTS.has(report.verdict);
    const unresolved =
      typeof report.verdict === "string" &&
      report.verdict.startsWith(UNRESOLVED_PREFIX) &&
      REASONS.includes(report.verdict.slice(UNRESOLVED_PREFIX.length)) &&
      report.reason === report.verdict.slice(UNRESOLVED_PREFIX.length);
    if (!resolved && !unresolved) {
      throw new Error(`address-state-normalize: report ${report.id} carries an unknown verdict`);
    }
    if (unresolved && report.reason === REASON_NULL_TENANT) continue;
    if (!report.tenantId) {
      throw new Error(
        `address-state-normalize: ${report.id} has no tenantId — a NULL-tenant row must never reach the write list`,
      );
    }
    if (resolved) {
      if (!CODE_SET.has(report.stateCode)) {
        throw new Error(
          `address-state-normalize: ${report.id} marked resolved without a valid US state code`,
        );
      }
      updates.push({
        table: TABLE,
        id: report.id,
        tenantId: report.tenantId,
        action: "set-state",
        stateCode: report.stateCode,
        sql: SET_STATE_SQL,
        params: [report.stateCode, report.id],
      });
    } else {
      if (report.stateCode !== null && report.stateCode !== undefined) {
        throw new Error(`address-state-normalize: ${report.id} is unresolved but carries a code`);
      }
      if (report.alreadyFlagged === true) continue;
      updates.push({
        table: TABLE,
        id: report.id,
        tenantId: report.tenantId,
        action: "flag-review",
        stateCode: null,
        sql: FLAG_REVIEW_SQL,
        params: [report.id],
      });
    }
  }
  return updates;
}

// ─── the unattended-write guard behind `--only-test-tenants` ──────────────────────────────────

/**
 * Every row this batch would WRITE must land in an approved test tenant — the gate that makes an
 * unattended `--confirm "<phrase>"` acceptable at all. Same shape and same policy as the backfill
 * tool's guard: `isTestTenant` from `scripts/lib/test-tenants.cjs` is the single source of truth
 * and is never restated or widened here (`testing-co` and `e2eclient` are client tenants).
 * ALL-OR-NOTHING: ONE offender — a non-approved slug, or a tenant id with no slug at all — refuses
 * the WHOLE batch, and the message lists every offending row.
 *
 * @param {Array<{ table: string, id: string, tenantId: string|null }>} rows the write list
 * @param {Map<string, string|null>|Record<string, string|null>} slugById tenant id -> slug
 * @returns {Array<{ table: string, id: string, tenantId: string, slug: string }>} the checked rows
 * @throws {Error} listing every offending row's table, id, tenant id and slug
 */
export function assertTestTenantTargets(rows, slugById) {
  const lookup = (tenantId) => {
    if (!slugById || typeof tenantId !== "string") return null;
    if (typeof slugById.get === "function") return slugById.get(tenantId) ?? null;
    return Object.prototype.hasOwnProperty.call(slugById, tenantId)
      ? (slugById[tenantId] ?? null)
      : null;
  };

  const list = rows ?? [];
  const checked = [];
  const offenders = [];
  for (const row of list) {
    const tenantId = typeof row?.tenantId === "string" ? row.tenantId : null;
    const slug = lookup(tenantId);
    const entry = { table: row?.table ?? "<unknown>", id: row?.id ?? "<unknown>", tenantId, slug };
    if (typeof slug === "string" && isTestTenant(slug)) checked.push(entry);
    else offenders.push(entry);
  }

  if (offenders.length > 0) {
    const lines = offenders.map(
      (o) =>
        `  ${o.table} ${idToken(o.id)} -> tenantId=${idToken(o.tenantId)} ` +
        `tenantSlug=${o.slug === null ? "<unresolvable>" : idToken(o.slug)}`,
    );
    throw new Error(
      `normalize-address-states: --only-test-tenants refuses this batch — ${offenders.length} of ` +
        `${list.length} target row(s) do not resolve to an approved test tenant:\n` +
        `${lines.join("\n")}\n` +
        `  approved: ${[...TEST_TENANT_SLUGS].join(", ")} or a slug matching ` +
        `${TEST_TENANT_PATTERN} (scripts/lib/test-tenants.cjs). NOTHING was written — a ` +
        `client-tenant row keeps the interactive TTY confirmation as its only path.`,
    );
  }
  return checked;
}

// ─── formatting ───────────────────────────────────────────────────────────────────────────────

/**
 * One report line. Ids, tenant ids, the verdict and the proposed code — and, for an UNRESOLVED row
 * ONLY, the raw `state` text, JSON-escaped and cut to 40 code points. It reads no other field of
 * the report, and the report never held an address line, city, zip, coordinate or name.
 */
export function reportLine(report) {
  const unresolved =
    typeof report.verdict === "string" && report.verdict.startsWith(UNRESOLVED_PREFIX);
  return (
    `${TABLE}  id=${idToken(report.id)}  tenantId=${idToken(report.tenantId)}` +
    (report.tenantSlug ? `  tenantSlug=${idToken(report.tenantSlug)}` : "") +
    `  [${report.verdict}]  -> stateCode=${report.stateCode ?? "-"}` +
    (unresolved && typeof report.rawState === "string"
      ? `  state=${jsonToken(report.rawState)}${report.rawStateTruncated ? " (truncated)" : ""}`
      : "") +
    (report.googleError ? `  google=${idToken(report.googleError)}` : "") +
    (unresolved && report.reason !== REASON_NULL_TENANT
      ? report.alreadyFlagged
        ? "  (already flagged for review)"
        : "  (would flag stateNeedsReview)"
      : "") +
    (report.reason === REASON_NULL_TENANT ? "  (never written)" : "")
  );
}

/** Counts for the summary block and the `--json` document. */
export function summarize(reports, updates) {
  const byVerdict = {};
  const byReason = {};
  for (const report of reports) {
    const key = RESOLVED_VERDICTS.has(report.verdict) ? report.verdict : "UNRESOLVED";
    byVerdict[key] = (byVerdict[key] ?? 0) + 1;
    if (report.reason) byReason[report.reason] = (byReason[report.reason] ?? 0) + 1;
  }
  const count = (verdict) => byVerdict[verdict] ?? 0;
  return {
    candidates: reports.length,
    resolvedLocalExact: count(VERDICT_RESOLVED_LOCAL_EXACT),
    resolvedLocalAlias: count(VERDICT_RESOLVED_LOCAL_ALIAS),
    resolvedGoogle: count(VERDICT_RESOLVED_GOOGLE),
    unresolved: count("UNRESOLVED"),
    unresolvedByReason: byReason,
    nullTenant: byReason[REASON_NULL_TENANT] ?? 0,
    alreadyFlagged: reports.filter(
      (r) =>
        r.alreadyFlagged && !RESOLVED_VERDICTS.has(r.verdict) && r.reason !== REASON_NULL_TENANT,
    ).length,
    toWrite: updates.length,
    toSetState: updates.filter((u) => u.action === "set-state").length,
    toFlag: updates.filter((u) => u.action === "flag-review").length,
  };
}
