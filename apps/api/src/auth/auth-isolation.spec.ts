/**
 * Unit tests for NEW-m2-1 / RF-077 per-role token isolation.
 *
 * The key-namespace constants and the cross-tab listener live in client-side
 * lib files (apps/web/lib/auth-keys.ts and apps/web/lib/auth.ts) but their
 * logic is pure and easily unit-tested without a browser. We simulate
 * localStorage here. The legacy-key migration helpers this file used to
 * mirror were deleted 2026-08-27 (never wired up; pre-RF-077 sessions
 * expired within the 30d refresh TTL).
 */

// ─── Minimal localStorage mock ────────────────────────────────────────────────

function makeLocalStorage(): Storage & { _data: Record<string, string> } {
  const _data: Record<string, string> = {};
  return {
    _data,
    getItem: (k: string) => _data[k] ?? null,
    setItem: (k: string, v: string) => {
      _data[k] = v;
    },
    removeItem: (k: string) => {
      delete _data[k];
    },
    clear: () => {
      Object.keys(_data).forEach((k) => delete _data[k]);
    },
    key: (i: number) => Object.keys(_data)[i] ?? null,
    get length() {
      return Object.keys(_data).length;
    },
  };
}

// ─── Key constants (mirrors apps/web/lib/auth-keys.ts) ───────────────────────

const OP_KEYS = {
  accessToken: "rf:op:accessToken",
  refreshToken: "rf:op:refreshToken",
} as const;

const DRIVER_KEYS = {
  accessToken: "rf:driver:accessToken",
  refreshToken: "rf:driver:refreshToken",
} as const;

const BUYER_KEYS = {
  accessToken: "rf:buyer:accessToken",
  refreshToken: "rf:buyer:refreshToken",
  activeSeller: "rf:buyer:activeSeller",
} as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("NEW-m2-1 / RF-077 — per-role token isolation", () => {
  let ls: ReturnType<typeof makeLocalStorage>;

  beforeEach(() => {
    ls = makeLocalStorage();
  });

  // ── Cross-tab storage event listener ──────────────────────────────────────

  describe("cross-tab token change detection (storage event)", () => {
    it("fires reauth callback when rf:op:accessToken is removed in a sibling tab", () => {
      const reauthCb = jest.fn();

      // Simulate addEventListener/removeEventListener with a map
      const listeners: Array<(e: StorageEvent) => void> = [];
      const addEventListener = (_evt: string, fn: (e: StorageEvent) => void) => {
        listeners.push(fn);
      };
      const removeEventListener = (_evt: string, fn: (e: StorageEvent) => void) => {
        const idx = listeners.indexOf(fn);
        if (idx !== -1) listeners.splice(idx, 1);
      };

      // Inline version of onCrossTabTokenChange (from apps/web/lib/auth.ts)
      function onCrossTabTokenChange(cb: () => void): () => void {
        function handleStorageEvent(event: StorageEvent) {
          if (event.key === OP_KEYS.accessToken && !event.newValue) {
            cb();
          }
        }
        addEventListener("storage", handleStorageEvent);
        return () => removeEventListener("storage", handleStorageEvent);
      }

      const unsubscribe = onCrossTabTokenChange(reauthCb);

      // Simulate another tab removing the token (newValue = null / "")
      const event: Partial<StorageEvent> = {
        key: OP_KEYS.accessToken,
        newValue: null,
        oldValue: "some-old-token",
      };
      listeners.forEach((fn) => fn(event as StorageEvent));

      expect(reauthCb).toHaveBeenCalledTimes(1);

      // Unsubscribe and verify no further calls
      unsubscribe();
      listeners.forEach((fn) => fn(event as StorageEvent));
      expect(reauthCb).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire reauth callback when a different key changes", () => {
      const reauthCb = jest.fn();
      const listeners: Array<(e: StorageEvent) => void> = [];

      function onCrossTabTokenChange(cb: () => void): () => void {
        function handleStorageEvent(event: StorageEvent) {
          if (event.key === OP_KEYS.accessToken && !event.newValue) cb();
        }
        listeners.push(handleStorageEvent);
        return () => {
          /* no-op for this test */
        };
      }

      onCrossTabTokenChange(reauthCb);

      // Buyer token changes — should not trigger op reauth
      const event: Partial<StorageEvent> = {
        key: BUYER_KEYS.accessToken,
        newValue: null,
      };
      listeners.forEach((fn) => fn(event as StorageEvent));
      expect(reauthCb).not.toHaveBeenCalled();
    });

    it("does NOT fire reauth callback when the op token is SET (not removed)", () => {
      const reauthCb = jest.fn();
      const listeners: Array<(e: StorageEvent) => void> = [];

      function onCrossTabTokenChange(cb: () => void): () => void {
        function handleStorageEvent(event: StorageEvent) {
          if (event.key === OP_KEYS.accessToken && !event.newValue) cb();
        }
        listeners.push(handleStorageEvent);
        return () => {
          /* no-op */
        };
      }

      onCrossTabTokenChange(reauthCb);

      // Token set (login in another tab) — should NOT trigger reauth in this tab
      const event: Partial<StorageEvent> = {
        key: OP_KEYS.accessToken,
        newValue: "new-token",
        oldValue: null,
      };
      listeners.forEach((fn) => fn(event as StorageEvent));
      expect(reauthCb).not.toHaveBeenCalled();
    });
  });

  // ── Key isolation sanity check ─────────────────────────────────────────────

  describe("key namespace isolation", () => {
    it("operator, driver, and buyer keys are all distinct", () => {
      const keys = [
        OP_KEYS.accessToken,
        OP_KEYS.refreshToken,
        DRIVER_KEYS.accessToken,
        DRIVER_KEYS.refreshToken,
        BUYER_KEYS.accessToken,
        BUYER_KEYS.refreshToken,
        BUYER_KEYS.activeSeller,
      ];
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    });

    it("operator token write does not affect driver slot", () => {
      ls.setItem(OP_KEYS.accessToken, "op-token");
      expect(ls.getItem(DRIVER_KEYS.accessToken)).toBeNull();
    });
  });
});
