import { defineAdapter, type SourceAdapter } from "./adapter-types";
import { SALES_LINES_SAMPLE_ADAPTER } from "./sales-lines-sample";

export { defineAdapter };
export type { SourceAdapter, AdaptInput } from "./adapter-types";

export type ResolveResult = { ok: true; adapter: SourceAdapter } | { ok: false; message: string };

export const UNKNOWN_SHAPE_MESSAGE =
  "This file's columns do not match any supported QuickBooks export layout.";
const AMBIGUOUS_SHAPE_MESSAGE = "This file's columns match more than one supported layout.";

export interface AdapterRegistry {
  readonly adapters: readonly SourceAdapter[];
  resolve(headers: readonly string[]): ResolveResult;
}

/**
 * Fixed adapters keyed to a verified header signature. There is no generic column mapper: an
 * unknown or ambiguous header is refused with one sentence. This is the seam for later shapes.
 */
export function createAdapterRegistry(adapters: readonly SourceAdapter[]): AdapterRegistry {
  const keys = new Set<string>();
  for (const a of adapters) {
    if (keys.has(a.key)) throw new Error(`Duplicate adapter key "${a.key}".`);
    keys.add(a.key);
  }
  return {
    adapters,
    resolve(headers) {
      const hits = adapters.filter((a) => a.matches(headers));
      if (hits.length === 1) return { ok: true, adapter: hits[0] };
      return {
        ok: false,
        message: hits.length === 0 ? UNKNOWN_SHAPE_MESSAGE : AMBIGUOUS_SHAPE_MESSAGE,
      };
    },
  };
}

export const defaultAdapterRegistry: AdapterRegistry = createAdapterRegistry([
  SALES_LINES_SAMPLE_ADAPTER,
]);
