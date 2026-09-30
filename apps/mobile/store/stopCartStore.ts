import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { userScopedStorage } from "../lib/user-scoped-storage";
import type { OrderDraftPayload } from "../lib/drafts-payload";

export interface StopCartEntry {
  payload: OrderDraftPayload;
}

interface StopCartState {
  carts: Record<string, StopCartEntry>;
  setSnapshot: (stopId: string, payload: OrderDraftPayload) => void;
  clear: (stopId: string) => void;
  // Driver-durability lane (RULINGS.md R1): sign-out (lib/session-teardown.ts)
  // resets this store so a kill-then-logout-then-login-as-someone-else can
  // never surface the prior driver's in-progress at-door cart.
  reset: () => void;
}

/**
 * At-door order-builder scratchpad, keyed by RouteRunStop id. A route/stop
 * order (`NewOrderScreen` given `runId`/`stopId`) never enables the server
 * autosave engine (`enabled: !runId && !stopId && !hydrating`), so an app
 * kill mid-sale used to lose the entire in-progress cart with no recovery
 * path — the run/stop itself does NOT hold the cart, unlike what an older
 * comment on that screen claimed.
 *
 * Built to the exact `store/podStore.ts` recipe: persisted (zustand persist,
 * the same `userScopedStorage` the POD/settlement stores already use) under
 * a key scoped to the signed-in user, `skipHydration: true` (the user id
 * behind the key is only resolvable asynchronously — see
 * `lib/user-scoped-storage.ts`), and rehydrated explicitly by
 * `lib/session-hydrate.ts#rehydrateUserScopedStores` once the signed-in user
 * is known.
 *
 * The value carried is exactly `OrderDraftPayload` (`lib/drafts-payload.ts`)
 * — the same shape the server-backed draft (`SaleDraft.payload`) already
 * serializes to/from via `toOrderDraftPayload`/`fromOrderDraftPayload` — so a
 * future screen wiring can seed/snapshot through that existing round trip
 * without inventing a second payload shape.
 *
 * Wired into `NewOrderScreen.tsx`: seeded from `carts[stopId]` in the
 * `draftSeedRef` lazy-init when no server draft exists (~line 580), written
 * via `setSnapshot` on the 900ms debounced-snapshot effect alongside the
 * server autosave (~line 1766), and cleared via `clearStopCartSnapshot`
 * (~line 1772), called on submit success and on the queued-offline path
 * (~lines 1991 and 2020).
 */
export const STOP_CART_STORE_NAME = "routeflow-stop-cart-store";

export const useStopCartStore = create<StopCartState>()(
  persist(
    (set) => ({
      carts: {},
      // `StopCartEntry` deliberately carries only `payload` — no `updatedAt`.
      // The resume pass re-derives every seeded line from the LIVE product
      // (see the header comment above), so a write-only timestamp has no
      // reader and no money role; dropped rather than kept unused.
      setSnapshot: (stopId, payload) =>
        set((s) => ({
          carts: { ...s.carts, [stopId]: { payload } },
        })),
      clear: (stopId) =>
        set((s) => {
          const next = { ...s.carts };
          delete next[stopId];
          return { carts: next };
        }),
      reset: () => set({ carts: {} }),
    }),
    {
      name: STOP_CART_STORE_NAME,
      storage: createJSONStorage(() => userScopedStorage),
      skipHydration: true,
      partialize: (state) => ({ carts: state.carts }),
    },
  ),
);
