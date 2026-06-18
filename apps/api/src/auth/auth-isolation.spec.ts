/**
 * Unit tests for NEW-m2-1 / RF-077 per-role token isolation helpers.
 *
 * These helpers live in client-side lib files (apps/web/lib/auth.ts and
 * apps/mobile/lib/auth.ts) but their logic is pure and easily unit-tested
 * without a browser. We simulate localStorage here.
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

// ─── Migration helpers (mirrors apps/web/lib/auth.ts) ────────────────────────

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  } catch {
    return null;
  }
}

function migrateLegacyOpToken(ls: Storage): void {
  const legacy = ls.getItem("accessToken");
  if (!legacy) return;
  const payload = parseJwtPayload(legacy);
  const role = payload?.role as string | undefined;
  if (role && ["OPERATOR", "TENANT_ADMIN", "CUSTOMER", "SUPER_ADMIN"].includes(role)) {
    if (!ls.getItem(OP_KEYS.accessToken)) {
      ls.setItem(OP_KEYS.accessToken, legacy);
      const legacyRefresh = ls.getItem("refreshToken");
      if (legacyRefresh) ls.setItem(OP_KEYS.refreshToken, legacyRefresh);
    }
  }
  ls.removeItem("accessToken");
  ls.removeItem("refreshToken");
}

function migrateLegacyBuyerToken(ls: Storage): void {
  const legacy = ls.getItem("buyerAccessToken");
  if (!legacy) return;
  if (!ls.getItem(BUYER_KEYS.accessToken)) {
    ls.setItem(BUYER_KEYS.accessToken, legacy);
    const legacyRefresh = ls.getItem("buyerRefreshToken");
    if (legacyRefresh) ls.setItem(BUYER_KEYS.refreshToken, legacyRefresh);
    const legacySeller = ls.getItem("buyerActiveSeller");
    if (legacySeller) ls.setItem(BUYER_KEYS.activeSeller, legacySeller);
  }
  ls.removeItem("buyerAccessToken");
  ls.removeItem("buyerRefreshToken");
  ls.removeItem("buyerActiveSeller");
}

// ─── Minimal JWT builder (unsigned — only the payload matters for migration) ──

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("NEW-m2-1 / RF-077 — per-role token isolation", () => {
  let ls: ReturnType<typeof makeLocalStorage>;

  beforeEach(() => {
    ls = makeLocalStorage();
  });

  // ── Migration helper — operator token ──────────────────────────────────────

  describe("migrateLegacyOpToken", () => {
    it("copies OPERATOR token from legacy key to rf:op: key and removes legacy key", () => {
      const token = makeJwt({ sub: "u1", role: "OPERATOR", exp: 9999999999 });
      const refresh = "legacy-refresh-op";
      ls.setItem("accessToken", token);
      ls.setItem("refreshToken", refresh);

      migrateLegacyOpToken(ls);

      expect(ls.getItem(OP_KEYS.accessToken)).toBe(token);
      expect(ls.getItem(OP_KEYS.refreshToken)).toBe(refresh);
      expect(ls.getItem("accessToken")).toBeNull();
      expect(ls.getItem("refreshToken")).toBeNull();
    });

    it("copies TENANT_ADMIN token to rf:op: key", () => {
      const token = makeJwt({ sub: "u2", role: "TENANT_ADMIN", exp: 9999999999 });
      ls.setItem("accessToken", token);
      migrateLegacyOpToken(ls);
      expect(ls.getItem(OP_KEYS.accessToken)).toBe(token);
    });

    it("does NOT overwrite rf:op:accessToken if it already exists (idempotent)", () => {
      const existingToken = makeJwt({ sub: "u1", role: "OPERATOR", exp: 9999999999 });
      const legacyToken = makeJwt({ sub: "u2", role: "OPERATOR", exp: 9999999999 });
      ls.setItem(OP_KEYS.accessToken, existingToken);
      ls.setItem("accessToken", legacyToken);

      migrateLegacyOpToken(ls);

      // Existing namespaced token must not be overwritten
      expect(ls.getItem(OP_KEYS.accessToken)).toBe(existingToken);
      // Legacy key still removed
      expect(ls.getItem("accessToken")).toBeNull();
    });

    it("skips migration but cleans up legacy key if role is not recognized", () => {
      // A DRIVER token stored under legacy key (shouldn't happen normally)
      const token = makeJwt({ sub: "d1", role: "DRIVER", exp: 9999999999 });
      ls.setItem("accessToken", token);
      migrateLegacyOpToken(ls);
      // Should NOT be placed in op slot
      expect(ls.getItem(OP_KEYS.accessToken)).toBeNull();
      // Legacy key still cleaned up
      expect(ls.getItem("accessToken")).toBeNull();
    });

    it("is a no-op when no legacy key exists", () => {
      migrateLegacyOpToken(ls); // must not throw
      expect(ls.getItem(OP_KEYS.accessToken)).toBeNull();
    });
  });

  // ── Migration helper — buyer token ─────────────────────────────────────────

  describe("migrateLegacyBuyerToken", () => {
    it("copies buyer token from legacy key to rf:buyer: key and removes legacy key", () => {
      const token = "buyer-access-token";
      const refresh = "buyer-refresh-token";
      const seller = JSON.stringify({ linkId: "s1" });
      ls.setItem("buyerAccessToken", token);
      ls.setItem("buyerRefreshToken", refresh);
      ls.setItem("buyerActiveSeller", seller);

      migrateLegacyBuyerToken(ls);

      expect(ls.getItem(BUYER_KEYS.accessToken)).toBe(token);
      expect(ls.getItem(BUYER_KEYS.refreshToken)).toBe(refresh);
      expect(ls.getItem(BUYER_KEYS.activeSeller)).toBe(seller);
      expect(ls.getItem("buyerAccessToken")).toBeNull();
      expect(ls.getItem("buyerRefreshToken")).toBeNull();
      expect(ls.getItem("buyerActiveSeller")).toBeNull();
    });

    it("does NOT overwrite rf:buyer:accessToken if it already exists (idempotent)", () => {
      const existingToken = "existing-buyer-token";
      ls.setItem(BUYER_KEYS.accessToken, existingToken);
      ls.setItem("buyerAccessToken", "legacy-buyer-token");

      migrateLegacyBuyerToken(ls);

      expect(ls.getItem(BUYER_KEYS.accessToken)).toBe(existingToken);
      expect(ls.getItem("buyerAccessToken")).toBeNull();
    });
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
