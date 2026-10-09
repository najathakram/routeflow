import {
  QUICK_KEYS_DEFAULT_CAP as T_CAP,
  QUICK_KEYS_DEFAULT_WINDOW_DAYS as T_WINDOW,
  QUICK_KEYS_MAX_CAP as T_MAX_CAP,
  QUICK_KEYS_MAX_HIDDEN as T_MAX_HIDDEN,
  QUICK_KEYS_MAX_WINDOW_DAYS as T_MAX_WINDOW,
  QUICK_KEYS_RANK_TAKE as T_TAKE,
  QUICK_KEYS_RANK_TTL_MS as T_TTL,
  QUICK_KEY_SELL_LEVEL_VALUES as T_LEVELS,
} from "@routeflow/types";
import { SELL_LEVEL_VALUES } from "@routeflow/pricing";
import {
  QUICK_KEYS_DEFAULT_CAP,
  QUICK_KEYS_DEFAULT_WINDOW_DAYS,
  QUICK_KEYS_MAX_CAP,
  QUICK_KEYS_MAX_HIDDEN,
  QUICK_KEYS_MAX_WINDOW_DAYS,
  QUICK_KEYS_RANK_TAKE,
  QUICK_KEYS_RANK_TTL_MS,
  QUICK_KEY_SELL_LEVEL_VALUES,
} from "./quick-keys-settings";

/**
 * L-261: the API keeps its own literals for the quick keys constants (it never value-imports
 * `@routeflow/types`); the web reads the shared file. Pinned equal here, once, in the enum-parity style.
 */
describe("quick keys constants: api literals === packages/types/api/counter-quick-keys.ts", () => {
  it("every number and string is equal", () => {
    expect({
      QUICK_KEYS_DEFAULT_CAP,
      QUICK_KEYS_DEFAULT_WINDOW_DAYS,
      QUICK_KEYS_MAX_CAP,
      QUICK_KEYS_MAX_HIDDEN,
      QUICK_KEYS_MAX_WINDOW_DAYS,
      QUICK_KEYS_RANK_TAKE,
      QUICK_KEYS_RANK_TTL_MS,
    }).toEqual({
      QUICK_KEYS_DEFAULT_CAP: T_CAP,
      QUICK_KEYS_DEFAULT_WINDOW_DAYS: T_WINDOW,
      QUICK_KEYS_MAX_CAP: T_MAX_CAP,
      QUICK_KEYS_MAX_HIDDEN: T_MAX_HIDDEN,
      QUICK_KEYS_MAX_WINDOW_DAYS: T_MAX_WINDOW,
      QUICK_KEYS_RANK_TAKE: T_TAKE,
      QUICK_KEYS_RANK_TTL_MS: T_TTL,
    });
  });

  it("the sell levels are set-equal to the shared list and to the pricing SellLevel", () => {
    expect([...QUICK_KEY_SELL_LEVEL_VALUES].sort()).toEqual([...T_LEVELS].sort());
    expect([...QUICK_KEY_SELL_LEVEL_VALUES].sort()).toEqual([...SELL_LEVEL_VALUES].sort());
  });
});
