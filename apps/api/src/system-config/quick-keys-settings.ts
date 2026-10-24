import { COUNTER_DEFAULT_REGISTER } from "@routeflow/pricing";
import type { QuickKeysRegisterSettings, QuickKeysSettings } from "@routeflow/types";

/**
 * Counter-sale QUICK KEYS settings (SA-747): the constants, the stored shape and the tolerant reader.
 *
 * The API never value-imports `@routeflow/types` (L-261: raw TS, no build step), so each runtime constant
 * is its own literal here, pinned set-equal to `packages/types/api/counter-quick-keys.ts` by
 * `quick-keys-parity.spec.ts`. Types come in with `import type` only.
 */
/** One source for the whole counter: re-exported so the quick-keys files keep one import path. */
export { COUNTER_DEFAULT_REGISTER };
export const QUICK_KEYS_DEFAULT_WINDOW_DAYS = 30;
export const QUICK_KEYS_DEFAULT_CAP = 12;
export const QUICK_KEYS_MAX_CAP = 24;
export const QUICK_KEYS_MAX_HIDDEN = 100;
export const QUICK_KEYS_RANK_TAKE = 40;
export const QUICK_KEYS_RANK_TTL_MS = 60 * 60 * 1000;
export const QUICK_KEYS_MAX_WINDOW_DAYS = 365;
export const QUICK_KEY_SELL_LEVEL_VALUES = ["BOX", "UNIT"] as const;

/** The SystemConfig key the whole `quickKeys` value is stored under (one JSON string). */
export const QUICK_KEYS_CONFIG_KEY = "settings.quickKeys";

/** The stored/returned value with its numbers filled in (`registers` only when there are some). */
export interface FilledQuickKeysSettings extends QuickKeysSettings {
  counter: QuickKeysSettings["counter"] & { windowDays: number; cap: number };
}

export function defaultQuickKeys(): FilledQuickKeysSettings {
  return {
    counter: {
      default: { pinned: [], hidden: [] },
      windowDays: QUICK_KEYS_DEFAULT_WINDOW_DAYS,
      cap: QUICK_KEYS_DEFAULT_CAP,
    },
  };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function readRegister(v: unknown): QuickKeysRegisterSettings | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { pinned, hidden } = v as { pinned?: unknown; hidden?: unknown };
  if (!isStringArray(pinned) || !isStringArray(hidden)) return null;
  return { pinned: [...new Set(pinned)], hidden: [...new Set(hidden)] };
}

const inRange = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;

/**
 * Reads the stored JSON string. Never throws: a missing or corrupt value is the defaults (a broken row must
 * not take the counter screen down), and a number out of range falls back on its own.
 */
export function parseQuickKeysSettings(raw: string | null | undefined): FilledQuickKeysSettings {
  if (!raw) return defaultQuickKeys();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return defaultQuickKeys();
  }
  const counter = (json as { counter?: unknown } | null)?.counter;
  if (!counter || typeof counter !== "object" || Array.isArray(counter)) return defaultQuickKeys();
  const c = counter as Record<string, unknown>;
  const def = readRegister(c.default);
  if (!def) return defaultQuickKeys();

  const registers: Record<string, QuickKeysRegisterSettings> = {};
  if (c.registers && typeof c.registers === "object" && !Array.isArray(c.registers)) {
    for (const [key, value] of Object.entries(c.registers)) {
      const reg = readRegister(value);
      if (reg) registers[key] = reg;
    }
  }
  const out = defaultQuickKeys();
  out.counter.default = def;
  if (Object.keys(registers).length > 0) out.counter.registers = registers;
  if (inRange(c.windowDays, QUICK_KEYS_MAX_WINDOW_DAYS)) out.counter.windowDays = c.windowDays;
  if (inRange(c.cap, QUICK_KEYS_MAX_CAP)) out.counter.cap = c.cap;
  return out;
}

export interface ResolvedRegister extends QuickKeysRegisterSettings {
  /** the register the answer is for: an unknown request is answered as (and named) the default */
  register: string;
  windowDays: number;
  cap: number;
}

/** Picks the register a request names; a missing or unknown one is the default register. Own keys only. */
export function resolveRegister(
  settings: FilledQuickKeysSettings,
  requested: string | undefined,
): ResolvedRegister {
  const { counter } = settings;
  const own =
    requested !== undefined &&
    requested !== COUNTER_DEFAULT_REGISTER &&
    counter.registers !== undefined &&
    Object.prototype.hasOwnProperty.call(counter.registers, requested)
      ? counter.registers[requested]
      : undefined;
  const reg = own ?? counter.default;
  return {
    register: own ? (requested as string) : COUNTER_DEFAULT_REGISTER,
    pinned: reg.pinned,
    hidden: reg.hidden,
    windowDays: counter.windowDays,
    cap: counter.cap,
  };
}
