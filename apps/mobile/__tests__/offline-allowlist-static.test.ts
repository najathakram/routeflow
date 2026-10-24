import * as fs from "fs";
import * as path from "path";
import { OFFLINE_SAFE_ENDPOINTS, isOfflineSafe } from "../lib/offline-allowlist";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scanMutationCallSites } = require("./_mutation-scan.cjs") as {
  scanMutationCallSites: () => Map<string, string[]>;
};

/**
 * B923 static guard. The offline queue admits ONLY the allow-list in lib/offline-allowlist.ts, so a NEW
 * mutating call site must make a conscious choice:
 *   - queue it offline  -> add an allow-list entry (with a reason and a replay-safety story), or
 *   - keep it online-only -> add it to __tests__/offline-online-only-inventory.json.
 * Until it does, this test fails and names the call site. (Scope: literal `apiClient.post|patch|put|delete(
 * "<path>")` calls; `:p` stands for a `${...}` segment.)
 */
const INVENTORY: string[] = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "offline-online-only-inventory.json"), "utf8"),
);
const sites = scanMutationCallSites();
const split = (key: string) => {
  const i = key.indexOf(" ");
  return { method: key.slice(0, i), path: key.slice(i + 1).replace(/:p/g, "x1") };
};

describe("offline allow-list static guard (B923)", () => {
  it("the scanner sees a non-trivial number of call sites (an empty scan must not report green)", () => {
    expect(sites.size).toBeGreaterThan(100);
  });

  it("every mutating call site is classified: allow-listed OR in the online-only inventory", () => {
    const unclassified: string[] = [];
    for (const [key, files] of sites) {
      const { method, path: p } = split(key);
      if (!isOfflineSafe(method, p) && !INVENTORY.includes(key)) {
        unclassified.push(`${key}  (${files[0]})`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("the online-only inventory has no stale or contradictory entries", () => {
    const stale = INVENTORY.filter((k) => !sites.has(k));
    expect(stale).toEqual([]);
    const contradictory = INVENTORY.filter((k) => {
      const { method, path: p } = split(k);
      return isOfflineSafe(method, p);
    });
    expect(contradictory).toEqual([]);
    expect([...INVENTORY].sort()).toEqual(INVENTORY);
  });

  it("every allow-list entry still matches at least one real call site (no dead entry)", () => {
    for (const e of OFFLINE_SAFE_ENDPOINTS) {
      const matched = [...sites.keys()].filter((k) => {
        const { method, path: p } = split(k);
        return method === e.method && e.pattern.test(p);
      });
      expect({ entry: e.pattern.source, matched: matched.length > 0 }).toEqual({
        entry: e.pattern.source,
        matched: true,
      });
    }
  });
  // B1b: the Idempotency-Key claim is enforced at RUNTIME by isOfflineQueueable (api-client-offline-allowlist.test.ts),
  // not by grepping call-site text, which a comment or an unrelated hook in the same file could satisfy.
});
